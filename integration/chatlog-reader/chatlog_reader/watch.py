"""Wait for WeChat database writes. Never scan on an idle timer."""
import ctypes
import errno
import os
from pathlib import Path
import re
import selectors
import struct
import threading
import time

RETRY_SECONDS = 2.0
DEBOUNCE_SECONDS = 0.15
EVENT = struct.Struct('=iIII')
IN_MODIFY, IN_ATTRIB, IN_CLOSE_WRITE = 0x2, 0x4, 0x8
IN_MOVED_FROM, IN_MOVED_TO, IN_CREATE, IN_DELETE = 0x40, 0x80, 0x100, 0x200
IN_DELETE_SELF, IN_MOVE_SELF, IN_UNMOUNT = 0x400, 0x800, 0x2000
IN_Q_OVERFLOW, IN_IGNORED = 0x4000, 0x8000
IN_ONLYDIR, IN_DONT_FOLLOW = 0x01000000, 0x02000000
INVALIDATED = IN_DELETE_SELF | IN_MOVE_SELF | IN_UNMOUNT | IN_IGNORED
MASK = (IN_MODIFY | IN_ATTRIB | IN_CLOSE_WRITE | IN_MOVED_FROM | IN_MOVED_TO |
        IN_CREATE | IN_DELETE | INVALIDATED | IN_ONLYDIR | IN_DONT_FOLLOW)
MESSAGE = re.compile(r'message_\d+\.db(?:-wal|-shm)?\Z')


class FileChanges:
    def __init__(self, source, secrets):
        self.paths = {'root': Path(source), 'message': Path(source)/'message',
                      'contact': Path(source)/'contact', 'key': Path(secrets)}
        self.fd = None
        self.watches = {}
        self.lock = threading.Lock()
        self.state = {'mode': 'unavailable', 'periodic_scan_seconds': None,
                      'running': False,
                      'watch_count': 0, 'event_batches': 0, 'syncs': 0,
                      'event_syncs': 0, 'retry_syncs': 0, 'manual_syncs': 0,
                      'last_reason': None, 'backend_error': None}
        self.selector = selectors.DefaultSelector()
        self.read_wake, self.write_wake = os.pipe2(os.O_NONBLOCK | os.O_CLOEXEC)
        self.selector.register(self.read_wake, selectors.EVENT_READ, 'wake')
        try:
            self.lib = ctypes.CDLL(None, use_errno=True)
            self.lib.inotify_init1.argtypes = [ctypes.c_int]
            self.lib.inotify_init1.restype = ctypes.c_int
            self.lib.inotify_add_watch.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_uint32]
            self.lib.inotify_add_watch.restype = ctypes.c_int
            self.lib.inotify_rm_watch.argtypes = [ctypes.c_int, ctypes.c_int]
            self.lib.inotify_rm_watch.restype = ctypes.c_int
            fd = self.lib.inotify_init1(os.O_NONBLOCK | os.O_CLOEXEC)
            if fd < 0:
                raise OSError(ctypes.get_errno(), 'inotify unavailable')
            self.fd = fd
            self.selector.register(fd, selectors.EVENT_READ, 'files')
            self.refresh()
        except (OSError, AttributeError) as exc:
            self._update(backend_error=type(exc).__name__)
            self._disable()

    def _update(self, **values):
        with self.lock:
            self.state.update(values)

    def snapshot(self):
        with self.lock:
            return dict(self.state)

    def _disable(self):
        if self.fd is not None:
            self.selector.unregister(self.fd)
            os.close(self.fd)
            self.fd = None
        self.watches.clear()
        self._update(mode='unavailable', watch_count=0)

    def refresh(self):
        if self.fd is None:
            return
        error = None
        for role, path in self.paths.items():
            previous = next(((wd, item) for wd, item in self.watches.items() if item[0] == role), None)
            try:
                info = path.stat()
                identity = (info.st_dev, info.st_ino)
                if not path.is_dir() or path.is_symlink():
                    raise OSError(errno.ENOTDIR, 'Invalid watch directory')
            except OSError as exc:
                identity = None
                error = type(exc).__name__
            if previous and previous[1][1] == identity:
                continue
            if previous:
                self.lib.inotify_rm_watch(self.fd, previous[0])
                self.watches.pop(previous[0], None)
            if identity is not None:
                wd = self.lib.inotify_add_watch(self.fd, os.fsencode(path), MASK)
                if wd >= 0:
                    self.watches[wd] = (role, identity)
                else:
                    error = 'watch_errno_' + str(ctypes.get_errno())
        self._update(mode='inotify' if self.watches else 'unavailable',
                     watch_count=len(self.watches), backend_error=error)

    def _decode(self, data):
        changed, overflow = False, False
        offset = 0
        while offset < len(data):
            if offset + EVENT.size > len(data):
                raise ValueError('Incomplete kernel notification')
            wd, mask, _cookie, length = EVENT.unpack_from(data, offset)
            offset += EVENT.size
            if length > len(data)-offset:
                raise ValueError('Incomplete kernel filename')
            name = data[offset:offset+length].split(b'\0', 1)[0].decode('utf-8', 'replace')
            offset += length
            if mask & IN_Q_OVERFLOW:
                overflow = changed = True
                continue
            item = self.watches.get(wd)
            if item is None:
                continue
            if mask & INVALIDATED:
                changed = True
                if mask & IN_IGNORED:
                    self.watches.pop(wd, None)
            role = item[0]
            if (role == 'message' and MESSAGE.fullmatch(name) or
                role == 'contact' and name in {'contact.db', 'contact.db-wal', 'contact.db-shm'} or
                role == 'key' and name == 'wechat-key.enc' or
                role == 'root' and name in {'message', 'contact'}):
                changed = True
        return 'overflow' if overflow else 'event' if changed else None

    def drain(self):
        reason = None
        if self.fd is None:
            return reason
        try:
            # Bound work even if a busy client keeps writing continuously.
            for _ in range(16):
                try:
                    data = os.read(self.fd, 65536)
                except BlockingIOError:
                    break
                if not data:
                    raise OSError('Notification stream closed')
                value = self._decode(data)
                if value == 'overflow' or reason is None:
                    reason = value or reason
        except (OSError, ValueError) as exc:
            self._update(backend_error=type(exc).__name__)
            self._disable()
            return 'overflow'
        if reason:
            with self.lock:
                self.state['event_batches'] += 1
        return reason

    def wait(self, timeout=None):
        if self.fd is None:raise OSError('File event listener unavailable')
        deadline = time.monotonic() + timeout if timeout is not None else None
        while True:
            remaining = max(0.0, deadline-time.monotonic()) if deadline is not None else None
            ready = self.selector.select(remaining)
            if not ready:
                return 'retry'
            for key, _mask in ready:
                if key.data == 'wake':
                    try:
                        os.read(self.read_wake, 4096)
                    except BlockingIOError:
                        pass
                    return 'wake'
                reason = self.drain()
                if reason:
                    return reason
            if deadline is not None and time.monotonic() >= deadline:
                return 'retry'

    def recorded(self, reason):
        with self.lock:
            self.state['syncs'] += 1
            self.state['last_reason'] = reason
            counter = ('event_syncs' if reason in {'event', 'overflow'} else
                       'retry_syncs' if reason == 'retry' else
                       'manual_syncs' if reason == 'manual' else None)
            if counter:
                self.state[counter] += 1

    def wake(self):
        try:
            os.write(self.write_wake, b'x')
        except (BlockingIOError, OSError):
            pass

    def close(self):
        self._disable()
        self.selector.close()
        for name in ('read_wake', 'write_wake'):
            fd = getattr(self, name, None)
            if fd is not None:
                os.close(fd)
                setattr(self, name, None)


    def tracking(self):
        state=self.snapshot()
        return state['running'] and state['mode']=='inotify' and state['watch_count']==4 and state['backend_error'] is None


def synchronize(engine, stop, changes):
    reason,failures='startup',0
    changes._update(running=True)
    try:
        while not stop.is_set():
            changes.refresh()
            if reason=='overflow':engine.signatures.clear()
            engine.sync()
            changes.recorded(reason)
            failures=failures+1 if engine.last_error else 0
            if stop.is_set():break
            # Only an already-triggered failed operation gets bounded retries.
            reason=changes.wait(RETRY_SECONDS if 0<failures<5 else None)
            if stop.is_set():break
            if reason=='wake':reason='manual'
            if reason in {'event','overflow'}:
                failures=0
                if stop.wait(DEBOUNCE_SECONDS):break
                if changes.drain()=='overflow':reason='overflow'
    finally:
        changes._update(running=False)
