"""Conservative extra social admission, never an assertion that a joke is true."""
import hashlib

def validate(p):
    c=p.get('policy',{}).get('conversation')
    if c is None:return
    if not isinstance(c,dict) or set(c)!={'enabled','banter_replies','frequency','instructions'}:raise ValueError('Invalid conversation policy')
    if type(c['enabled']) is not bool or type(c['banter_replies']) is not bool or c['frequency'] not in ['low','normal','high'] or not isinstance(c['instructions'],str) or len(c['instructions'])>1500:raise ValueError('Invalid conversation policy')
    if c['enabled'] and p.get('conversation_policy_contract_version')!=1:raise ValueError('Unknown conversation contract')

def guide(p):
    c=p.get('policy',{}).get('conversation') or {}
    if not c.get('enabled'):return ''
    text='先结合最近上下文识别认真、玩笑、混合和暂不确定。语气分类不是事实核查，不给成员打分。认真问题认真答，混合内容先回答实质问题；孤立片段不作确定判断。有人澄清、表示不适或说停就立即停梗。'
    if c.get('banter_replies'):
        text+='允许用当前Persona接梗、捧哏。频率倾向：'+{'low':'少量，多旁听，不连续接梗','normal':'适量，找到自然接话点才参与','high':'较积极，但不抢话、不逐条回应'}[c['frequency']]+'。不把反讽当事实，不编造人物关系、私事或指控，不起哄围攻。'
    else:text+='只辅助理解语境，不主动接梗；实质问题照常回答。'
    return text+'语言、身份、话题、点名模式、配额和知识权限始终优先，本设置不授权范围外实质咨询。管理员补充：'+c.get('instructions','')

def candidate(db,p,chat,seq,text,now,topics):
    c=p.get('policy',{}).get('conversation') or {}
    if not (p.get('enabled') and c.get('enabled') and c.get('banter_replies')):return False
    if p.get('interaction')!='topic' or p['policy']['participation']=='quiet':return False
    if p['policy']['topic_scope']=='all' and not topics:return False
    if not 4<=len(text.strip())<=1500:return False
    # This only grants a Planner opportunity; the model must still understand
    # context and may stay silent. Existing quotas and send gates stay intact.
    gap,chance={'low':(180,25),'normal':(120,50),'high':(60,100)}[c['frequency']]
    db.execute('CREATE TABLE IF NOT EXISTS managed_banter_admissions(chat_id TEXT PRIMARY KEY,ts REAL)')
    old=db.execute('SELECT ts FROM managed_banter_admissions WHERE chat_id=?',(str(chat),)).fetchone()
    if old and now-old[0]<gap:return False
    roll=int(hashlib.sha256((str(chat)+':'+str(seq)).encode()).hexdigest()[:8],16)%100
    if roll>=chance:return False
    db.execute('INSERT OR REPLACE INTO managed_banter_admissions VALUES(?,?)',(str(chat),now))
    return True
