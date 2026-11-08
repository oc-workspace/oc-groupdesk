"""Read-only device preflight and one-use pairing; never installs or reads chats.
Use in a local AI tool with the user's permission. No API keys in arguments.
"""
import argparse,getpass,json,os,platform,re,shutil,subprocess,uuid,urllib.request,urllib.parse
from pathlib import Path
APPROVED_SITE = 'https://groupdesk.rococo.dev'

def command(args):
    try:
        p=subprocess.run(args,capture_output=True,text=True,timeout=12)
        return {'ok':p.returncode==0,'version':p.stdout.strip()[:250] if p.returncode==0 else ''}
    except (OSError,subprocess.TimeoutExpired):return {'ok':False,'version':''}

def detect_os():return {'Linux':'linux','Darwin':'macos','Windows':'windows'}.get(platform.system(),'unknown')
def inspect_device():
    result={'contract':1,'detected_os':detect_os(),'cpu_arch':platform.machine(),'docker':{'ok':False},'compose':{'ok':False},'wechat_version':'待检测','compatibility':'未验证；不能仅凭操作系统判断可用','changes_made':False}
    if shutil.which('docker'):
        result['docker']=command(['docker','version','--format','{{.Server.Version}}'])
        result['compose']=command(['docker','compose','version','--short'])
    if result['detected_os']=='linux' and shutil.which('dpkg-query'):
        for package in ['wechat','weixin']:
            value=command(['dpkg-query','-W','-f=${Version}',package])
            if value['ok']:result['wechat_version']=value['version'];break
    if result['detected_os']=='macos':
        import plistlib
        p=Path('/Applications/WeChat.app/Contents/Info.plist')
        if p.is_file():
            try:result['wechat_version']=str(plistlib.loads(p.read_bytes()).get('CFBundleShortVersionString','待检测'))[:100]
            except (OSError,ValueError):pass
    if result['detected_os']=='windows':
        try:
            import winreg
            for product in [r'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\WeChat',r'SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\WeChat']:
                try:
                    with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE,product) as k:result['wechat_version']=str(winreg.QueryValueEx(k,'DisplayVersion')[0])[:100];break
                except OSError:pass
        except ImportError:pass
    return result

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*_args,**_kwargs):raise ValueError('Refusing credential redirect')
def pair(site,bot_id,directory):
    if os.name=='nt':raise ValueError('Windows目前仅支持只读检查；配对凭据的私有存储尚待验证，请联系管理员或使用站点托管。')
    url=urllib.parse.urlsplit(site)
    if site.rstrip('/')!=APPROVED_SITE or url.scheme!='https' or not url.hostname or url.username or url.password or url.query or url.fragment or url.path not in ('','/'):
        raise ValueError('Use the HTTPS GroupDesk site origin, without credentials')
    bot_id=str(uuid.UUID(bot_id));directory=Path(directory).expanduser().resolve()
    if directory.exists():raise ValueError('Destination exists; choose a NEW directory to avoid replacing another bot')
    print('仅向所选站点发送配对码、机器人/设备ID和检测到的系统类型，不发送聊天、文件、微信密钥或模型Key。')
    code=getpass.getpass('在站点点击生成配对码，把10分钟有效的一次性码输入这里（不显示）：').strip()
    if not re.fullmatch(r'[A-Za-z0-9_-]{40,100}',code):raise ValueError('Invalid pairing code')
    payload={'bot_id':bot_id,'instance_id':str(uuid.uuid4()),'code':code,'detected_os':detect_os()}
    request=urllib.request.Request(site.rstrip('/')+'/api/device-onboarding/pair',data=json.dumps(payload).encode(),headers={'Content-Type':'application/json'})
    try:
        with urllib.request.build_opener(NoRedirect()).open(request,timeout=20) as r:value=json.loads(r.read(65537))
    except Exception:raise ValueError('配对失败；请回站点刷新，检查配对码、账号权限和设备绑定状态。不要把码发到聊天。') from None
    if value.get('bot_id')!=bot_id or value.get('runtime_instance_id')!=payload['instance_id'] or value.get('url')!=site.rstrip('/') or not re.fullmatch(r'[A-Za-z0-9_-]{32,200}',value.get('token','')):raise ValueError('Unexpected pairing response')
    directory.mkdir(mode=0o700,parents=True,exist_ok=False)
    path=directory/'connection.json'
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'w') as f:json.dump(value,f)
    print('设备凭据已保存到私有 connection.json。尚未安装组件、登录微信或验证在线；请由安装助手继续配置本账号运行环境。')

def main():
    p=argparse.ArgumentParser(description=__doc__);commands=p.add_subparsers(dest='action',required=True)
    commands.add_parser('inspect',help='只读检查系统、Docker/Compose与常规微信版本，不联网、不改配置')
    a=commands.add_parser('pair',help='用户确认后绑定设备，凭据仅保存新建私有目录');a.add_argument('--site',required=True);a.add_argument('--bot',required=True);a.add_argument('--directory',required=True)
    args=p.parse_args()
    if args.action=='inspect':print(json.dumps(inspect_device(),ensure_ascii=False,indent=2))
    else:pair(args.site,args.bot,args.directory)
if __name__=='__main__':
    try:main()
    except (ValueError,OSError) as error:raise SystemExit(str(error))
