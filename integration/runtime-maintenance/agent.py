"""Restricted, outbound-only host executor. No arbitrary paths or shell commands.

Inventory never reads WeChat DB contents, env files or backups. All mutations need
an expiring server permit, a deleted bot UUID, fresh topology and a local journal.
"""
import argparse, base64, datetime, fcntl, hashlib, hmac, json, os, re, shutil, stat, subprocess, time, urllib.request, uuid
from pathlib import Path

VERSION='runtime-maintenance-v2.1'
DEPLOY=Path('/opt/docker/oc-projects/groupdesk-bots')
PERSIST=Path('/opt/persist/groupdesk-bots')
QDATA=PERSIST/'.quarantine'
QDEPLOY=DEPLOY/'.quarantine'
STATE=Path('/opt/persist/groupdesk-runtime-maintenance/state')
LEGACY='00000000-0000-4000-8000-000000000001'
SERVICES={'wechat','reader','maibot','wechat-bridge','group-onboarding-agent'}
CATEGORIES={'wechat':['wechat'],'reader':['reader'],'maibot':['maibot'],'bridge':['bridge','limits'],'identity':['groupdesk','persona','secrets']}
UNIT_PREFIXES=['groupdesk-bot-wechat-egress','groupdesk-bot-runtime-egress','groupdesk-onboarding-control','groupdesk-onboarding-egress']
HOST_ROOTS={'rococo-root':[('/opt/docker/backups/groupdesk','backup'),('/opt/persist/groupdesk/backups','backup')], 'rococo-root2':[('/opt/persist/maibot-wechat','legacy'),('/opt/persist/chatlog-reader','legacy'),('/opt/docker/oc-projects/maibot-wechat','legacy')]}

def now():return datetime.datetime.now(datetime.timezone.utc).isoformat()
def digest(v):return hashlib.sha256(json.dumps(v,sort_keys=True,separators=(',',':')).encode()).hexdigest()
LEGACY_PERSIST=Path('/opt/persist/maibot-wechat')
LEGACY_READER=Path('/opt/persist/chatlog-reader')
LEGACY_PROFILE=Path('/opt/persist/groupdesk-runtime-maintenance/legacy-ryubuddy.json')
def slug_for(bot_id):return 'legacy-ryubuddy' if bot_id==LEGACY else canonical(bot_id)
def canonical(value):
    key=str(uuid.UUID(value))
    if key!=value or key==LEGACY:raise ValueError('Only canonical independent bot UUIDs are supported')
    return key.replace('-','')
def run(*args,timeout=30):return subprocess.check_output(list(args),text=True,timeout=timeout,stderr=subprocess.DEVNULL)
def atomic(path,value):
    path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    if path.parent.is_symlink() or path.is_symlink():raise ValueError('Untrusted journal directory')
    tmp=path.with_suffix('.tmp');tmp.write_text(json.dumps(value,ensure_ascii=False));tmp.chmod(0o600);tmp.replace(path)
def existing(path):
    try:return path.lstat()
    except FileNotFoundError:return None

def trusted(path):
    """Reject symlinks/mount points along the complete absolute path."""
    for part in [*reversed(path.parents),path]:
        s=existing(part)
        if s and (stat.S_ISLNK(s.st_mode) or not stat.S_ISDIR(s.st_mode)):raise ValueError('路径含符号链接或不是目录')
        if s and part not in {Path('/'),Path('/opt'),Path('/opt/persist'),Path('/opt/docker'),DEPLOY,PERSIST,QDATA,QDEPLOY,STATE,STATE.parent,LEGACY_PERSIST,LEGACY_READER} and os.path.ismount(part):raise ValueError('路径存在挂载边界，保留待核对')
    return path

def size_tree(path,limit=150000,protect_backups=True,allow_contained_links=False):
    if not existing(path):return {'bytes':0,'allocated':0,'blocked':[],'inode':None}
    result={'bytes':0,'allocated':0,'blocked':[],'inode':path.lstat().st_ino};seen=set();links={};count=0;deadline=time.monotonic()+15
    try:
        trusted(path);device=path.stat().st_dev
        for parent,dirs,files in os.walk(path,followlinks=False):
            for name in dirs+files:
                p=Path(parent)/name;s=p.lstat();count+=1
                if count>limit or time.monotonic()>deadline:raise ValueError('目录过大，大小尚未完整核验')
                if protect_backups and (name.lower() in {'backup','backups'} or name.lower().endswith(('.dump','.backup','.bak'))):raise ValueError('目录内含备份，首版仅盘点并保留')
                if stat.S_ISLNK(s.st_mode):raise ValueError('目录内含符号链接，保留待核对')
                if s.st_dev!=device or os.path.ismount(p):raise ValueError('目录内含其他挂载，保留待核对')
                if stat.S_ISREG(s.st_mode) and s.st_nlink>1:
                    if not allow_contained_links:raise ValueError('目录内含硬链接，保留待核对')
                    k=(s.st_dev,s.st_ino);links[k]=[links.get(k,[0,s.st_nlink])[0]+1,s.st_nlink]
                if (s.st_dev,s.st_ino) not in seen:
                    seen.add((s.st_dev,s.st_ino));result['bytes']+=s.st_size;result['allocated']+=s.st_blocks*512
        if any(count!=expected for count,expected in links.values()):raise ValueError('存在目录外硬链接引用，保留待核对')
    except (OSError,ValueError) as e:result['blocked']=[str(e) if isinstance(e,ValueError) else '目录元数据不可读取'];result['allocated']=None;result['bytes']=None
    return result

def normalized_container(row):
    row=dict(row);row['mounts']=sorted(row.get('mounts',[]),key=lambda m:json.dumps(m,sort_keys=True,separators=(',',':')));return row

def containers():
    ids=run('docker','ps','-aq').split()
    if not ids:return []
    fmt='{"id":{{json .Id}},"name":{{json .Name}},"labels":{{json .Config.Labels}},"mounts":{{json .Mounts}},"networks":{{json .NetworkSettings.Networks}},"running":{{json .State.Running}},"image":{{json .Image}},"restart":{{json .HostConfig.RestartPolicy}}}'
    return [normalized_container(json.loads(line)) for line in run('docker','inspect','--format',fmt,*ids).splitlines()]

def networks(project):
    ids=run('docker','network','ls','-q','--filter','label=com.docker.compose.project='+project).split()
    if not ids:return []
    fmt='{"id":{{json .Id}},"name":{{json .Name}},"labels":{{json .Labels}},"containers":{{json .Containers}}}'
    return sorted([json.loads(line) for line in run('docker','network','inspect','--format',fmt,*ids).splitlines()],key=lambda n:n['id'])

def units(bot_id):
    result=[]
    names=['maibot-availability.timer','maibot-availability.service','maibot-wechat-routing.service'] if bot_id==LEGACY else [p+'@'+bot_id+'.service' for p in UNIT_PREFIXES]
    for name in names:
        try:values=run('systemctl','show',name,'--property=LoadState,ActiveState,UnitFileState').splitlines();v=dict(line.split('=',1) for line in values if '=' in line)
        except subprocess.CalledProcessError:v={'LoadState':'not-found'}
        result.append({'name':name,'loaded':v.get('LoadState')=='loaded','active':v.get('ActiveState','unknown'),'enabled':v.get('UnitFileState','unknown')})
    return result

def overlap(a,b):return a==b or a in b.parents or b in a.parents

def mount_risks(paths,all_containers,project):
    problems=[]
    for c in all_containers:
        if (c['id'] in project if isinstance(project,set) else (c.get('labels') or {}).get('com.docker.compose.project')==project):continue
        for m in c.get('mounts',[]):
            source=m.get('Source')
            if source and any(overlap(Path(source),p) for p in paths):problems.append('其他容器仍引用此目录：'+c['name'].lstrip('/'))
    return sorted(set(problems))

def manifest(bot_id,path=None):
    slug=canonical(bot_id);root=DEPLOY/slug;trusted(DEPLOY);trusted(root)
    p=path or root/'deployment.json';s=p.lstat()
    if stat.S_ISLNK(s.st_mode) or s.st_uid!=0 or s.st_mode&0o022:raise ValueError('部署清单必须由root持有且不可被其他用户改写')
    m=json.loads(p.read_text())
    if m.get('bot_id')!=bot_id or m.get('deployment')!=str(root) or m.get('persist')!=str(PERSIST/slug):raise ValueError('部署清单与UUID或规范目录不一致')
    instance=m.get('runtime_instance_id');uuid.UUID(instance)
    return m

def journal_path(job_id):uuid.UUID(job_id);return STATE/(job_id+'.json')
def journal_for(bot_id):
    matches=[]
    if STATE.exists():
        for p in STATE.glob('*.json'):
            try:
                j=json.loads(p.read_text())
                if j.get('bot_id')==bot_id and j.get('action','quarantine')=='quarantine' and j.get('state') in {'quarantined','working'}:matches.append(j)
            except (ValueError,OSError):raise ValueError('清理进度不可读取，停止以免扩大范围')
    if len(matches)>1:raise ValueError('存在多份未结束的清理进度，需人工核对')
    return matches[0] if matches else None

def legacy_candidate_paths():
    return [(k,LEGACY_PERSIST/n) for k,ns in {'wechat':['wechat'],'maibot':['maibot'],'bridge':['bridge','limits','availability'],'identity':['groupdesk','secrets']}.items() for n in ns]+[('reader',LEGACY_READER/n) for n in ['config','secrets','client','data','key-import']]

def path_specs(bot_id):
    if bot_id==LEGACY:
        candidates=legacy_candidate_paths()
        profile=legacy_profile() if LEGACY_PROFILE.exists() else {}
        if 'approved_paths' not in profile:return candidates
        paths=[]
        for kind,value in profile['approved_paths']:
            p=Path(value)
            if (kind,p) not in candidates and not (kind=='wechat' and p.parent==LEGACY_PERSIST/'wechat' and p.name not in {'.','..','.groupdesk-quarantine'}):raise ValueError('旧部署路径超出固定范围')
            paths.append((kind,p))
        return paths
    slug=canonical(bot_id);root=PERSIST/slug
    return [(kind,root/name) for kind,names in CATEGORIES.items() for name in names]+[('deployment',DEPLOY/slug)]

def target(bot_id,all_containers=None):
    if bot_id==LEGACY:return legacy_target(all_containers)
    all_containers=[normalized_container(c) for c in (containers() if all_containers is None else all_containers)];slug=canonical(bot_id);project='gdbot-'+slug;j=journal_for(bot_id);blocked=[]
    meta_path=DEPLOY/slug/'deployment.json'
    if not meta_path.exists() and j:
        moved=next((x for x in j['paths'] if x['kind']=='deployment'),None)
        if moved:meta_path=Path(moved['quarantine'])/'deployment.json'
    try:m=manifest(bot_id,meta_path);instance=m['runtime_instance_id']
    except (OSError,ValueError,KeyError):
        cached=j.get('manifest') if j else None
        if cached and cached.get('bot_id')==bot_id and cached.get('deployment')==str(DEPLOY/slug) and cached.get('persist')==str(PERSIST/slug):m=cached;instance=cached['runtime_instance_id']
        else:m=None;instance=None;blocked.append('部署清单缺失、不可信或身份不匹配，不能清理')
    own=[c for c in all_containers if (c.get('labels') or {}).get('com.docker.compose.project')==project]
    if len(own)>50:blocked.append('容器数量异常')
    for c in own:
        if not set(c.get('networks',{}))<={project+'_bot',project+'_data'}:blocked.append('容器连接了非本机器人独立网络，保留待核对')
        labels=c['labels'] or {};service=labels.get('com.docker.compose.service')
        if service not in SERVICES or labels.get('com.docker.compose.project.working_dir')!=str(DEPLOY/slug):blocked.append('容器服务或部署目录不属于受支持的独立运行栈')
        for entry in c.get('mounts',[]):
            source=Path(entry.get('Source','/'))
            if entry.get('Type')!='bind' or not any(source==r or r in source.parents for r in [PERSIST/slug,DEPLOY/slug,Path('/run/groupdesk-onboarding')/bot_id]):blocked.append('容器包含规范目录外挂载或命名卷，保留待核对')
    nets=networks(project)
    ownids={c['id'] for c in own}
    for n in nets:
        if n['name'] not in {project+'_bot',project+'_data'} or any(x not in ownids for x in (n.get('containers') or {})):blocked.append('独立网络存在未知名称或其他容器引用')
    resources=[];struct=[]
    for kind,path in path_specs(bot_id):
        info=size_tree(path);risks=info['blocked']+mount_risks([path],all_containers,project)
        resources.append({'key':kind+':'+path.name,'kind':kind,'path':str(path),'bytes':info['bytes'],'estimated_reclaimable_bytes':info['allocated'],'blocked':risks,'present':existing(path) is not None})
        struct.append([kind,str(path),info['inode'],risks])
    resources.append({'key':'containers','kind':'containers','path':project,'bytes':None,'estimated_reclaimable_bytes':None,'blocked':blocked[:],'present':bool(own or nets)})
    unit_states=units(bot_id)
    shape={'bot_id':bot_id,'instance_id':instance,'paths':struct,'containers':[{k:c[k] for k in ['id','image','mounts','networks','restart']} for c in sorted(own,key=lambda c:c['id'])],'networks':nets,'units':unit_states}
    # Container-network endpoint maps contain counters but no private env values.
    fingerprint=digest(shape);q=None
    if j:
        qresources=[]
        for entry in j['paths']:
            path=Path(entry['quarantine']);info=size_tree(path);risks=info['blocked']+mount_risks([path,Path(entry['original'])],all_containers,project)
            qresources.append({'key':entry['kind']+':'+Path(entry['original']).name,'kind':entry['kind'],'path':str(path),'bytes':info['bytes'],'estimated_reclaimable_bytes':info['allocated'],'blocked':risks,'present':existing(path) is not None})
        q={'job_id':j['id'],'state':'quarantined','fingerprint':digest({'journal':j['id'],'phase':j['phase'],'paths':qresources,'containers':sorted(ownids),'networks':nets}), 'retain_until':j['retain_until'],'resources':qresources}
        # Only topology/ownership warnings block restoring or permanently purging.
        blocked+=list({r for x in qresources for r in x['blocked']})
    public={'bot_id':bot_id,'instance_id':instance,'fingerprint':fingerprint,'blocked':sorted(set(blocked)),'resources':resources,'containers':[{'id':c['id'],'name':c['name'].lstrip('/'),'running':c['running']} for c in own],'shared_images':sorted({c['image'] for c in own}),'quarantine':q}
    return public,{'manifest':m,'containers':own,'networks':nets,'units':unit_states,'journal':j}

def inventory(host):
    all_containers=containers();bots=[];legacy=[];warnings=[]
    if host=='rococo-root2':
        ids=set()
        for c in all_containers:
            project=(c.get('labels') or {}).get('com.docker.compose.project','')
            if re.fullmatch('gdbot-[a-f0-9]{32}',project):ids.add(str(uuid.UUID(project[6:])))
        if LEGACY_PROFILE.exists():ids.add(LEGACY)
        if DEPLOY.exists():
            for p in DEPLOY.iterdir():
                if re.fullmatch('[a-f0-9]{32}',p.name):ids.add(str(uuid.UUID(p.name)))
        if STATE.exists():
            for p in STATE.glob('*.json'):
                try:
                    j=json.loads(p.read_text())
                    if j.get('action','quarantine')=='quarantine' and j.get('state') in {'quarantined','working'}:ids.add(j['bot_id'])
                except (ValueError,OSError):warnings.append('存在不可读取的清理进度，保留待核对')
        for bot in sorted(ids)[:300]:
            try:b,_=target(bot,all_containers);bots.append(b)
            except (ValueError,OSError,subprocess.SubprocessError):warnings.append('有独立部署无法完整盘点，已保留')
        if PERSIST.exists():
            known={canonical(b['bot_id']) for b in bots if b['bot_id']!=LEGACY}
            for p in PERSIST.iterdir():
                if p.name not in known and p.name!='.quarantine':legacy.append(legacy_item(p,'unknown','缺少可信部署清单，仅盘点'))
    for root,kind in HOST_ROOTS[host]:
        p=Path(root)
        if not p.exists():continue
        if kind=='backup':
            for child in sorted(p.iterdir())[:500]:legacy.append(legacy_item(child,'backup','现有备份仅盘点，不随机器人清理'))
        else:legacy.append(legacy_item(p,kind,'旧兼容目录仅盘点，不自动清理'))
    usage=shutil.disk_usage('/opt')
    return {'contract':1,'host':host,'scanned_at':now(),'disk':{'total':usage.total,'free':usage.free},'bots':bots,'legacy':legacy[:1000],'warnings':warnings[:100]}

def legacy_item(p,kind,message):
    if p.is_dir() and not p.is_symlink():info=size_tree(p,protect_backups=False)
    else:
        s=p.lstat();info={'bytes':s.st_size,'allocated':s.st_blocks*512,'blocked':[]}
    return {'key':kind+':'+str(p),'kind':kind,'path':str(p),'bytes':info['bytes'],'estimated_reclaimable_bytes':None,'blocked':[message]+info['blocked'],'present':True}

def validate_permit(envelope,job,config,current):
    signature=hmac.new(config['permit_secret'].encode(),envelope['payload'].encode(),hashlib.sha256).hexdigest()
    if not hmac.compare_digest(signature,envelope['signature']):raise ValueError('执行许可签名无效')
    payload=json.loads(base64.urlsafe_b64decode(envelope['payload']+'='*((-len(envelope['payload']))%4)))
    for k,v in {'job_id':job['id'],'host':config['host'],'action':job['action'],'bot_id':job['bot_id'],'lease_token':job['lease_token'],'fingerprint':current}.items():
        if payload.get(k)!=v:raise ValueError('执行许可与当前任务不匹配')
    if not time.time()<payload['expires']<=time.time()+190:raise ValueError('执行许可已过期')
    if config['host']!='rococo-root2' or payload['action'] not in {'quarantine','purge','restore'}:raise ValueError('当前服务器只允许盘点')
    return payload

def stop_stack(context):
    for u in context['units']:
        if u['loaded']:run('systemctl','disable','--now',u['name'],timeout=100)
    for c in context['containers']:
        run('docker','update','--restart=no',c['id'])
        if c['running']:run('docker','stop','--time','75',c['id'],timeout=100)
    fresh=containers();ownids={c['id'] for c in context['containers']}
    if any(c['running'] for c in fresh if c['id'] in ownids):raise ValueError('容器尚未停止，未移动文件')

def perform(job,permit,config):
    bot_id=job['bot_id'];slug=slug_for(bot_id);path=journal_path(job['id']);lockpath=STATE/(slug+'.lock');STATE.mkdir(parents=True,exist_ok=True,mode=0o700)
    with lockpath.open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        prior=json.loads(path.read_text()) if path.exists() else None
        validate_permit(permit,job,config,job['plan_hash'])
        if prior and (prior.get('bot_id')!=bot_id or prior.get('action')!=job['action'] or prior.get('plan_hash')!=job['plan_hash']):raise ValueError('本地进度与任务不匹配')
        if prior and prior.get('state')=='completed':
            if prior.get('parent'):
                pp=journal_path(prior['parent']);pj=json.loads(pp.read_text());pj['state']=prior['receipt']['state'];pj['phase']=pj['state'];atomic(pp,pj)
            return prior['receipt']
        current,context=target(bot_id);q=current['quarantine'];fingerprint=q['fingerprint'] if job['action']!='quarantine' and q else current['fingerprint']
        if fingerprint!=job['plan_hash'] and not prior:raise ValueError('盘点后资源已变化，未执行清理')
        if current['blocked']:raise ValueError('资源存在身份、挂载或路径风险，已保留')
        payload=validate_permit(permit,job,config,job['plan_hash'])
        if 'deployment' in job['selection'] and 'containers' not in job['selection']:raise ValueError('清理部署文件必须一并选择容器，避免遗留不可恢复的运行栈')
        if payload['selection']!=job['selection'] or payload['parent_job_id']!=job.get('parent_job_id'):raise ValueError('执行范围不匹配')
        own_reference={c['id'] for c in context['containers']} if bot_id==LEGACY else 'gdbot-'+slug
        before=shutil.disk_usage('/opt').free
        if job['action']=='quarantine':
            if context['journal'] and context['journal']['id']!=job['id']:raise ValueError('已有未处理暂存任务')
            selected=[(kind,p) for kind,p in path_specs(bot_id) if kind in job['selection'] and existing(p)]
            for kind,p in selected:
                info=size_tree(p,allow_contained_links=bot_id==LEGACY)
                if info['blocked'] or mount_risks([p],containers(),own_reference):raise ValueError('所选目录不能安全暂存')
            if not prior:
                retain=(datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(days=job['retention_days'])).isoformat()
                paths=[]
                for kind,p in selected:
                    dest=quarantine_path(bot_id,kind,p,job['id'])
                    paths.append({'kind':kind,'original':str(p),'quarantine':str(dest),'inode':p.stat().st_ino})
                prior={'id':job['id'],'action':job['action'],'plan_hash':job['plan_hash'],'bot_id':bot_id,'state':'working','phase':'prepared','manifest':{k:context['manifest'][k] for k in ['bot_id','runtime_instance_id','deployment','persist']},'paths':paths,'selection':job['selection'],'retain_until':retain,'containers':[c['id'] for c in context['containers']],'networks':[n['id'] for n in context['networks']],'images':context.get('exclusive_images',[]) if 'images' in job['selection'] else []};atomic(path,prior)
            if {c['id'] for c in context['containers']}!=set(prior['containers']):raise ValueError('容器清单已变化，保留待核对')
            stop_stack(context);prior['phase']='stopped';atomic(path,prior)
            for entry in prior['paths']:
                source=Path(entry['original']);dest=Path(entry['quarantine'])
                if dest.exists() and not source.exists():
                    if dest.stat().st_ino!=entry['inode']:raise ValueError('目录身份已变化，停止以免覆盖或删除新数据')
                    continue
                trusted(source)
                if not source.exists() or source.stat().st_ino!=entry['inode'] or mount_risks([source],containers(),own_reference):raise ValueError('停止后目录归属已变化，保留进度')
                trusted(dest.parent);dest.parent.mkdir(parents=True,exist_ok=True,mode=0o700);source.rename(dest);atomic(path,prior)
            prior['phase']='quarantined';prior['state']='quarantined';atomic(path,prior)
            receipt={'state':'quarantined','retained_until':prior['retain_until'],'paths':len(prior['paths']),'bytes_released':0,'note':'已停止并隔离暂存，到期仅提示，未自动永久删除；共享镜像保留'}
        else:
            parent=context['journal']
            if not parent or parent['id']!=job.get('parent_job_id'):raise ValueError('暂存任务不匹配')
            parentpath=journal_path(parent['id']);prior=prior or {'id':job['id'],'action':job['action'],'plan_hash':job['plan_hash'],'bot_id':bot_id,'state':'working','phase':'prepared','parent':parent['id'],'paths':[]};atomic(path,prior)
            if not {c['id'] for c in context['containers']}<=set(parent['containers']):raise ValueError('出现新容器，未扩大清理范围')
            stop_stack(context)
            for entry in parent['paths']:
                source=Path(entry['quarantine']);dest=Path(entry['original']);trusted(source);trusted(dest.parent)
                expected=quarantine_path(bot_id,entry['kind'],dest,parent['id'])
                if source!=expected or (entry['kind'],dest) not in path_specs(bot_id):raise ValueError('暂存路径不属于本机器人')
                if mount_risks([source,dest],containers(),own_reference):raise ValueError('暂存目录被其他容器引用')
                if source.exists() and source.stat().st_ino!=entry['inode']:raise ValueError('暂存目录身份已变化，保留待核对')
                if job['action']=='restore':
                    if dest.exists() and not source.exists():
                        if dest.stat().st_ino!=entry['inode']:raise ValueError('目录身份已变化，停止以免覆盖或删除新数据')
                        continue
                    if dest.exists():raise ValueError('原目录已存在，不覆盖新数据')
                    dest.parent.mkdir(parents=True,exist_ok=True,mode=0o700);source.rename(dest)
                else:
                    if size_tree(source,allow_contained_links=bot_id==LEGACY)['blocked']:raise ValueError('暂存目录出现异常，未永久清理')
                    shutil.rmtree(source,ignore_errors=False) if source.exists() else None
            if job['action']=='purge' and 'containers' in parent['selection']:
                present_ids={c['id'] for c in containers()}
                for cid in parent['containers']:
                    if cid in present_ids:run('docker','rm',cid)
                present_networks={n['id'] for n in (legacy_networks() if bot_id==LEGACY else networks('gdbot-'+slug))}
                for nid in parent['networks']:
                    if nid not in present_networks:continue
                    try:run('docker','network','rm',nid)
                    except subprocess.CalledProcessError:raise ValueError('独立网络仍有引用，保留并提示核对')
            if job['action']=='purge' and 'images' in parent['selection']:
                for image in parent.get('images',[]):
                    if any(c['image']==image for c in containers()):continue
                    try:run('docker','image','rm',image)
                    except subprocess.CalledProcessError:pass # Dependencies/tags retain the image; never force.
            parent['state']='purged' if job['action']=='purge' else 'restored';parent['phase']=parent['state']
            receipt={'state':parent['state'],'paths':len(parent['paths']),'disk_free_change':shutil.disk_usage('/opt').free-before,'note':'永久清理已完成；共享或有依赖的镜像和现有备份保留' if job['action']=='purge' else '目录已还原；容器和自动启动仍停用，不恢复已删除登记'}
            prior['state']='completed';prior['receipt']=receipt;atomic(path,prior);atomic(parentpath,parent)
        return receipt

def quarantine_path(bot_id,kind,original,job_id):
    if bot_id==LEGACY:
        root=LEGACY_READER if kind=='reader' else LEGACY_PERSIST
        return root/'.groupdesk-quarantine'/slug_for(bot_id)/job_id/kind/original.name
    return (QDEPLOY if kind=='deployment' else QDATA)/canonical(bot_id)/job_id/kind/original.name

def unit_fingerprint(name):
    props=dict(line.split('=',1) for line in run('systemctl','show',name,'--property=FragmentPath,DropInPaths').splitlines() if '=' in line)
    files=[]
    for value in [props.get('FragmentPath',''),*props.get('DropInPaths','').split()]:
        if not value:continue
        path=Path(value)
        if not any(root==path or root in path.parents for root in [Path('/etc/systemd/system'),Path('/usr/lib/systemd/system'),Path('/lib/systemd/system')]):raise ValueError('服务定义路径异常')
        files.append([str(path),hashlib.sha256(path.read_bytes()).hexdigest()])
    return digest(files)

def legacy_profile():
    trusted(LEGACY_PROFILE.parent);s=LEGACY_PROFILE.lstat()
    if not stat.S_ISREG(s.st_mode) or s.st_uid!=0 or s.st_mode&0o077:raise ValueError('旧部署须受信登记后才能处理')
    p=json.loads(LEGACY_PROFILE.read_text())
    if p.get('bot_id')!=LEGACY or p.get('profile')!='legacy-ryubuddy-v1':raise ValueError('旧部署身份无效')
    uuid.UUID(p['instance_id']);p['containers']=[normalized_container(c) for c in p['containers']];return p

def legacy_networks():
    result=[]
    for n in legacy_profile()['networks']:
        try:
            fmt='{"id":{{json .Id}},"name":{{json .Name}},"labels":{{json .Labels}},"containers":{{json .Containers}}}'
            v=json.loads(run('docker','network','inspect','--format',fmt,n['id']))
            if v['name']!=n['name']:raise ValueError('旧网络身份变化')
            result.append(v)
        except subprocess.CalledProcessError:pass
    return sorted(result,key=lambda n:n['id'])

def legacy_target(all_containers=None):
    p=legacy_profile();rows=[normalized_container(c) for c in (containers() if all_containers is None else all_containers)];own=[];blocked=[];j=journal_for(LEGACY)
    pins={c['id']:c for c in p['containers']};names={c['name'] for c in p['containers']}
    for c in rows:
        if c['name'] in names and c['id'] not in pins:blocked.append('旧账号容器已被替换，须重新核验登记')
        if c['id'] in pins:
            pin=pins[c['id']]
            if any(c[k]!=pin[k] for k in ['name','image','labels','mounts']):blocked.append('旧账号容器身份或挂载已变化')
            own.append(c)
    own.sort(key=lambda c:c['id']);refs={c['id'] for c in own};nets=legacy_networks()
    if any(cid not in refs for n in nets for cid in (n.get('containers') or {})):blocked.append('旧网络被其他容器引用，保留')
    allowed_networks={n['name'] for n in p['networks']}
    if any(not set(c['networks'])<=allowed_networks for c in own):blocked.append('旧容器新增未知网络，保留')
    unit_states=units(LEGACY)
    for u in unit_states:
        if u['loaded']:
            definition=unit_fingerprint(u['name'])
            if definition!=p['units'].get(u['name']):blocked.append('旧自动启动服务定义已变化，保留')
    resources=[];shape=[]
    for kind,path in path_specs(LEGACY):
        info=size_tree(path,allow_contained_links=True);risks=info['blocked']+mount_risks([path],rows,refs)
        resources.append({'key':kind+':'+str(path),'kind':kind,'path':str(path),'bytes':info['bytes'],'estimated_reclaimable_bytes':info['allocated'],'blocked':risks,'present':existing(path) is not None});shape.append([str(path),info['inode'],risks])
    for excluded in p.get('excluded_paths',[]):
        resources.append({'key':'retained:'+excluded['path'],'kind':'retained','path':excluded['path'],'bytes':None,'estimated_reclaimable_bytes':None,'blocked':[excluded['reason']],'present':True})
    resources.append({'key':'containers','kind':'containers','path':'RyuBuddy:4-pinned-containers','bytes':None,'estimated_reclaimable_bytes':None,'blocked':blocked[:],'present':bool(own or nets)})
    exclusive=[];shared=[]
    for img in sorted({c['image'] for c in p['containers']}):
        try:run('docker','image','inspect','--format','{{.Id}}',img)
        except subprocess.CalledProcessError:continue
        if any(c['image']==img and c['id'] not in pins for c in rows):shared.append(img)
        else:exclusive.append(img)
    resources.append({'key':'images','kind':'images','path':'RyuBuddy:unshared-pinned-images','bytes':None,'estimated_reclaimable_bytes':None,'blocked':[],'present':bool(exclusive)})
    fp=digest({'profile':p,'paths':shape,'containers':own,'networks':nets,'units':unit_states,'exclusive_images':exclusive});q=None
    if j:
        qr=[]
        for e in j['paths']:
            path=Path(e['quarantine']);info=size_tree(path,allow_contained_links=True);risks=info['blocked']+mount_risks([path,Path(e['original'])],rows,refs)
            qr.append({'key':e['kind']+':'+str(path),'kind':e['kind'],'path':str(path),'bytes':info['bytes'],'estimated_reclaimable_bytes':info['allocated'],'blocked':risks,'present':existing(path) is not None})
        q={'job_id':j['id'],'state':'quarantined','fingerprint':digest({'journal':j['id'],'phase':j['phase'],'paths':qr,'containers':sorted(refs),'networks':nets}),'retain_until':j['retain_until'],'resources':qr};blocked+=list({r for v in qr for r in v['blocked']})
    public={'profile':'legacy-ryubuddy-v1','bot_id':LEGACY,'instance_id':p['instance_id'],'fingerprint':fp,'blocked':sorted(set(blocked)),'resources':resources,'containers':[{'id':c['id'],'name':c['name'].lstrip('/'),'running':c['running']} for c in own],'shared_images':shared,'quarantine':q}
    return public,{'manifest':{'bot_id':LEGACY,'runtime_instance_id':p['instance_id'],'deployment':'/opt/docker/oc-projects/maibot-wechat','persist':str(LEGACY_PERSIST)},'containers':own,'networks':nets,'units':unit_states,'journal':j,'exclusive_images':exclusive}

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,req,fp,code,msg,headers,newurl):return None

class Client:
    def __init__(self,config):self.config=config
    def post(self,endpoint,body):
        req=urllib.request.Request(self.config['url'].rstrip('/')+'/api/runtime-maintenance-agent/'+endpoint,data=json.dumps(body).encode(),method='POST',headers={'Content-Type':'application/json','Authorization':'Bearer '+self.config['token']})
        with urllib.request.build_opener(NoRedirect()).open(req,timeout=30) as r:return json.loads(r.read(1500000))
    def once(self):
        claimed=self.post('claim',{})['job']
        if not claimed:return False
        try:
            if claimed['action']=='scan':report=inventory(self.config['host']);receipt={'state':'inventoried','version':VERSION}
            else:
                local=journal_path(claimed['id']);saved=json.loads(local.read_text()) if local.exists() else None
                if saved and saved.get('plan_hash')==claimed['plan_hash'] and saved.get('bot_id')==claimed['bot_id']:fp=claimed['plan_hash']
                else:
                    current,_=target(claimed['bot_id']);fp=current['quarantine']['fingerprint'] if claimed['action']!='quarantine' and current['quarantine'] else current['fingerprint']
                permit=self.post('authorize',{'id':claimed['id'],'lease_token':claimed['lease_token'],'fingerprint':fp})
                receipt=perform(claimed,permit,self.config);report=inventory(self.config['host'])
            self.post('result',{'id':claimed['id'],'lease_token':claimed['lease_token'],'ok':True,'receipt':receipt,'inventory':report})
        except Exception:
            # Do not echo raw exceptions, HTTP bodies, env or credential paths.
            self.post('result',{'id':claimed['id'],'lease_token':claimed['lease_token'],'ok':False,'error':'执行未完成，进度保留；请重新盘点并核对路径、挂载和权限'})
        return True

def main():
    p=argparse.ArgumentParser();p.add_argument('action',choices=['serve','inventory']);p.add_argument('--config',type=Path,required=True);args=p.parse_args()
    c=json.loads(args.config.read_text())
    if c['host'] not in HOST_ROOTS or c['url']!='https://groupdesk.rococo.dev':raise ValueError('Use a registered HTTPS control plane')
    if args.action=='inventory':print(json.dumps(inventory(c['host']),ensure_ascii=False));return
    client=Client(c)
    while True:
        try:worked=client.once()
        except Exception:worked=False;print('runtime_maintenance_retry',flush=True)
        time.sleep(2 if worked else 30)

if __name__=='__main__':main()
