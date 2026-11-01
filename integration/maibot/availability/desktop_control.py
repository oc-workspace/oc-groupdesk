"""Bounded login recovery inside the existing desktop; never reads chat bodies."""
import json,os,subprocess,sys
from pathlib import Path

def processes():
    found=[]
    for p in Path('/proc').iterdir():
        if not p.name.isdigit():continue
        try:found.append((p,(p/'comm').read_text().strip()))
        except OSError:pass
    return found

def environment(procs):
    for p,name in sorted(procs,key=lambda v:v[1]!='wechat'):
        if name not in {'wechat','weixin','openbox','selkies','xfsettingsd'}:continue
        try:
            raw=dict(v.split(b'=',1) for v in (p/'environ').read_bytes().split(b'\0') if b'=' in v)
            selected={k:raw[k.encode()].decode() for k in ['DISPLAY','DBUS_SESSION_BUS_ADDRESS','XAUTHORITY'] if raw.get(k.encode())}
            if selected.get('DISPLAY') and selected.get('DBUS_SESSION_BUS_ADDRESS'):return selected
        except (OSError,ValueError):pass
    return None

def main(action):
    procs=processes();env=environment(procs)
    if not env:return {'state':'desktop_unavailable'}
    os.environ.update(env)
    alive=[p for p,name in procs if name in {'wechat','weixin'}]
    if not alive:
        if action=='start':
            os.environ.update(QT_LINUX_ACCESSIBILITY_ALWAYS_ON='1',NO_AT_BRIDGE='0')
            subprocess.Popen(['/usr/bin/wechat'],env=os.environ.copy(),stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
            return {'state':'starting'}
        return {'state':'process_missing'}
    sys.path.insert(0,'/opt/bowxt/src')
    from bowxt.accessibility import AtspiBackend,walk
    from bowxt.selectors import find_editor,find_session_list
    b=AtspiBackend();b.connect();root=b.main_window()
    if find_editor(root) is not None and find_session_list(root) is not None:return {'state':'online'}
    nodes=[n for n,depth in walk(root,max_depth=6)]
    labels=' '.join(n.name for n in nodes).casefold()
    if any(t in labels for t in ['已被锁定','解锁以继续使用','wechat is locked']):return {'state':'needs_unlock'}
    if any(t in labels for t in ['手机上完成登录','手机确认','手机上确认','confirm on your phone','扫码','二维码','scan qr']):return {'state':'needs_phone'}
    buttons=[n for n in nodes if n.name.strip().casefold() in {'登录','进入微信','log in','login','enter wechat'} and 'button' in n.role and n.bounds]
    if len(buttons)!=1:return {'state':'ui_unavailable'}
    if action!='login':return {'state':'login_ready'}
    # Refuse ambiguous windows, then use the existing X11 input mechanism.
    windows=subprocess.check_output(['xdotool','search','--onlyvisible','--pid',alive[0].name],text=True,timeout=5).split()
    if len(windows)!=1:return {'state':'needs_phone'}
    rect=buttons[0].bounds
    subprocess.run(['xdotool','windowactivate','--sync',windows[0]],check=True,timeout=5)
    subprocess.run(['xdotool','mousemove',str(rect.x+rect.width//2),str(rect.y+rect.height//2),'click','1'],check=True,timeout=5)
    return {'state':'login_clicked'}

if __name__=='__main__':
    try:result=main(sys.argv[1] if len(sys.argv)>1 else 'probe')
    except Exception:result={'state':'ui_unavailable'}
    print(json.dumps(result))
