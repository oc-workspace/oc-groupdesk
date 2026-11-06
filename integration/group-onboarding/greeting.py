"""Idempotent admin-requested greeting through the normal policy/model sender."""
import hashlib,json,sys,time,uuid
from policy import Policy
import groupdesk_runtime as gd
value=json.load(sys.stdin);identifier=str(uuid.UUID(value['job_id'])).replace('-','');chat=str(value['chat_id']);p=Policy('/limits-state');now=time.time()
with p.db() as db:
 db.execute('CREATE TABLE IF NOT EXISTS onboarding_admin_requests(id TEXT PRIMARY KEY,chat_id TEXT NOT NULL,created REAL NOT NULL)')
 existing=db.execute('SELECT chat_id FROM onboarding_admin_requests WHERE id=?',(identifier,)).fetchone()
 if existing:
  if existing['chat_id']!=chat:raise ValueError('Wrong group')
 else:
  profile=gd.profile(p.cfg,chat)
  if not gd.available(profile,now):raise ValueError('Group unavailable')
  denial=p._quota(db,'direct',now,explicit=True,chat_id=chat)
  if denial:raise ValueError('Admission denied')
  sender=chat+':'+hashlib.sha256(b'groupdesk-onboarding-admin').hexdigest()[:24]
  text='GroupDesk管理员已确认本群接入，并明确请求你现在向本群发一条简短、自然的入群问候。沿用本群已发布基础Persona、特色和语言规则，不声称已经读过完整群史；不要提后台任务编号。'
  db.execute('INSERT INTO pending(id,sender,display,kind,first,last,text,article,explicit,fast,greeting,chat_id,policy_revision,received_at) VALUES(?,?,?,"direct",?,?,?,0,1,0,0,?,?,?)',(identifier,sender,'GroupDesk 管理员（入群问候）',now,now,text,chat,gd.revision(profile),now))
  db.execute('INSERT INTO onboarding_admin_requests VALUES(?,?,?)',(identifier,chat,now))
 sends=db.execute('SELECT status FROM sends WHERE turn_id=?',(identifier,)).fetchall()
 status='sent' if any(r['status']=='sent' for r in sends) else 'uncertain' if sends else 'queued'
 if not sends and existing and not db.execute('SELECT 1 FROM pending WHERE id=? UNION ALL SELECT 1 FROM turns WHERE id=? AND status="active" AND expires>?',(identifier,identifier,now)).fetchone():status='failed'
print(json.dumps({'greeting_status':status}))
