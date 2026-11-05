"""Probe Linux debug primitives using only a child created by this program.

There is deliberately no --pid, process discovery, WeChat import, key extraction,
network code or arbitrary address input. Run in a fresh, network-none container
without account volumes and as UID 1000. A passing result proves primitives for
this synthetic child only, never WeChat function compatibility or message send.
"""
import ctypes,json,os,signal,sys

SAMPLE=b'GROUPDESK-SYNTHETIC-PROBE-ONLY'
class IOVec(ctypes.Structure):
    _fields_=[('base',ctypes.c_void_p),('length',ctypes.c_size_t)]

def process_status():
    fields={}
    with open('/proc/self/status') as f:
        for line in f:
            key,_,value=line.partition(':')
            if key in ('CapEff','Seccomp','NoNewPrivs'):fields[key]=value.strip()
    return fields

def probe():
    if sys.platform!='linux' or os.getuid()!=1000:
        raise RuntimeError('Use an isolated Linux container as UID 1000')
    if len(sys.argv)!=1:
        raise RuntimeError('This probe accepts no target or address arguments')
    libc=ctypes.CDLL(None,use_errno=True)
    libc.ptrace.argtypes=[ctypes.c_uint,ctypes.c_int,ctypes.c_void_p,ctypes.c_void_p]
    libc.ptrace.restype=ctypes.c_long
    def trace(request,pid=0,address=0,data=0):
        ctypes.set_errno(0);value=libc.ptrace(request,pid,address,data)
        if value==-1 and ctypes.get_errno():raise OSError(ctypes.get_errno(),os.strerror(ctypes.get_errno()))
        return value
    read_fd,write_fd=os.pipe();pid=os.fork()
    if pid==0:
        os.close(read_fd)
        try:
            buffer=ctypes.create_string_buffer(SAMPLE)
            try:trace(0);allowed=True
            except OSError:allowed=False
            os.write(write_fd,(json.dumps({'allowed':allowed,'address':ctypes.addressof(buffer),'size':len(SAMPLE)})+'\n').encode());os.close(write_fd)
            if not allowed:os._exit(2)
            os.kill(os.getpid(),signal.SIGSTOP)
            os._exit(0 if buffer.raw[:len(SAMPLE)]==b'g'+SAMPLE[1:] else 3)
        except BaseException:os._exit(4)
    os.close(write_fd);reaped=False
    result={'contract':1,'target':'own_synthetic_child','status':process_status(),'traceme':False,'ptrace_read':False,'ptrace_write':False,'process_vm_readv':False,'child_verified':False}
    def expired(*_):raise TimeoutError('Synthetic probe timed out')
    signal.signal(signal.SIGALRM,expired);signal.alarm(10)
    try:
        with os.fdopen(read_fd) as stream:child=json.loads(stream.readline())
        result['traceme']=child['allowed']
        if not child['allowed']:return result
        _,state=os.waitpid(pid,os.WUNTRACED)
        if not os.WIFSTOPPED(state):raise RuntimeError('Synthetic child did not stop')
        address=child['address'];word_size=ctypes.sizeof(ctypes.c_long)
        try:
            word=trace(2,pid,address)&((1<<(word_size*8))-1)
            result['ptrace_read']=word.to_bytes(word_size,sys.byteorder)==SAMPLE[:word_size]
        except OSError as exc:result['ptrace_read_errno']=exc.errno
        if hasattr(libc,'process_vm_readv'):
            local=ctypes.create_string_buffer(len(SAMPLE));local_vec=IOVec(ctypes.addressof(local),len(SAMPLE));remote_vec=IOVec(address,len(SAMPLE))
            libc.process_vm_readv.argtypes=[ctypes.c_int,ctypes.POINTER(IOVec),ctypes.c_ulong,ctypes.POINTER(IOVec),ctypes.c_ulong,ctypes.c_ulong];libc.process_vm_readv.restype=ctypes.c_ssize_t
            read=libc.process_vm_readv(pid,ctypes.byref(local_vec),1,ctypes.byref(remote_vec),1,0)
            result['process_vm_readv']=read==len(SAMPLE) and local.raw==SAMPLE
            if read<0:result['process_vm_readv_errno']=ctypes.get_errno()
        try:
            changed=int.from_bytes(b'g'+SAMPLE[1:word_size],sys.byteorder)
            trace(5,pid,address,changed);result['ptrace_write']=True
        except OSError as exc:result['ptrace_write_errno']=exc.errno
        trace(17,pid)  # detach and resume only the child we created
        _,state=os.waitpid(pid,0);reaped=True;result['child_verified']=os.WIFEXITED(state) and os.WEXITSTATUS(state)==0
        return result
    finally:
        signal.alarm(0)
        if not reaped:
            try:os.kill(pid,signal.SIGKILL)
            except ProcessLookupError:pass
            try:os.waitpid(pid,0)
            except ChildProcessError:pass

if __name__=='__main__':
    try:
        result=probe();print(json.dumps(result,sort_keys=True))
        if not all(result.get(k) for k in ('traceme','ptrace_read','ptrace_write','process_vm_readv','child_verified')):raise SystemExit(2)
    except Exception as exc:
        print(json.dumps({'contract':1,'target':'own_synthetic_child','error':type(exc).__name__}));raise SystemExit(1)
