"""Internal, authenticated read API. No sending, key, file or model endpoints."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import hmac
import json
import re
from pathlib import Path
import signal
import threading
import time
from urllib.parse import parse_qs, urlsplit
from .watch import FileChanges,synchronize

class Handler(BaseHTTPRequestHandler):
    server_version = 'ChatlogReader/1'
    def log_message(self, *_args):
        pass

    def reply(self, status, value):
        data = json.dumps(value,ensure_ascii=False,separators=(',',':')).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        try:
            if len(self.path) > 2048:
                self.reply(400, {'error':'invalid_request'});return
            target = urlsplit(self.path)
            status = self.server.engine.status()
            if target.path == '/healthz':
                self.reply(200 if status['ok'] else 503, {k:status[k] for k in ('ok','source','state')});return
            supplied = self.headers.get('Authorization', '')
            if not hmac.compare_digest(supplied, 'Bearer ' + self.server.token):
                self.reply(401, {'error':'unauthorized'});return
            if target.path == '/v1/status':
                if getattr(self.server,'monitor',None):status['monitor']=self.server.monitor.snapshot()
                self.reply(200 if status['ok'] else 503,status);return
            if target.path == '/v1/reference':
                query=parse_qs(target.query,strict_parsing=True)
                if set(query)!={'chat','server_id'} or any(len(v)!=1 for v in query.values()):raise ValueError('Invalid reference query')
                chat=int(query['chat'][0]);server_id=query['server_id'][0]
                if not re.fullmatch(r'[1-9][0-9]{0,20}',server_id):raise ValueError('Invalid reference ID')
                if chat not in self.server.engine.store.allowed:
                    self.reply(404,{'error':'not_found'});return
                self.reply(200,self.server.engine.quote_target(chat,server_id));return
            history=target.path in {'/v1/history','/v1/history/stats'}
            if target.path not in {'/v1/stream','/v1/history','/v1/history/stats'}:
                self.reply(404, {'error':'not_found'});return
            query = parse_qs(target.query, strict_parsing=True)
            expected = {'chat','after','limit'} | ({'start','end','through','summary'} if history else set())
            if set(query) - expected or any(len(v) != 1 for v in query.values()):
                raise ValueError('Invalid query')
            chat = int(query['chat'][0]);after = query.get('after',['0'])[0]
            limit = int(query.get('limit',['200'])[0])
            if chat not in self.server.engine.store.allowed:
                self.reply(404, {'error':'not_found'});return
            if not 1 <= limit <= 200:
                raise ValueError('Invalid page limit')
            if after == 'tail' and target.path == '/v1/stream':
                self.reply(200, self.server.engine.tail(chat));return
            after = int(after)
            if after < 0 or after >= 2**53:
                raise ValueError('Invalid cursor')
            start = end = None
            if history:
                import math
                start,end = float(query['start'][0]),float(query['end'][0])
                if not math.isfinite(start) or not math.isfinite(end) or not 0 < end-start <= 31*86400 or end > time.time()+15:
                    raise ValueError('Invalid history window')
            if target.path=='/v1/history/stats':
                if set(query)!={'chat','start','end'}:raise ValueError('Invalid statistics query')
                # One explicit reconciliation per task; pages use the event-fed
                # archive and the frozen upper sequence, never idle scans.
                self.server.engine.sync()
                self.reply(200,self.server.engine.summary_stats(chat,start,end));return
            through=None;summary=False
            if 'through' in query or 'summary' in query:
                through=int(query['through'][0]);summary=query['summary'][0]=='1'
                if not history or not summary or not 0<=through<2**53:raise ValueError('Invalid snapshot')
            if target.path=='/v1/history' and through is None:self.server.engine.sync()
            self.reply(200,self.server.engine.page(chat,after,limit,start,end,**({'through':through,'summary':summary} if through is not None else {})))
        except (ValueError, KeyError):
            self.reply(400, {'error':'invalid_request'})
        except OverflowError:
            self.reply(413, {'error':'window_too_large'})
        except (BrokenPipeError,ConnectionResetError):
            pass
        except Exception:
            self.reply(503, {'error':'source_unavailable'})

def serve(engine, token, host='0.0.0.0', port=5030):
    stop = threading.Event()
    server = ThreadingHTTPServer((host,port), Handler)
    server.daemon_threads = True
    server.engine,server.token = engine,token
    changes=FileChanges(engine.source,engine.secrets)
    server.monitor=changes
    engine.tracking=changes.tracking
    def run_listener():
        try:synchronize(engine,stop,changes)
        except Exception:
            stop.set()
            threading.Thread(target=server.shutdown,daemon=True).start()
    worker = threading.Thread(target=run_listener,daemon=True)
    worker.start()
    def shutdown(*_args):
        stop.set()
        changes.wake()
        threading.Thread(target=server.shutdown, daemon=True).start()
    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    try:
        server.serve_forever()
    finally:
        stop.set()
        changes.wake()
        server.server_close()
        worker.join(timeout=15)
        changes.close()
        engine.key = None
