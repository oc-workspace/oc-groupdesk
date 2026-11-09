"""GroupDesk target-device preflight, reader installation plan and one-use pairing.
inspect/reader-plan are local and read-only; install-reader needs explicit consent.
Never reads chats, captures keys, logs in, restarts WeChat or enables a bot.
"""
import argparse,getpass,json,os,platform,re,shutil,subprocess,uuid,urllib.request,urllib.parse
import hashlib,importlib.metadata,io,sys,tarfile,tempfile,venv
from pathlib import Path
APPROVED_SITE = 'https://groupdesk.rococo.dev'
KEEPER_COMMIT='2225294fd0761e10ce15540f21e7dbb2ac304c3c'
KEEPER_SHA256='7beed277d9bcb9d6a3715e5634a5f8ccda69af8c546030a098d170cddef48f31'
KEEPER_URL='https://codeload.github.com/labazhou2024/chatlog-keeper/tar.gz/'+KEEPER_COMMIT
KEEPER_DOC='https://github.com/labazhou2024/chatlog-keeper/blob/'+KEEPER_COMMIT+'/README.md'
CHATLOG_DOC='https://github.com/imldy/chatlog/blob/main/README.md'
LINUX_ELF='2ca28ea56b1a400543d0128ebaf0b93f88172dd66dc0426d3d74fdb971eab959'
MAC_BUILDS={'4.1.11':{'269136'},'4.1.12':{'269364'},'4.1.13':{'269579'},'4.1.15':{'270100','270102'}}

def command(args):
    try:
        p=subprocess.run(args,capture_output=True,text=True,timeout=12)
        return {'ok':p.returncode==0,'version':p.stdout.strip()[:250] if p.returncode==0 else ''}
    except (OSError,subprocess.TimeoutExpired):return {'ok':False,'version':''}

def detect_os():return {'Linux':'linux','Darwin':'macos','Windows':'windows'}.get(platform.system(),'unknown')
def fingerprint(path):
    try:
        p=Path(path)
        if not p.is_file() or p.stat().st_size>1024**3:return ''
        h=hashlib.sha256()
        with p.open('rb') as f:
            for block in iter(lambda:f.read(1024*1024),b''):h.update(block)
        return h.hexdigest()
    except OSError:return ''

def container_name(value):
    if value and not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}',value):raise ValueError('请输入准确的容器名称，不接受命令、路径或通配符')
    return value

def wechat_info(os_name,arch,container=None):
    value={'detected_os':os_name,'cpu_arch':arch,'version':'待检测','build':'','installation':'unknown','fingerprint':''}
    if container:
        container_name(container);value.update(installation='docker',container=container,detected_os='unknown',cpu_arch='unknown')
        system=command(['docker','exec',container,'uname','-s']);cpu=command(['docker','exec',container,'uname','-m'])
        if system['ok']:value['detected_os']={'Linux':'linux','Darwin':'macos','Windows_NT':'windows'}.get(system['version'],'unknown')
        if cpu['ok']:value['cpu_arch']=cpu['version']
        for package in ['wechat','weixin']:
            r=command(['docker','exec',container,'dpkg-query','-W','-f=${Version}',package])
            if r['ok']:value['version']=r['version'];break
        if value['detected_os']=='linux':
            r=command(['docker','exec',container,'sha256sum','/opt/wechat/wechat'])
            if r['ok'] and re.match(r'^[0-9a-f]{64}\s',r['version']):value['fingerprint']=r['version'].split()[0]
        return value
    if os_name=='linux' and shutil.which('dpkg-query'):
        for package in ['wechat','weixin']:
            r=command(['dpkg-query','-W','-f=${Version}',package])
            if r['ok']:value.update(version=r['version'],installation='deb');break
        if value['installation']=='deb':value['fingerprint']=fingerprint('/opt/wechat/wechat')
    elif os_name=='macos':
        import plistlib
        # Only the two standard app locations; never search chat/profile directories.
        for p in [Path('/Applications/WeChat.app/Contents/Info.plist'),Path.home()/'Applications/WeChat.app/Contents/Info.plist']:
            if not p.is_file():continue
            try:
                info=plistlib.loads(p.read_bytes());value.update(version=str(info.get('CFBundleShortVersionString','待检测'))[:100],build=str(info.get('CFBundleVersion',''))[:100],installation='native_app');break
            except (OSError,ValueError):pass
    elif os_name=='windows':
        try:
            import winreg
            for hive in [winreg.HKEY_CURRENT_USER,winreg.HKEY_LOCAL_MACHINE]:
                for product in [r'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\WeChat',r'SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\WeChat']:
                    try:
                        with winreg.OpenKey(hive,product) as k:value.update(version=str(winreg.QueryValueEx(k,'DisplayVersion')[0])[:100],installation='native_app')
                    except OSError:pass
        except ImportError:pass
    return value

def reader_tools(directory=None,container=None):
    result={name:{'detected':False,'version':'待核实','scope':'target_host'} for name in ['chatlog','chatlog-keeper','groupdesk-reader']}
    for name in ['chatlog','chatlog-keeper']:
        found=shutil.which(name)
        if found:result[name].update(detected=True,executable=found)
    try:result['chatlog-keeper'].update(detected=True,version=importlib.metadata.version('chatlog-keeper'),scope='current_python')
    except importlib.metadata.PackageNotFoundError:pass
    if directory:
        path=Path(directory).expanduser().resolve()/'groupdesk-reader-install.json'
        try:
            if path.stat().st_size>4096:raise ValueError('install record too large')
            data=json.loads(path.read_text())
            if data.get('upstream_commit')==KEEPER_COMMIT and data.get('archive_sha256')==KEEPER_SHA256 and data.get('installed') is True:
                # Presence of a record is local evidence, never proof of compatibility/health.
                executable=path.parent/'venv/bin/chatlog-keeper'
                if executable.is_file():result['chatlog-keeper'].update(detected=True,version='0.3.7rc0',scope='specified_private_directory',upstream_commit=KEEPER_COMMIT)
        except (OSError,ValueError,TypeError):pass
    if container:
        container_name(container)
        # Fixed file-presence probes in exactly the named container; no configs, env or chat reads.
        for name,path in [('chatlog-keeper','/opt/chatlog-keeper/chatlog_keeper/wechat_db.py'),('groupdesk-reader','/app/chatlog_reader/engine.py')]:
            r=command(['docker','exec',container,'test','-f',path])
            if r['ok']:result[name].update(detected=True,scope='specified_container',container=container)
        r=command(['docker','exec',container,'test','-x','/usr/local/bin/chatlog'])
        if r['ok']:result['chatlog'].update(detected=True,scope='specified_container',container=container)
    return result

def reader_compatibility(wechat):
    os_name,arch,version=wechat['detected_os'],wechat['cpu_arch'].lower(),wechat['version']
    found=bool(re.match(r'^\d+\.\d+',version))
    keeper={'status':'needs_verification','reason':'尚无当前系统、架构、微信准确构建的已验证组合，先评估，不自动安装或取钥。','source':KEEPER_DOC}
    chatlog={'status':'needs_verification','reason':'仅列为候选；须核对准确版本的读取/取钥支持，并适配GroupDesk接口。','source':CHATLOG_DOC}
    if not found:keeper.update(status='wechat_not_detected',reason='未检测到准确微信版本；如尚未安装，先由AI提供版本与来源方案，确认后再安装并重新检测。')
    elif os_name=='linux':
        chatlog.update(status='not_supported',reason='当前核验的chatlog说明列出Windows/macOS，不能用于证明支持原生Linux微信。')
        if arch in ['x86_64','amd64'] and version=='4.1.13.23' and wechat['fingerprint']==LINUX_ELF:
            keeper.update(status='project_verified_build',reason='匹配rococo-root2已验证的Linux x86_64微信构建；仍需本人授权后验证本账号真实解密、消息解析及桥接。')
        elif arch in ['x86_64','amd64'] and version=='4.1.13.9':
            keeper.update(status='upstream_reported',reason='上游报告支持4.1.13.9；未核实本机ELF，不等于GroupDesk端到端已验证。')
    elif os_name=='macos' and arch in ['arm64','aarch64']:
        if wechat.get('build') in MAC_BUILDS.get(version,set()):keeper.update(status='upstream_reported',reason='准确版本/构建在上游Apple Silicon验证表中；本账号取钥与GroupDesk收发适配仍待验证。')
    return {'chatlog-keeper':keeper,'chatlog':chatlog,'preferred':'chatlog-keeper' if keeper['status'] in ['project_verified_build','upstream_reported'] or os_name=='linux' and found else 'evaluate_candidates','account_read_verified':False,'groupdesk_runtime_verified':False}

def selected_component(container):
    if not container:return {'status':'not_checked','reason':'未指定本机器人容器；由本地AI确认目标后再检查，不遍历其他账号。'}
    container_name(container);r=command(['docker','inspect','--type','container','--format','{{.State.Running}}',container])
    return {'container':container,'status':'running' if r['ok'] and r['version']=='true' else 'not_running_or_unavailable','healthy_verified':False}

def inspect_device(wechat_container=None,reader_container=None,reader_directory=None,maibot_container=None,bridge_container=None):
    os_name,arch=detect_os(),platform.machine()
    result={'contract':2,'detected_os':os_name,'cpu_arch':arch,'docker':{'ok':False},'compose':{'ok':False},'changes_made':False,'network_used':False,'chats_read':False,'capture_prerequisites':{'gdb_present':bool(shutil.which('gdb')),'c_compiler_present':bool(shutil.which('gcc') or shutil.which('clang'))}}
    if shutil.which('docker'):
        result['docker']=command(['docker','version','--format','{{.Server.Version}}']);result['compose']=command(['docker','compose','version','--short'])
    wechat=wechat_info(os_name,arch,wechat_container);result['wechat']=wechat;result['wechat_version']=wechat['version']
    result['components']={'maibot':selected_component(maibot_container),'bridge':selected_component(bridge_container)};result['readers']=reader_tools(reader_directory,reader_container);result['reader_compatibility']=reader_compatibility(wechat)
    result['gui']=gui_preflight();result['compatibility']='按reader_compatibility查看；未验证本账号读取或完整GroupDesk链路，检测成功不等于已接入。'
    result['checks_remaining']=['有需要时明确指定本机器人的微信/Reader容器或私有安装目录，不自动遍历其他容器','核验MaiBot和收发桥接的适配包、版本与首群白名单','安装方案经本人确认后执行，保留已有微信与数据','站点第2步本人登录、单独授权后才可取钥、解密与读取验证','在同一步以真实健康上报核验连接']
    return result

def reader_plan(report,reading_mode='auto'):
    if reading_mode not in {'auto','database','gui'}:raise ValueError('不支持的读取偏好')
    compat=report['reader_compatibility'];choice=compat['preferred'];keeper=compat['chatlog-keeper'];w=report['wechat']
    native=not w.get('container')
    installable=reading_mode!='gui' and native and report['detected_os'] in ['linux','macos'] and keeper['status'] in ['project_verified_build','upstream_reported'] and (3,10)<=sys.version_info[:2]<=(3,12)
    gui=reading_mode=='gui'
    compare=reading_mode=='auto' and keeper['status'] not in ['project_verified_build','upstream_reported']
    route='gui_review' if gui else 'compare_database_and_gui' if compare else 'database_review'
    return {'contract':3,'reading_mode':reading_mode,'route':route,'requires_user_confirmation':True,'gui':report.get('gui',gui_preflight()),'inspection':report,'recommended_tool':'gui' if gui else 'evaluate_candidates' if compare else choice,'gui_backup_available':True,'can_install_keeper_component':installable,'sources':{'chatlog':CHATLOG_DOC,'chatlog-keeper':KEEPER_DOC},'steps':[
        '先核对实际微信版本、架构和安装方式；已有微信先保留，不同时安装两个读取工具。',
        '未验证不等于不可用；先核对两个数据库候选。数据库方案确实不可用时可以提出GUI备用，但先由本人确认，不能静默回退；显式选择GUI时不安装数据库读取组件。',
        'GUI需对应平台的后台采集适配器、可操作微信桌面、稳定身份/去重/断点恢复；缺包记录gui_adapter_missing，不将本地AI能读屏当作完整接入。授权前不试读聊天，不上传截图、窗口内容或剪贴板。',
        'project_verified_build仅表示构建匹配；upstream_reported仅为上游说明；needs_verification必须先核对兼容性，不直接执行安装。',
        '缺少微信时由本地AI先提供官方版本/来源/影响，确认安装后重新inspect；不为了兼容擅自覆盖日常微信。',
        'chatlog-keeper未发布PyPI：不能pip install chatlog-keeper。可安装固定提交的已校验源码；chatlog仅按官方文档核实具体版本和校验和后安装，不编造可用Release。',
        'install-reader只准备chatlog-keeper组件，限已列出的原生Linux/macOS候选、Python3.10—3.12和新私有目录，需本人明确确认联网下载与安装。容器内组件交给经审核运行镜像准备，不在现有微信容器内执行pip安装。',
        '完整Chatlog Reader服务、MaiBot与收发桥接仍要准备核验的适配包；仅安装上游工具不能自动完成GroupDesk接入。',
        '安装不取钥、不读聊天、不重启微信、不改SIP/Yama/杀毒设置；若候选要求这些操作，先解释具体影响并由本人另行决定，不能自动执行。',
        '本人在站点站点第2步先登录、再单独授权后，才验证本账号密钥、数据库解密、消息解析与增量读取；在同一步看真实连接，再到第3步配置模型和启用。'
    ],'changes_made':False,'account_read_verified':False,'groupdesk_runtime_verified':False}

REPORT_METHODS={'unknown','chatlog_keeper','chatlog','gui','macos_wechat_export'}
REPORT_PHASES={'inspect','plan','install','connect','verify'}
REPORT_OUTCOMES={'info','planned','success','blocked','failed'}
REPORT_ERRORS={'none','database_unavailable','gui_adapter_missing','gui_not_verified','login_required','permission_required','unsupported_platform','missing_components','install_failed','connection_failed','verification_failed','unknown'}
def gui_preflight():
    # Presence only: no screen capture, clipboard, window titles or message inspection.
    os_name=detect_os()
    return {'candidate':os_name in ['linux','windows','macos'],'desktop_session_hint':bool(os.environ.get('DISPLAY') or os.environ.get('WAYLAND_DISPLAY')) if os_name=='linux' else 'not_checked','screen_access_verified':False,'wechat_session_verified':False,'groupdesk_gui_adapter_verified':False,'status':'needs_verification','notes':['本人确认后评估GUI备用，不静默切换','须有目标平台的持续采集适配器；AI能点击鼠标不等于已接入','微信需已登录、未锁定、桌面可操作；授权前不试读聊天']}

def diagnostic_event(report,phase,outcome,reading_mode='auto',selected_method='unknown',used_method='unknown',failure_code='none'):
    if reading_mode not in {'auto','database','gui'} or selected_method not in REPORT_METHODS or used_method not in REPORT_METHODS or phase not in REPORT_PHASES or outcome not in REPORT_OUTCOMES or failure_code not in REPORT_ERRORS:raise ValueError('不支持的安装记录字段')
    if phase=='verify' and outcome=='success' and used_method=='unknown':raise ValueError('本地试读成功时需注明实际读取方式')
    if used_method!='unknown' and (phase!='verify' or outcome!='success'):raise ValueError('仅完成真实本地验收后记录实际读取方式')
    from datetime import datetime,timezone
    version=report.get('wechat',{}).get('version','unknown')
    if not isinstance(version,str) or len(version)>48 or not re.fullmatch(r'(?:unknown|\d{1,3}(?:\.[0-9A-Za-z]{1,12}){1,4}(?:[+() _-][0-9A-Za-z.+() _-]{1,16})?)',version):version='unknown'
    arch=str(report.get('wechat',{}).get('cpu_arch',report.get('cpu_arch','unknown'))).lower();arch='x86_64' if arch in {'x86_64','amd64'} else 'arm64' if arch in {'arm64','aarch64'} else 'unknown' if arch=='unknown' else 'other'
    platform_name=report.get('wechat',{}).get('detected_os',report.get('detected_os','unknown'));platform_name=platform_name if platform_name in {'linux','windows','macos'} else 'unknown'
    key='chatlog-keeper' if selected_method=='chatlog_keeper' else 'chatlog' if selected_method=='chatlog' else ''
    compatibility=report.get('reader_compatibility',{}).get(key,{}).get('status','needs_verification' if selected_method=='gui' else 'unknown')
    if compatibility not in {'unknown','project_verified_build','upstream_reported','needs_verification','not_supported','wechat_not_detected'}:compatibility='unknown'
    return {'contract':1,'report_id':str(uuid.uuid4()),'generated_at':datetime.now(timezone.utc).isoformat(),'phase':phase,'outcome':outcome,'reading_mode':reading_mode,'selected_method':selected_method,'used_method':used_method,'platform':platform_name,'arch':arch,'wechat_version':version,'compatibility':compatibility,'failure_code':failure_code}

def validate_diagnostics(value):
    if not isinstance(value,dict) or set(value)!={'contract','events'} or type(value['contract']) is not int or value['contract']!=1 or not isinstance(value['events'],list) or not 1<=len(value['events'])<=50:raise ValueError('安装报告格式不正确，不上传原始日志')
    fields={'contract','report_id','generated_at','phase','outcome','reading_mode','selected_method','used_method','platform','arch','wechat_version','compatibility','failure_code'}
    from datetime import datetime
    for event in value['events']:
        if not isinstance(event,dict) or set(event)!=fields or type(event.get('contract')) is not int or event.get('contract')!=1 or any(not isinstance(event.get(field),str) for field in fields if field!='contract'):raise ValueError('安装报告只允许固定诊断字段，不上传聊天、路径或原始日志')
        if not re.fullmatch(r'[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}',event['report_id']):raise ValueError('安装报告编号格式不正确')
        uuid.UUID(event['report_id']);dt=datetime.fromisoformat(event['generated_at'].replace('Z','+00:00'))
        if not dt.tzinfo or len(event['generated_at'])>40 or event['phase'] not in REPORT_PHASES or event['outcome'] not in REPORT_OUTCOMES or event['reading_mode'] not in {'auto','database','gui'} or event['selected_method'] not in REPORT_METHODS or event['used_method'] not in REPORT_METHODS or event['failure_code'] not in REPORT_ERRORS:raise ValueError('不支持的安装诊断值')
        if event['phase']=='verify' and event['outcome']=='success' and event['used_method']=='unknown':raise ValueError('本地试读成功时需注明实际读取方式')
        if event['used_method']!='unknown' and (event['phase']!='verify' or event['outcome']!='success'):raise ValueError('实际读取方式仅随成功的本地验收记录提交')
        if event['platform'] not in {'unknown','linux','macos','windows'} or event['arch'] not in {'unknown','x86_64','arm64','other'} or not isinstance(event['wechat_version'],str) or len(event['wechat_version'])>48 or not re.fullmatch(r'(?:unknown|\d{1,3}(?:\.[0-9A-Za-z]{1,12}){1,4}(?:[+() _-][0-9A-Za-z.+() _-]{1,16})?)',event['wechat_version']) or event['compatibility'] not in {'unknown','project_verified_build','upstream_reported','needs_verification','not_supported','wechat_not_detected'}:raise ValueError('版本或兼容性字段不正确')
    return value

def private_report_directory(directory):
    path=Path(directory).expanduser().absolute()
    if path.is_symlink():raise ValueError('报告目录不能是链接')
    if path.exists():
        info=path.stat()
        if not path.is_dir() or hasattr(os,'getuid') and info.st_uid!=os.getuid() or os.name!='nt' and info.st_mode&0o077:raise ValueError('请使用本人独占的私有报告目录')
    else:path.mkdir(mode=0o700,parents=False);path.chmod(0o700)
    return path

def read_diagnostics(directory):
    root=private_report_directory(directory);path=root/'installation-report.json'
    if path.is_symlink() or path.stat().st_size>128*1024:raise ValueError('报告文件不安全或过大')
    return validate_diagnostics(json.loads(path.read_text()))

def diagnostic_context(directory):
    try:
        events=read_diagnostics(directory)['events']
        event=next((x for x in reversed(events) if x['wechat_version']!='unknown'),events[-1])
        return {'detected_os':event['platform'],'wechat':{'detected_os':event['platform'],'cpu_arch':event['arch'],'version':event['wechat_version']},'reader_compatibility':{'chatlog-keeper':{'status':event['compatibility']},'chatlog':{'status':event['compatibility']}}}
    except (ValueError,OSError):return {}

def write_diagnostic(directory,event):
    root=private_report_directory(directory);path=root/'installation-report.json'
    if path.is_symlink():raise ValueError('报告文件不能是链接')
    prior=read_diagnostics(root)['events'] if path.exists() else []
    value=validate_diagnostics({'contract':1,'events':(prior+[event])[-50:]})
    temp=root/('.report-'+str(uuid.uuid4())+'.json')
    fd=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    try:
        with os.fdopen(fd,'w') as f:json.dump(value,f,ensure_ascii=False,indent=2)
        temp.replace(path)
    finally:
        if temp.exists():temp.unlink()
    return value

def upload_diagnostics(connection_directory,report_directory):
    root=Path(connection_directory).expanduser();path=root/'connection.json'
    if root.is_symlink() or path.is_symlink() or path.stat().st_size>16384 or hasattr(os,'getuid') and path.stat().st_uid!=os.getuid() or os.name!='nt' and path.stat().st_mode&0o077:raise ValueError('请使用当前机器人的私有连接凭据目录')
    connection=json.loads(path.read_text());site=connection.get('url','')
    if site.rstrip('/')!=APPROVED_SITE or urllib.parse.urlsplit(site).scheme!='https':raise ValueError('仅向本工具来源的正式HTTPS站点提交报告')
    bearer=connection.get('token','')
    if not re.fullmatch(r'[A-Za-z0-9_-]{32,200}',bearer):raise ValueError('设备连接凭据无效')
    payload={'bot_id':str(uuid.UUID(connection['bot_id'])),'instance_id':str(uuid.UUID(connection['runtime_instance_id'])),'report':read_diagnostics(report_directory)}
    request=urllib.request.Request(site.rstrip('/')+'/api/device-onboarding/report',data=json.dumps(payload).encode(),headers={'Content-Type':'application/json','Authorization':'Bearer '+bearer})
    try:
        with urllib.request.build_opener(NoRedirect()).open(request,timeout=20) as response:
            value=json.loads(response.read(4096))
        if value.get('ok') is not True:raise ValueError('not accepted')
    except Exception:raise ValueError('安装报告尚未上传；设备连接不受影响。可稍后重试，或由本人在站点上传installation-report.json。') from None
    return {'ok':True,'shared_fields':'版本、读取方式、阶段及结果；不含聊天、密钥或原始日志'}

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*_args,**_kwargs):raise ValueError('Refusing credential redirect')

def unpack_keeper(data,directory):
    if hashlib.sha256(data).hexdigest()!=KEEPER_SHA256:raise ValueError('源码SHA256与固定版本不符，已停止，不执行源码')
    prefix='chatlog-keeper-'+KEEPER_COMMIT+'/'
    with tarfile.open(fileobj=io.BytesIO(data),mode='r:gz') as archive:
        members=archive.getmembers()
        if len(members)>5000 or sum(m.size for m in members)>32*1024*1024:raise ValueError('源码包超出预期范围')
        # Verify every member before writing; no links, devices or traversal.
        for m in members:
            if m.name==prefix.rstrip('/') and m.isdir():continue
            if not m.name.startswith(prefix) or not (m.isfile() or m.isdir()):raise ValueError('不接受源码包链接或特殊文件')
            name=m.name[len(prefix):]
            if not name or name.startswith('/') or '\\' in name or any(p in ('..','') for p in name.split('/')):raise ValueError('不安全的源码路径')
        for m in members:
            if m.name==prefix.rstrip('/'):continue
            dest=directory/m.name[len(prefix):]
            if m.isdir():dest.mkdir(mode=0o700,parents=True,exist_ok=True)
            else:
                dest.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
                with archive.extractfile(m) as src, dest.open('xb') as out:shutil.copyfileobj(src,out)
                dest.chmod(0o600)

def install_reader(directory,confirmed=False,report=None):
    # Inspect only after explicit consent; don't touch a directory or use the network otherwise.
    if not confirmed:raise ValueError('先让AI解释安装计划；本人确认联网下载固定源码及PyPI依赖后才使用 --confirm-install。不会取钥或读取聊天。')
    if os.name=='nt':raise ValueError('Windows私有凭据存储尚待验证；只提供检查和安装方案，不执行此安装器。')
    if hasattr(os,'geteuid') and os.geteuid()==0:raise ValueError('请以目标设备本人普通用户运行，不用root或sudo安装。')
    path=Path(directory).expanduser().absolute()
    if path.exists() or path.is_symlink():raise ValueError('安装目录已存在；请选择全新的本机器人私有目录，保留原有数据。')
    if not path.parent.is_dir() or path.parent.is_symlink():raise ValueError('父目录需已存在且不是符号链接；先由本人核对私有安装位置。')
    plan=reader_plan(report or inspect_device())
    if not plan['can_install_keeper_component']:raise ValueError('当前组合不在自动准备范围；请先查看reader-plan的兼容性、Python版本或容器说明，由安装助手核实缺项，不修改微信。')
    # Public code only; no bot identity, key or machine report is sent.
    with urllib.request.build_opener(NoRedirect()).open(KEEPER_URL,timeout=30) as response:data=response.read(8*1024*1024+1)
    if len(data)>8*1024*1024 or hashlib.sha256(data).hexdigest()!=KEEPER_SHA256:raise ValueError('固定源码下载大小或SHA256不符，未安装')
    path.mkdir(mode=0o700,exist_ok=False);path.chmod(0o700)
    try:
        source=path/'source';source.mkdir(mode=0o700);unpack_keeper(data,source)
        (path/'tmp').mkdir(mode=0o700)
        venv.EnvBuilder(with_pip=True).create(path/'venv');python=path/'venv/bin/python'
        env={**os.environ,'PIP_CONFIG_FILE':os.devnull,'PIP_DISABLE_PIP_VERSION_CHECK':'1','PYTHONNOUSERSITE':'1','TMPDIR':str(path/'tmp')}
        # No root, user-site, extra-index, shell, source dependency builds or unpinned latest packages.
        dependencies=['setuptools==75.8.0','wheel==0.45.1','pycryptodome==3.23.0','numpy==2.2.6','zstandard==0.22.0']
        commands=[([str(python),'-I','-m','pip','--isolated','--no-cache-dir','--disable-pip-version-check','install','--index-url','https://pypi.org/simple','--only-binary=:all:','--no-deps']+dependencies),[str(python),'-I','-m','pip','--isolated','--no-cache-dir','--disable-pip-version-check','install','--no-index','--no-deps','--no-build-isolation',str(source)]]
        for args in commands:
            subprocess.run(args,check=True,capture_output=True,text=True,timeout=300,env=env)
        record={'contract':2,'installed':True,'tool':'chatlog-keeper','version':'0.3.7rc0','upstream_commit':KEEPER_COMMIT,'archive_sha256':KEEPER_SHA256,'dependencies':dependencies,'account_read_verified':False,'groupdesk_runtime_verified':False}
        with (path/'groupdesk-reader-install.json').open('x') as f:json.dump(record,f,ensure_ascii=False,indent=2)
        (path/'groupdesk-reader-install.json').chmod(0o600)
        return {**record,'directory':str(path),'next':'组件已准备。保留本地目录；继续核验完整Reader/MaiBot/桥接。站点第2步先登录、再单独授权后才做真实读取验证。'}
    except Exception:
        # Retain a failed new directory for diagnosis; never prune/delete user files or disclose pip output.
        raise ValueError('安装未完成；新目录保留，未修改微信。请本地AI检查目录执行权限（noexec）、Python/网络/依赖与固定源码，不把原始日志、密码或Key贴到站点。') from None

def pair(site,bot_id,directory):
    if os.name=='nt':raise ValueError('Windows目前仅支持只读检查；配对凭据的私有存储尚待验证，请先完成兼容性及私有存储适配评估，暂不配对。')
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
    return value


def main():
    p=argparse.ArgumentParser(description=__doc__);commands=p.add_subparsers(dest='action',required=True)
    for action in ['inspect','reader-plan']:
        a=commands.add_parser(action,help='只读检查；可选生成仅含版本/方式/步骤结果的私有安装报告')
        a.add_argument('--maibot-container',type=container_name);a.add_argument('--bridge-container',type=container_name);a.add_argument('--wechat-container',type=container_name);a.add_argument('--reader-container',type=container_name);a.add_argument('--reader-directory');a.add_argument('--reading-mode',choices=['auto','database','gui'],default='auto');a.add_argument('--report-directory')
    a=commands.add_parser('install-reader',help='本人确认后准备固定源码组件；仅安装不等于已读通')
    a.add_argument('--directory',required=True);a.add_argument('--confirm-install',action='store_true');a.add_argument('--report-directory')
    a=commands.add_parser('pair',help='本人连接设备；有报告时自动上报仅含诊断摘要的记录')
    a.add_argument('--site',required=True);a.add_argument('--bot',required=True);a.add_argument('--directory',required=True);a.add_argument('--report-directory')
    a=commands.add_parser('record-report',help='记录本地步骤结果，不读取聊天；成功试读需本人确认已经实际验收')
    a.add_argument('--report-directory',required=True);a.add_argument('--reading-mode',choices=['auto','database','gui'],default='auto');a.add_argument('--selected-method',choices=sorted(REPORT_METHODS),default='unknown');a.add_argument('--used-method',choices=sorted(REPORT_METHODS),default='unknown');a.add_argument('--phase',choices=sorted(REPORT_PHASES),required=True);a.add_argument('--outcome',choices=sorted(REPORT_OUTCOMES),required=True);a.add_argument('--failure-code',choices=sorted(REPORT_ERRORS),default='none');a.add_argument('--confirm-local-test',action='store_true')
    a=commands.add_parser('upload-report',help='用当前机器人的私有设备凭据上传诊断摘要，不含聊天或原始日志')
    a.add_argument('--connection-directory',required=True);a.add_argument('--report-directory',required=True)
    args=p.parse_args()
    if args.action in ['inspect','reader-plan']:
        report=inspect_device(args.wechat_container,args.reader_container,args.reader_directory,args.maibot_container,args.bridge_container)
        value=report if args.action=='inspect' else reader_plan(report,args.reading_mode)
        if args.report_directory:
            method='gui' if args.reading_mode=='gui' else 'chatlog_keeper' if report['reader_compatibility']['preferred']=='chatlog-keeper' else 'unknown'
            write_diagnostic(args.report_directory,diagnostic_event(report,'inspect' if args.action=='inspect' else 'plan','info' if args.action=='inspect' else 'planned',args.reading_mode,method))
            value['installation_report_saved']=True
        print(json.dumps(value,ensure_ascii=False,indent=2))
    elif args.action=='install-reader':
        try:
            value=install_reader(args.directory,args.confirm_install)
            write_diagnostic(args.report_directory or args.directory,diagnostic_event({},'install','success','database','chatlog_keeper'))
            print(json.dumps(value,ensure_ascii=False,indent=2))
        except (ValueError,OSError):
            if args.report_directory:write_diagnostic(args.report_directory,diagnostic_event({},'install','failed','database','chatlog_keeper',failure_code='install_failed'))
            raise
    elif args.action=='record-report':
        if args.used_method!='unknown' and not args.confirm_local_test:raise ValueError('只有授权后确实完成真实本地试读，才使用--confirm-local-test记录实际方式。不会因此标记站点在线。')
        write_diagnostic(args.report_directory,diagnostic_event(diagnostic_context(args.report_directory),args.phase,args.outcome,args.reading_mode,args.selected_method,args.used_method,args.failure_code));print('安装摘要已保存；不含聊天、密钥或原始日志。')
    elif args.action=='upload-report':print(json.dumps(upload_diagnostics(args.connection_directory,args.report_directory),ensure_ascii=False))
    else:
        try:
            pair(args.site,args.bot,args.directory)
        except (ValueError,OSError):
            if args.report_directory:write_diagnostic(args.report_directory,diagnostic_event({},'connect','failed',failure_code='connection_failed'))
            raise
        if args.report_directory:
            write_diagnostic(args.report_directory,diagnostic_event({},'connect','success'))
            try:upload_diagnostics(args.directory,args.report_directory);print('安装摘要已同步到站点，管理员可以查看。')
            except (ValueError,OSError) as error:print(str(error))
if __name__=='__main__':
    try:main()
    except (ValueError,OSError) as error:raise SystemExit(str(error))
