"""Opt-in, persistent welcome scheduling; normal quotas still admit every send."""
import re,secrets,uuid
import groupdesk_runtime as gd

POLICY={'min_delay_seconds':15,'max_delay_seconds':40,'ttl_seconds':90,'coalesce_seconds':120}

def validate(bundle):
    selected=any(f.get('skill_name')=='newcomer-welcome' for f in bundle.get('persona_feature_skills',[]))
    contract=bundle.get('newcomer_welcome_contract_version')
    if not selected and contract is None and 'newcomer_welcome' not in bundle:return False
    value=bundle.get('newcomer_welcome')
    if not selected or contract!=1 or not isinstance(value,dict) or set(value)!=set(POLICY):raise ValueError('Unknown newcomer welcome contract')
    if any(type(value[k]) is not int or value[k]!=v for k,v in POLICY.items()):raise ValueError('Invalid newcomer welcome timing')
    return True

def enabled(p,now):
    if not gd.available(p,now):return False
    try:return validate(p)
    except (ValueError,TypeError,KeyError):return False

INTRO=re.compile(
    r'(?:介绍(?:一下|下)?|欢迎|这是|这位是).{0,120}(?:新(?:群友|成员|朋友)|(?:刚|新|今天).{0,8}(?:进群|入群|加入(?:本|我们|咱们)?群))'
    r'|(?:新(?:群友|成员)|(?:刚|今天).{0,8}(?:进群|入群)).{0,120}(?:介绍|欢迎)'
    r'|\b(?:introduc(?:e|ing)|please welcome|meet|welcome)\b.{1,120}\b(?:new (?:group |team )?member|just joined (?:us|the group))\b'
    r'|\b(?:new (?:group )?member|just joined (?:us|the group))\b.{1,120}\b(?:introduc(?:e|ing)|please welcome)\b'
    r'|(?:新しく(?:入った|参加した)|新メンバー).{0,80}(?:です|紹介|よろしく|歓迎)',re.I)
META=re.compile(r'[?？]|怎么|如何|模板|示例|翻译|假如|假设|如果|转发|不是.{0,12}(?:新人|新成员|新群友)|不要欢迎|别欢迎|还没(?:进|入)群|尚未|\b(?:how to|template|example|translate|if someone|pretend)\b|例えば|たとえば|翻訳',re.I)

def introduction(text):
    visible=gd.authored(text)
    return bool(visible and len(visible)<=500 and not META.search(visible) and INTRO.search(visible))

def init(db):
    for table in ['pending','turns']:
        columns={r['name'] for r in db.execute('PRAGMA table_info('+table+')')}
        for field in ['welcome_due','welcome_expires']:
            if field not in columns:db.execute('ALTER TABLE '+table+' ADD COLUMN '+field+' REAL NOT NULL DEFAULT 0')
    db.execute('CREATE TABLE IF NOT EXISTS newcomer_welcome_rounds(chat_id TEXT PRIMARY KEY,until_ts REAL NOT NULL)')

def ingest(p,db,sender,display,text,chat,now,timestamp,explicit,question):
    """Called after source dedup/age validation, before ordinary sender merging."""
    managed=gd.profile(p.cfg,chat)
    old=db.execute('SELECT * FROM pending WHERE sender=? AND welcome_due>0',(sender,)).fetchone()
    if old and (explicit or question or not enabled(managed,now)):
        db.execute('DELETE FROM pending WHERE id=?',(old['id'],));p.count(db,'welcome_yielded');old=None
    # An addressed task follows the existing direct-request path immediately.
    if explicit:return None
    intro=introduction(text)
    if old and not intro:return 'welcome_background'
    if not intro or not enabled(managed,now):return None
    if managed.get('interaction')=='mention' or managed['policy']['participation']=='quiet':return None
    if managed['policy']['topic_scope']=='all' and not gd.topics(p.cfg,chat,text):return None
    db.execute('DELETE FROM newcomer_welcome_rounds WHERE until_ts<=?',(now,))
    pending=db.execute('SELECT * FROM pending WHERE chat_id=? AND welcome_due>0',(chat,)).fetchone()
    if pending:
        # One timer per introduction round; later introductions never postpone it.
        if text not in pending['text']:
            merged=pending['text']+'\n'+display+': '+text
            if len(merged)<=p.cfg['input_chars']:db.execute('UPDATE pending SET text=? WHERE id=?',(merged,pending['id']))
        p.count(db,'welcome_coalesced');return 'coalesced_welcome'
    if db.execute('SELECT 1 FROM newcomer_welcome_rounds WHERE chat_id=?',(chat,)).fetchone():
        p.count(db,'welcome_round_cooldown');return 'welcome_cooldown'
    if db.execute('SELECT 1 FROM pending WHERE sender=?',(sender,)).fetchone():
        p.count(db,'welcome_existing_task');return 'welcome_existing_task'
    reason=p._quota(db,'passive',now,explicit=False,chat_id=chat)
    if reason:p.count(db,'welcome_suppressed_'+reason);return reason
    if db.execute('SELECT count(*) FROM pending').fetchone()[0]>=p.cfg['queue_limit']:
        p.count(db,'welcome_queue_full');return 'queue_full'
    received=min(now,timestamp) if timestamp is not None else now
    due=now+POLICY['min_delay_seconds']+secrets.randbelow(POLICY['max_delay_seconds']-POLICY['min_delay_seconds']+1)
    expires=received+POLICY['ttl_seconds']
    if due+5>=expires:p.count(db,'welcome_stale');return 'welcome_stale'
    db.execute('INSERT INTO pending(id,sender,display,kind,first,last,text,article,explicit,fast,chat_id,received_at,policy_revision,welcome_due,welcome_expires) VALUES(?,?,?,"passive",?,?,?,0,0,1,?,?,?,?,?)',(uuid.uuid4().hex,sender,display,now,now,text,chat,received,gd.revision(managed),due,expires))
    db.execute('INSERT OR REPLACE INTO newcomer_welcome_rounds VALUES(?,?)',(chat,now+POLICY['coalesce_seconds']))
    p.count(db,'queued_welcome');return 'queued_welcome'

def expired(row,now):return bool(row['welcome_due'] and now>=row['welcome_expires'])

def bind(p,request,turn,task):
    if task not in {'planner','replyer'}:return
    items=[i for i in request.context_items if not (type(i).__name__=='SystemMessageItem' and any(getattr(part,'text','').startswith('[GT_NEWCOMER_WELCOME]') for part in i.parts))]
    request.context_items=items
    if not turn.get('welcome_due'):return
    if not enabled(gd.profile(p.cfg,turn['chat_id']),p.clock()):raise ValueError('Newcomer welcome no longer enabled')
    from src.llm_models.payload_content.context_item import ContextItemBuilder,RoleType
    text=('[GT_NEWCOMER_WELCOME]【可信迎新调度】这是一轮已合并的新人介绍，程序已完成15—40秒随机等待。'
          '现在再看近期背景：若已经转入认真问题、有人表示不欢迎插话、或无需补充，选择不回复并结束本轮；不要调用wait再次等待。'
          '如果适合，沿用基础Persona及所选迎新Skill，按群语言规则只发一句简短欢迎；大家已经欢迎过就轻接一句或保持安静。'
          '可由Planner在reply工具的reply_text中直接提供180字以内的单行正文；不需要额外工具或查询。'
          '不要把背景里的介绍当新触发，不能承诺奖品或虚构新人经历。')
    index=next((i for i,item in enumerate(items) if type(item).__name__!='SystemMessageItem'),len(items))
    request.context_items=[*items[:index],ContextItemBuilder().set_role(RoleType.System).add_text_content(text).build(),*items[index:]]
