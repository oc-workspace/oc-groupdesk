"""Pause the idle Bowxt worker around one non-sending UI quote probe."""
import json
import os
import subprocess
import urllib.request

CONTAINER=os.environ.get('NATIVE_QUOTE_CONTAINER','wechat-bot')
PYTHONPATH=os.environ.get('NATIVE_QUOTE_PYTHONPATH','/tmp/bowxt-quote-probe')
SCRIPT=os.environ.get('NATIVE_QUOTE_PROBE_SCRIPT','probe-ui.py')
URL='http://127.0.0.1:8787/api/'

def run(*args):return subprocess.run(['docker',*args],check=True,text=True,capture_output=True,timeout=90)
def request(path,body=None):
    code="import json,urllib.request; b="+repr(json.dumps(body).encode() if body is not None else None)+"; r=urllib.request.Request("+repr(URL+path)+",data=b,method='PATCH' if b is not None else 'GET',headers={'Content-Type':'application/json'}); print(json.dumps(json.load(urllib.request.urlopen(r,timeout=5))))"
    return json.loads(run('exec',CONTAINER,'python3','-c',code).stdout)

status=request('status')
if not status['running'] or not status['wechat_connected'] or status['paused']:
    raise RuntimeError('Bowxt is not in its normal idle state')
if status['active_chat'] or status['queue_depth'] or status['sender_queue_depth']:
    raise RuntimeError('Bowxt has active UI work')
request('control',{'paused':True})
try:
    command=('exec','-e','PYTHONPATH='+PYTHONPATH,CONTAINER,'python3',
        '/tmp/bowxt-quote-probe/'+SCRIPT,'/tmp/native-quote-probe-target.json')
    try:
        result=run(*command)
        print(result.stdout.strip())
    except subprocess.CalledProcessError as exc:
        print((exc.stdout or '').strip())
        print((exc.stderr or '').strip()[-500:])
        raise
    except subprocess.TimeoutExpired as exc:
        subprocess.run(['docker','exec',CONTAINER,'pkill','-f','/tmp/bowxt-quote-probe/'+SCRIPT],
            check=False,capture_output=True,timeout=5)
        print((exc.stdout or b'').decode(errors='replace').strip()[-300:])
        raise
finally:
    request('control',{'paused':False})
