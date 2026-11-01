"""GroupDesk contract v1 for MaiBot: literal policy data, leases and scoped state.

Connection/token/group bindings are private server files, never repository data.
"""
from pathlib import Path
from functools import lru_cache
import json,re,time,unicodedata,urllib.request,urllib.parse,os,hashlib

CONNECTION=Path(os.environ.get('GROUPDESK_CONNECTION','/groupdesk/connection.json'))
SNAPSHOT=Path(os.environ.get('GROUPDESK_SNAPSHOT','/limits-state/groupdesk-policy.json'))

@lru_cache(maxsize=8192)
def pattern(term):
    body=r'[\s\-\u2010-\u2015]+'.join(re.escape(p) for p in re.split(r'[\s\-\u2010-\u2015]+',term.strip()))
    return re.compile((r'(?<![A-Za-z0-9_])' if re.match('[A-Za-z0-9_]',term) else '')+body+(r'(?![A-Za-z0-9_])' if re.search('[A-Za-z0-9_]$',term) else ''),re.I)

def has(text,terms):return any(pattern(term).search(text) for term in terms)

def authored(text):
    text=unicodedata.normalize('NFKC',str(text))
    text=re.sub(r'https?://\S+','',text,flags=re.I);text=re.sub(r'```.*?(?:```|$)','',text,flags=re.S)
    lines=[]
    for line in text.splitlines():
        if re.match(r'^\s*引用\s+.+?\s*的消息\s*[:：]',line):break
        if not line.lstrip().startswith('>'):lines.append(line)
    text='\n'.join(lines).strip()
    if re.fullmatch(r'[“\"「].*[”\"」]',text,flags=re.S):return ''
    return re.sub(r'@[^\s,，:：]+\s*','',text).strip()[:2000]

def direct_signal(policy,text):
    text=authored(text)
    for term in policy.get('exclusions',[]):text=pattern(term).sub(' ',text)
    if len(text)<2 or has(text,policy.get('hard_exit_terms',[])):return '',text
    if has(text,[w for words in policy.get('lexicons',{}).values() for w in words]):return 'explicit',text
    if any(all(has(text,g) for g in c['all']) for c in policy.get('combinations',[])):return 'combination',text
    return '',text

def profile(config,chat):return config.get('managed_groups',{}).get(str(chat))
def available(p,now):return bool(p and p.get('enabled') and p.get('valid_until',0)>now)
def revision(p):return str(p.get('revision','')) if p else ''
def topics(config,chat,text):
    p=profile(config,chat)
    return [t['name'] for t in p.get('topics',[]) if direct_signal(t['policy'],text)[0]] if p else []

def load_profiles():
    if not CONNECTION.exists():return None
    conf=json.loads(CONNECTION.read_text());groups={str(k):{'enabled':False,'valid_until':0,'revision':''} for k in conf['groups']}
    try:
        saved=json.loads(SNAPSHOT.read_text()).get('groups',{})
        for chat in groups:
            if chat in saved:groups[chat]=saved[chat]
    except (OSError,ValueError,TypeError):pass
    return groups

def validate_persona_bundle(bundle):
    selected=bundle.get('persona_version_id')
    skill=bundle.get('persona_skill')
    if not selected:
        if skill is not None:raise ValueError('Unexpected published persona')
        return None
    if bundle.get('persona_contract_version')!=1 or not isinstance(skill,dict):raise ValueError('Unknown persona contract')
    text=skill.get('skill_md')
    if skill.get('version_id')!=selected or not isinstance(text,str) or not 30<=len(text)<=30000:raise ValueError('Invalid published persona')
    if hashlib.sha256(text.encode()).hexdigest()!=skill.get('sha256'):raise ValueError('Published persona digest mismatch')
    return skill

def validate_bundle(bundle,external_id):
    validate_persona_bundle(bundle)
    from interactions_runtime import validate_bundle as validate_interactions
    validate_interactions(bundle)
    from timeout_policy import validate as validate_timeouts
    contract=bundle.get('timeout_policy_contract_version')
    if contract not in [None,1,2]:raise ValueError('Unknown timeout policy contract')
    if contract in [1,2]:validate_timeouts(bundle.get('policy',{}).get('timeouts'),require_apology=contract==2)
    elif 'timeouts' in bundle.get('policy',{}):validate_timeouts(bundle['policy']['timeouts'])
    if bundle.get('policy_contract_version')!=1 or bundle.get('external_id')!=external_id:raise ValueError('GroupDesk contract/group mismatch')
    if bundle.get('model_routing_contract_version') not in [None,1]:raise ValueError('Unknown model routing contract')
    if bundle.get('policy',{}).get('persona') not in ['gt-persona','neutral']:raise ValueError('Unsupported persona')
    identity=bundle.get('policy',{}).get('identity',{'disclosure':'when_asked','personal_questions':'tactful'})
    if identity.get('disclosure') not in ['when_asked','proactive','roleplay'] or identity.get('personal_questions') not in ['tactful','plain']:raise ValueError('Unsupported identity policy')
    instructions=bundle.get('identity_instructions',[])
    if not isinstance(instructions,list) or len(instructions)>10 or any(not isinstance(v,str) or len(v)>2000 for v in instructions):raise ValueError('Invalid identity instructions')
    if len(bundle.get('topics',[]))>100:raise ValueError('Too many topics')
    for t in bundle['topics']:
        p=t['policy'];words=[w for v in p.get('lexicons',{}).values() for w in v]
        for c in p.get('combinations',[]):words += [w for g in c['all'] for w in g]
        for field in ['exclusions','continuations','continuation_exclusions','exit_terms','hard_exit_terms']:words+=p.get(field,[])
        if len(words)>12000 or any(not isinstance(w,str) or not 1<=len(w)<=128 for w in words):raise ValueError('Invalid literal policy terms')
        c=p.get('context',{});
        if c.get('enabled') and not (1<=c['seconds']<=180 and 1<=c['max_intervening_messages']<=3 and 1<=c['anchor_chars']<=400):raise ValueError('Invalid context bounds')

def api(path,body=None):
    conf=json.loads(CONNECTION.read_text());base=conf['url'].rstrip('/')
    if not base.startswith('https://'):raise ValueError('GroupDesk requires HTTPS')
    request=urllib.request.Request(base+'/api/runtime'+path,data=json.dumps(body,ensure_ascii=False).encode() if body is not None else None,headers={'Authorization':'Bearer '+conf['token'],'Content-Type':'application/json'})
    with urllib.request.urlopen(request,timeout=8) as response:return json.load(response)

def sync():
    if not CONNECTION.exists():return None
    conf=json.loads(CONNECTION.read_text());groups={};acks=[]
    for chat,external in conf['groups'].items():
        try:
            b=api('/config/'+urllib.parse.quote(external,safe=''));validate_bundle(b,external)
            if b.get('model_routing_contract_version')==1 and b.get('model_routing',{}).get('text',{}).get('available'):
                private=api('/model-credentials',{'group_id':b['id'],'revision':b['revision']})['text_route']
                from model_routing import validate_private_route
                validate_private_route(b,private);b['private_text_route']=private
            groups[str(chat)]={**b,'valid_until':time.time()+75}
            acks.append((str(chat),b['id'],b['revision']))
        except Exception:groups[str(chat)]={'enabled':False,'valid_until':0,'revision':'unavailable'}
    SNAPSHOT.parent.mkdir(parents=True,exist_ok=True)
    def save():
        temp=SNAPSHOT.with_suffix('.tmp');temp.write_text(json.dumps({'groups':groups},ensure_ascii=False));temp.chmod(0o600);temp.replace(SNAPSHOT)
    save()
    for chat,group_id,rev in acks:
        try:api('/ack',{'group_id':group_id,'revision':rev,'timeout_policy_version':groups[chat].get('timeout_policy_contract_version',1),'model_routing_version':1,'persona_skill_version':1,'interactions_policy_version':1,**({'persona_skill_sha256':groups[chat]['persona_skill']['sha256']} if groups[chat].get('persona_skill') else {})})
        except Exception:groups[chat]['enabled']=False;groups[chat]['valid_until']=0
    save();return {chat:{'revision':p.get('revision'),'enabled':p.get('enabled')} for chat,p in groups.items()}

def init_db(db):
    db.execute('CREATE TABLE IF NOT EXISTS managed_topic_context(chat_id TEXT,topic_key TEXT,seq INTEGER,ts REAL,text TEXT,unrelated INTEGER,PRIMARY KEY(chat_id,topic_key))')
    db.execute('CREATE TABLE IF NOT EXISTS managed_topic_classifications(seq INTEGER,topic_key TEXT,chat_id TEXT,ts REAL,reason TEXT,PRIMARY KEY(seq,topic_key))')

def classify(db,config,chat,seq,text,display,now,timestamp=None):
    p=profile(config,chat);matches=[];anchors={}
    db.execute('DELETE FROM managed_topic_context WHERE ts<?',(now-180,))
    signals={t['id']:direct_signal(t['policy'],text) for t in p.get('topics',[])}
    strong={key for key,(reason,_) in signals.items() if reason}
    for t in p.get('topics',[]):
        key=t['id'];rule=t['policy'];reason,visible=signals[key];c=rule.get('context',{});state=db.execute('SELECT * FROM managed_topic_context WHERE chat_id=? AND topic_key=?',(chat,key)).fetchone()
        if reason:
            matches.append(t['name'])
            if c.get('enabled'):db.execute('INSERT OR REPLACE INTO managed_topic_context VALUES (?,?,?,?,?,0)',(chat,key,seq,min(now,timestamp) if timestamp else now,(display+': '+visible)[:c['anchor_chars']]))
        elif has(visible,rule.get('exit_terms',[])) or strong:
            db.execute('DELETE FROM managed_topic_context WHERE chat_id=? AND topic_key=?',(chat,key));reason='topic_changed'
        elif state and c.get('enabled') and now-state['ts']<c['seconds'] and state['unrelated']<c['max_intervening_messages'] and not has(visible,rule.get('continuation_exclusions',[])) and has(visible,rule.get('continuations',[])):
            matches.append(t['name']);anchors[key]=state['seq'];reason='context'
        else:
            reason='none'
            if state:
                db.execute('UPDATE managed_topic_context SET unrelated=unrelated+1 WHERE chat_id=? AND topic_key=?',(chat,key))
                db.execute('DELETE FROM managed_topic_context WHERE chat_id=? AND topic_key=? AND (unrelated>=? OR ts<=?)',(chat,key,c.get('max_intervening_messages',3),now-c.get('seconds',180)))
        db.execute('INSERT OR REPLACE INTO managed_topic_classifications VALUES (?,?,?,?,?)',(seq,key,chat,now,reason))
    db.execute('DELETE FROM managed_topic_classifications WHERE rowid NOT IN (SELECT rowid FROM managed_topic_classifications ORDER BY ts DESC,rowid DESC LIMIT 2000)')
    return matches,anchors

def anchor_background(db,p,chat,refs,now):
    result=[]
    for key,seq in refs.items():
        t=next((t for t in p['topics'] if t['id']==key),None)
        if not t:continue
        c=t['policy']['context'];r=db.execute('SELECT * FROM managed_topic_context WHERE chat_id=? AND topic_key=? AND seq=? AND ts>? AND unrelated<?',(chat,key,seq,now-c['seconds'],c['max_intervening_messages'])).fetchone()
        if r:result.append((t['name'],r['text']))
    return result

def generation_rules(p,names=(),short=False):
    policy=p['policy'];lang=policy['language'];pieces=[p.get('participation_skill','')]
    pieces.append('本群话题范围='+policy['topic_scope']+'；参与程度='+policy['participation']+'。')
    if policy['topic_scope']=='all':pieces.append('点名也只回答已选话题；其他请求简短说明范围。')
    else:pieces.append('主动插话按已选话题及启用的基础提问/社交；明确点名可回答其他一般问题。')
    pieces.append('输出语言策略：'+json.dumps(lang,ensure_ascii=False)+'。follow跟随当前成员；restricted仅使用allowed，其他语言回退fallback；fixed默认使用fixed。用户指定语言仅在allow_requested且允许范围内有效。不将昵称、代码、引用当作原消息主语言。')
    pieces.append('所选话题范围：'+ '、'.join(t['name'] for t in p['topics']))
    identity=policy.get('identity',{'disclosure':'when_asked','personal_questions':'tactful'})
    boundary='已知情的虚构Cosplay，角色内保持设定；明确跳出角色确认系统身份时如实说明AI身份，不冒充GT真人。' if identity['disclosure']=='roleplay' else '直接问是否AI、机器人或真人时简短如实回答；不能否认AI或冒充GT真人。'
    pieces.append('身份策略：'+json.dumps(identity,ensure_ascii=False)+'。'+boundary)
    if p.get('identity_instructions'):
        pieces.extend(p['identity_instructions'])
    elif identity['disclosure']=='roleplay':
        pieces.append('参与者知道是AI虚构角色：不主动跳出角色，籍贯、性别或角色内机器人玩笑按当前persona接话；明确要求退出或角色外身份确认时如实说明。遵守群语言、话题与知识权限。')
    else:
        pieces.append('首次交流或容易误解时简短主动说明AI身份，不每条重复。' if identity['disclosure']=='proactive' else '日常不主动介绍AI身份，不用固定自我介绍开场。')
        pieces.append('一般籍贯、性别问题直接说明没有真人籍贯或生理性别，不编造个人经历。' if identity['personal_questions']=='plain' else '一般籍贯、性别问题按当前persona礼貌带过，不虚构真人背景。')
    if not short:pieces.append('本轮话题指导：'+json.dumps([{'name':t['name'],'description':t['description'],'instructions':t['instructions'],'reply_depth':t['policy']['reply_depth']} for t in p['topics'] if t['name'] in names],ensure_ascii=False))
    if not short:
        from interactions_runtime import guide
        pieces.append(guide(p))
    return '\n'.join(pieces)

def check_remote_revision(p):
    fresh=api('/config/'+urllib.parse.quote(p['external_id'],safe=''))
    return fresh.get('enabled') and fresh.get('revision')==p['revision']

def context_for(turn,p):
    out=api('/context',{'user_id':'ui-'+hashlib.sha256(turn['sender'].encode()).hexdigest()[:24],'channel':'group','group_external_id':p['external_id'],'mentioned':bool(turn['explicit']),'query':turn['text'][:500]})
    if out['group']['revision']!=p['revision']:raise ValueError('GroupDesk revision changed')
    sources='\n'.join('['+s['title']+' / '+s['document_id']+'] '+s['content'] for s in out.get('sources',[]))[:1400]
    return sources

def language_allowed(p,text):
    """Reject clear language mismatches; short names/code/quotes aren't language evidence."""
    l=p['policy']['language'];allowed=l.get('allowed',[])
    if l['mode']=='follow' or not allowed:return True
    text=re.sub(r'```.*?```|`[^`]*`|[“\"][^”\"]*[”\"]','',text,flags=re.S)
    letters=[c for c in text if c.isalpha()]
    if not letters:return True
    scripts=[('ja',r'[\u3040-\u30ff]'),('ko',r'[\uac00-\ud7af]'),('ar',r'[\u0600-\u06ff]'),('ru',r'[\u0400-\u04ff]'),('th',r'[\u0e00-\u0e7f]')]
    for code,pat in scripts:
        if len(re.findall(pat,text))/len(letters)>.15 and code not in allowed:return False
    if len(re.findall(r'[\u4e00-\u9fff]',text))/len(letters)>.25 and not any(c in allowed for c in ['zh-CN','zh-TW','ja']):return False
    tokens=set(re.findall(r'[a-zà-ÿ]+',text.lower()))
    dictionaries={'en':{'the','is','are','you','your','this','that','and','with','have','hello'},'fr':{'bonjour','je','suis','vous','avec','pour','une','des','est','merci'},'es':{'hola','gracias','usted','para','una','los','estoy','con','muy'},'de':{'hallo','danke','ich','ist','sind','mit','und','nicht','eine'},'it':{'ciao','grazie','sono','della','con','per','una','buongiorno'},'pt':{'olá','obrigado','você','não','uma','para','com','muito'}}
    scores={lang:len(tokens&words) for lang,words in dictionaries.items()};best=max(scores,key=scores.get)
    if scores[best]>=3 and scores[best]>=max([v for k,v in scores.items() if k!=best],default=0)+2 and best not in allowed:return False
    return True
