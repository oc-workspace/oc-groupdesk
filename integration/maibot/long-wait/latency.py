"""Bound long direct turns and attach a wait apology at the real send boundary."""
import hashlib,json,re

def init(db):
    for table,column in [('pending','first'),('turns','created')]:
        cols={r['name'] for r in db.execute('PRAGMA table_info('+table+')')}
        if 'received_at' not in cols:
            db.execute('ALTER TABLE '+table+' ADD COLUMN received_at REAL NOT NULL DEFAULT 0')
            db.execute('UPDATE '+table+' SET received_at='+column)
    if 'wait_apology' not in {r['name'] for r in db.execute('PRAGMA table_info(turns)')}:
        db.execute('ALTER TABLE turns ADD COLUMN wait_apology TEXT NOT NULL DEFAULT ""')
    db.execute('CREATE TABLE IF NOT EXISTS latency_deliveries(send_id TEXT PRIMARY KEY,turn_id TEXT NOT NULL,received_at REAL NOT NULL,submitted_at REAL NOT NULL,elapsed_seconds REAL NOT NULL,late INTEGER NOT NULL,apology_source TEXT NOT NULL,apology_sha256 TEXT)')

def direct_ttl(p,chat=''):
    from timeout_policy import for_group
    return for_group(p.cfg,chat)['direct_ttl_seconds']

def expire_pending(p,db,now):
    expired=[]
    for row in db.execute('SELECT id,kind,chat_id,received_at,first FROM pending'):
        until=(row['received_at'] or row['first'])+direct_ttl(p,row['chat_id']) if row['kind']=='direct' else row['first']+p.cfg['queue_ttl_seconds']
        if until<=now:expired.append((row['id'],))
    db.executemany('DELETE FROM pending WHERE id=?',expired)
    return len(expired)

def deadline(p,row,now):
    if row['kind']=='direct':return (row['received_at'] or row['first'])+direct_ttl(p,row['chat_id'])
    return now+p.cfg['turn_ttl_seconds']

def model_busy(db,now):
    # The old 180s orphan grace remains; a live long turn also holds the slot
    # until its absolute deadline, even when its request started >180s ago.
    return db.execute("SELECT 1 FROM attempts a JOIN turns t ON t.id=a.turn_id WHERE a.state='reserved' AND (t.expires>? OR a.ts>?) LIMIT 1",(now,now-180)).fetchone() is not None

def bind(p,request,turn_id,task):
    if task not in {'planner','replyer'}:return
    from src.llm_models.payload_content.context_item import ContextItemBuilder,RoleType
    text=('[GT_WAIT_POLICY]【可信等待策略】回复是否超过五分钟由发送层按真实计时决定，不要仅凭历史或猜测自行写等待致歉。'
          '调用reply工具时，若提供wait_apology参数，请预备一句与本次回复同语言、符合当前Persona的简短致歉，'
          '例如GT中文“抱歉久等，刚才这句话绕了点远路。[呲牙]”、英文“Sorry for the wait. My answer took the scenic route. 😄”。'
          '这些只是合成语气示例，其他语言自然改写。将致歉单独放在wait_apology，不写入reply_text或正常回复正文；'
          '发送层仅在超过300秒时使用，未超时会忽略。不要声称掉线或编造具体技术原因，不要求成员重发。'
          '认真问题先回答问题，不因等待而增加无关内容。')
    items=[i for i in request.context_items if not (type(i).__name__=='SystemMessageItem' and any(getattr(part,'text','').startswith('[GT_WAIT_POLICY]') for part in i.parts))]
    index=next((i for i,item in enumerate(items) if type(item).__name__!='SystemMessageItem'),len(items))
    request.context_items=[*items[:index],ContextItemBuilder().set_role(RoleType.System).add_text_content(text).build(),*items[index:]]

def remember(p,turn_id,text):
    if not turn_id or not isinstance(text,str):return
    text=text.strip()
    if not 1<=len(text)<=120 or '\n' in text or re.search(r'https?://|<[^>]+>|\[GT_',text):return
    import groupdesk_runtime as gd
    with p.db() as db:
        turn=db.execute('SELECT * FROM turns WHERE id=? AND status="active" AND expires>?',(turn_id,p.clock())).fetchone()
        if not turn:return
        managed=gd.profile(p.cfg,turn['chat_id'])
        if managed and not gd.language_allowed(managed,text):return
        db.execute('UPDATE turns SET wait_apology=? WHERE id=?',(text,turn_id))

FALLBACK={
 'zh':'抱歉久等，刚才这句话绕了点远路。[呲牙]',
 'en':'Sorry for the wait. My answer took the scenic route. 😄',
 'ja':'お待たせしてすみません。返事が少し遠回りしました。',
 'ko':'기다리게 해서 미안해요. 답이 조금 돌아서 왔네요.',
 'fr':'Désolé pour l’attente, ma réponse a pris un petit détour. 🙂',
 'es':'Perdón por la espera; mi respuesta dio un pequeño rodeo. 🙂',
 'de':'Entschuldige die Wartezeit, meine Antwort hat einen kleinen Umweg genommen. 🙂',
 'it':'Scusa l’attesa, la mia risposta ha fatto un piccolo giro. 🙂',
 'pt':'Desculpa a demora, a minha resposta fez um pequeno desvio. 🙂',
 'ru':'Извините за ожидание: мой ответ немного задержался.',
 'ar':'أعتذر عن التأخير، أخذ الرد طريقًا أطول قليلًا.',
 'th':'ขอโทษที่ให้รอนะ คำตอบอ้อมไปหน่อย',
}

def language(text,managed):
    policy=(managed or {}).get('policy',{}).get('language',{})
    if policy.get('mode')=='fixed':return policy.get('fixed',policy.get('fallback','en')).split('-')[0]
    for code,pat in [('ja',r'[\u3040-\u30ff]'),('ko',r'[\uac00-\ud7af]'),('ar',r'[\u0600-\u06ff]'),('ru',r'[\u0400-\u04ff]'),('th',r'[\u0e00-\u0e7f]'),('zh',r'[\u4e00-\u9fff]')]:
        count=len(re.findall(pat,text));letters=sum(c.isalpha() for c in text)
        if count>=2 and (code!='zh' or count/max(1,letters)>.25):return code
    tokens=set(re.findall(r'[a-zà-ÿ]+',text.lower()))
    words={'en':{'the','you','your','this','that','is','are','and','with'},'fr':{'je','vous','votre','avec','pour','une','des','est','merci'},'es':{'hola','gracias','usted','para','una','los','estoy','muy'},'de':{'danke','ich','ist','sind','mit','und','nicht','eine'},'it':{'ciao','grazie','sono','della','per','buongiorno'},'pt':{'olá','obrigado','você','não','uma','para','com','muito'}}
    scores={code:len(tokens&v) for code,v in words.items()};best=max(scores,key=scores.get)
    if scores[best]:return best
    allowed=policy.get('allowed',[])
    return allowed[0].split('-')[0] if len(allowed)==1 else 'en'

def decorate(p,turn_id,text,managed=None):
    with p.db() as db:turn=db.execute('SELECT * FROM turns WHERE id=?',(turn_id,)).fetchone()
    if not turn:raise ValueError('Unattributed wait-time decoration')
    now=p.clock();received=turn['received_at'] or turn['created'];elapsed=max(0,now-received)
    info={'received_at':received,'submitted_at':now,'elapsed_seconds':elapsed,'late':int(elapsed>p.cfg.get('wait_apology_seconds',300)),'apology_source':'none','apology_sha256':None}
    if not info['late']:return text,info
    # Recovery tasks already carry their own truthful incident apology. Avoid
    # doubling it when that reply also takes a while.
    already=re.match(r'^(?:sorry\b|apologies\b|抱歉|久等|お待たせ|désolé|perd[oó]n|entschuld|scusa|desculp|извин|أعتذر|ขอโทษ)',text,re.I)
    if already:
        info['apology_source']='already_present';return text,info
    prefix=turn['wait_apology'].strip()
    if prefix:info['apology_source']='persona_model'
    else:prefix=FALLBACK.get(language(text,managed),FALLBACK['en']);info['apology_source']='persona_fallback'
    import groupdesk_runtime as gd
    if managed and not gd.language_allowed(managed,prefix):
        raise ValueError('Wait apology outside group language policy')
    limit=2000 if turn['article'] else p.cfg['output_chars']
    available=limit-len(prefix)-2
    if len(text)>available:text=text[:max(0,available-1)].rstrip()+'…'
    info['apology_sha256']=hashlib.sha256(prefix.encode()).hexdigest()
    return prefix+'\n\n'+text,info

def audit(p,turn_id,send_id,info):
    with p.db() as db:
        db.execute('INSERT INTO latency_deliveries VALUES(?,?,?,?,?,?,?,?)',(send_id,turn_id,info['received_at'],info['submitted_at'],info['elapsed_seconds'],info['late'],info['apology_source'],info['apology_sha256']))
