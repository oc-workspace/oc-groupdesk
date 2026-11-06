"""Root-only per-account Unix RPC broker, exposing five fixed operations."""
import argparse,json,os,socketserver
from pathlib import Path
from ops import Driver,Failure,identifier
class Server(socketserver.ThreadingUnixStreamServer):daemon_threads=True
class Handler(socketserver.StreamRequestHandler):
 def handle(self):
  self.request.settimeout(900)
  try:
   raw=self.rfile.readline(32769)
   if len(raw)>32768 or not raw.endswith(b'\n'):raise Failure('scope_mismatch')
   result=self.server.driver.handle(json.loads(raw));response={'ok':True,'result':result}
  except Failure as e:response={'ok':False,'error':e.code}
  except Exception:response={'ok':False,'error':'operation_failed'}
  self.wfile.write((json.dumps(response,ensure_ascii=False)+'\n').encode())
def main():
 p=argparse.ArgumentParser();p.add_argument('bot_id');a=p.parse_args();bot=identifier(a.bot_id)
 folder=Path('/run/groupdesk-onboarding')/bot;folder.mkdir(mode=0o700,parents=True,exist_ok=True);os.chmod(folder,0o700)
 path=folder/'control.sock'
 if path.exists():path.unlink()
 with Server(str(path),Handler) as server:
  os.chmod(path,0o600);server.driver=Driver(bot);server.serve_forever()
if __name__=='__main__':main()
