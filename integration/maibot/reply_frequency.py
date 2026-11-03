"""Shared rolling windows and durable, bounded direct-request deferral."""
import asyncio,json,uuid
DEFAULTS={'windows':[{'minutes':5,'max_replies':6},{'minutes':60,'max_replies':36}],'catch_up':{'enabled':True,'within_minutes':10}}
MAX_WAITING=100

def validate(value):
 if not isinstance(value,dict) or set(value)!={'windows','catch_up'}:raise ValueError('Invalid frequency fields')
 windows=value['windows'];catch=value['catch_up']
 if not isinstance(windows,list) or not 1<=len(windows)<=4:raise ValueError('Invalid frequency windows')
 seen=set()
 for w in windows:
  if not isinstance(w,dict) or set(w)!={'minutes','max_replies'}:raise ValueError('Invalid frequency window')
  if type(w['minutes']) is not int or not 1<=w['minutes']<=1440 or type(w['max_replies']) is not int or not 1<=w['max_replies']<=1000 or w['minutes'] in seen:raise ValueError('Invalid frequency bounds')
  seen.add(w['minutes'])
 if not isinstance(catch,dict) or set(catch)!={'enabled','within_minutes'} or type(catch['enabled']) is not bool or type(catch['within_minutes']) is not int or not 1<=catch['within_minutes']<=60:raise ValueError('Invalid catch-up policy')
 return value

def validate_bundle(bundle):
 contract=bundle.get('reply_frequency_contract_version');value=bundle.get('reply_frequency')
 if contract is None and value is None:return
 if contract!=1 or not isinstance(value,dict) or set(value)!={'revision','policy'} or type(value['revision']) is not int or value['revision']<1:raise ValueError('Invalid frequency contract')
 validate(value['policy'])

def for_config(config):
 bundles=[p for p in config.get('managed_groups',{}).values() if p.get('reply_frequency') is not None]
 if not bundles:
  # Old backends and regression fixtures keep their native limits and behavior.
  return {'windows':[{'minutes':w/60,'max_replies':n} for w,n in config['reply_limits']],'catch_up':{'enabled':False,'within_minutes':10}}
 for p in bundles:validate_bundle(p)
 values=[p['reply_frequency'] for p in bundles]
 if any(v!=values[0] for v in values[1:]):raise ValueError('Mixed global frequency revisions')
 return values[0]['policy']

def windows(config):return [(w['minutes']*60,w['max_replies']) for w in for_config(config)['windows']]
def catchup(config):return for_config(config)['catch_up']

def init(db):
 db.execute('''CREATE TABLE IF NOT EXISTS frequency_waiting(
  seq INTEGER PRIMARY KEY,chat_id TEXT NOT NULL,sender TEXT NOT NULL,display TEXT NOT NULL,text TEXT NOT NULL,
  received_at REAL NOT NULL,expires REAL NOT NULL,explicit INTEGER NOT NULL,policy_revision TEXT NOT NULL,
  topic_refs TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'waiting',turn_id TEXT,parent_seq INTEGER)''')
 for table in ('pending','turns'):
  if 'frequency_deadline' not in {r['name'] for r in db.execute('PRAGMA table_info('+table+')')}:
   db.execute('ALTER TABLE '+table+' ADD COLUMN frequency_deadline REAL NOT NULL DEFAULT 0')

def defer(p,db,seq,sender,display,text,received,chat,explicit,revision,refs):
 rule=catchup(p.cfg)
 if not rule['enabled']:return 'reply_window'
 expires=received+rule['within_minutes']*60
 if expires<=p.clock():return 'frequency_expired'
 if db.execute('SELECT COUNT(*) FROM frequency_waiting WHERE status IN ("waiting","coalesced")').fetchone()[0]>=MAX_WAITING:return 'frequency_queue_full'
 from policy import reminder_candidate
 previous=db.execute('SELECT * FROM frequency_waiting WHERE chat_id=? AND sender=? AND status="waiting" ORDER BY received_at,seq LIMIT 1',(chat,sender)).fetchone()
 if previous and reminder_candidate(text):
  db.execute('INSERT OR IGNORE INTO frequency_waiting(seq,chat_id,sender,display,text,received_at,expires,explicit,policy_revision,topic_refs,status,parent_seq) VALUES(?,?,?,?,?,?,?,?,?,?,"coalesced",?)',(seq,chat,sender,display,text,previous['received_at'],previous['expires'],int(explicit),revision,json.dumps(refs),previous['seq']))
  p.count(db,'frequency_reminder_coalesced');return 'frequency_waiting'
 db.execute('INSERT OR IGNORE INTO frequency_waiting(seq,chat_id,sender,display,text,received_at,expires,explicit,policy_revision,topic_refs) VALUES(?,?,?,?,?,?,?,?,?,?)',
  (seq,chat,sender,display,text,received,expires,int(explicit),revision,json.dumps(refs)))
 p.count(db,'frequency_deferred')
 return 'frequency_waiting'

def deadline(p,row):
 if not row['frequency_deadline']:return None
 rule=catchup(p.cfg)
 return min(row['frequency_deadline'],(row['received_at'] or row['first'])+rule['within_minutes']*60) if rule['enabled'] else 0

def mark_pending(p,db,row,now):
 rule=catchup(p.cfg)
 if row['kind']!='direct' or not rule['enabled']:return
 until=(row['received_at'] or row['first'])+rule['within_minutes']*60
 if row['frequency_deadline']:until=min(until,row['frequency_deadline'])
 db.execute('UPDATE pending SET frequency_deadline=? WHERE id=?',(until,row['id']))

def pump(p):
 import groupdesk_runtime as gd
 from policy import ARTICLE,fast_candidate,greeting_candidate
 now=p.clock();rule=catchup(p.cfg)
 with p.db() as db:
  if not rule['enabled']:db.execute('UPDATE frequency_waiting SET status="cancelled" WHERE status IN ("waiting","coalesced")')
  db.execute('UPDATE frequency_waiting SET status="expired" WHERE status IN ("waiting","coalesced") AND (expires<=? OR received_at+?<=?)',(now,rule['within_minutes']*60,now))
  db.execute('DELETE FROM frequency_waiting WHERE status!="waiting" AND expires<?',(now-86400,))
  if not rule['enabled'] or db.execute('SELECT 1 FROM pending UNION ALL SELECT 1 FROM turns WHERE status="active" AND expires>?',(now,)).fetchone():return False
  for row in db.execute('SELECT * FROM frequency_waiting WHERE status="waiting" ORDER BY explicit DESC,received_at,seq').fetchall():
   managed=gd.profile(p.cfg,row['chat_id'])
   if managed is not None:
    if not gd.available(managed,now):continue
    if row['policy_revision']!=gd.revision(managed):
     db.execute('UPDATE frequency_waiting SET status="cancelled" WHERE seq=?',(row['seq'],));continue
   if db.execute('SELECT 1 FROM turns WHERE sender=? AND created>?',(row['sender'],now-p.cfg['user_interval'])).fetchone():continue
   if p._quota(db,'direct',now,explicit=bool(row['explicit']),chat_id=row['chat_id']):continue
   identifier=uuid.uuid4().hex;received=row['received_at'];until=min(row['expires'],received+rule['within_minutes']*60)
   if until-now<=5:continue
   fast=int(fast_candidate(row['text'],True) or greeting_candidate(row['text']))
   greeting=int(bool(row['explicit'] and fast and greeting_candidate(row['text']) and (not managed or managed['policy']['persona']=='gt-persona')))
   db.execute('''INSERT INTO pending(id,sender,display,kind,first,last,text,article,explicit,fast,greeting,chat_id,received_at,policy_revision,topic_context_json,frequency_deadline)
    VALUES(?,?,?,'direct',?,?,?,?,?,?,?,?,?,?,?,?)''',(identifier,row['sender'],row['display'],received,received,row['text'],int(bool(ARTICLE.search(row['text']))),row['explicit'],fast,greeting,row['chat_id'],received,row['policy_revision'],row['topic_refs'],until))
   db.execute('UPDATE frequency_waiting SET status="pending",turn_id=? WHERE seq=? OR parent_seq=?',(identifier,row['seq'],row['seq']))
   db.execute('UPDATE recovery_sources SET turn_id=? WHERE seq IN (SELECT seq FROM frequency_waiting WHERE turn_id=?)',(identifier,identifier))
   p.count(db,'frequency_released');return True
 return False

def has_waiting(db,now):return bool(db.execute('SELECT 1 FROM frequency_waiting WHERE status="waiting" AND expires>?',(now,)).fetchone())

def extend_send(p,turn_id):
 rule=catchup(p.cfg);now=p.clock()
 if not rule['enabled']:return False
 with p.db() as db:
  row=db.execute('SELECT * FROM turns WHERE id=? AND kind="direct" AND status="active" AND expires>?',(turn_id,now)).fetchone()
  if not row:return False
  until=(row['received_at'] or row['created'])+rule['within_minutes']*60
  if row['frequency_deadline']:until=min(until,row['frequency_deadline'])
  if until<=now:return False
  db.execute('UPDATE turns SET expires=?,frequency_deadline=? WHERE id=?',(until,until,turn_id));return True

async def reserve_when_ready(p,identifier,turn_id,chat_id,refresh=None,enabled=lambda:True,sleeper=asyncio.sleep):
 from policy import Denied
 while True:
  if not enabled():raise Denied('sending_disabled')
  if refresh is not None:p.cfg=refresh()
  try:return p.reserve_send(identifier,turn_id,chat_id=chat_id)
  except Denied as e:
   if str(e)!='send_frequency' or not extend_send(p,turn_id):raise
  await sleeper(1)

def check_submission(p,turn_id):
 from policy import Denied
 with p.db() as db:
  row=db.execute('SELECT * FROM turns WHERE id=? AND status="active"',(turn_id,)).fetchone()
  if not row or row['expires']<=p.clock():raise Denied('expired_submission')
  if row['frequency_deadline']:
   rule=catchup(p.cfg)
   if not rule['enabled'] or min(row['frequency_deadline'],(row['received_at'] or row['created'])+rule['within_minutes']*60)<=p.clock():raise Denied('frequency_expired')
