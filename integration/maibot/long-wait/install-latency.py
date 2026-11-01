"""Generate checked runtime copies; never read model credentials locally."""
from pathlib import Path
import ast,json,sys
root=Path(sys.argv[1])

def edit(name,replacements):
    path=root/name;s=path.read_text()
    for old,new,count in replacements:
        if old in new and new in s:continue
        if not s.count(old) and new in s:continue
        if s.count(old)!=count:raise ValueError('Unexpected long-wait baseline: '+name+' '+old[:70])
        s=s.replace(old,new)
    ast.parse(s.lstrip('\ufeff'));path.write_text(s)

edit('limits/policy.py',[
 ('import groupdesk_runtime as gd\n','import groupdesk_runtime as gd\nimport latency\n',1),
 ('            recovery.init(db)','            recovery.init(db)\n            latency.init(db)',1),
 ("        with self.db() as db:\n            if db.execute('SELECT 1 FROM observed WHERE seq=?'", "        with self.db() as db:\n            latency.expire_pending(self, db, now)\n            if db.execute('SELECT 1 FROM observed WHERE seq=?'",1),
 ("waiting=db.execute('SELECT id,kind FROM pending WHERE sender=? AND chat_id=? AND first>?',(sender,chat_id,now-self.cfg['queue_ttl_seconds'])).fetchone()", "waiting=db.execute('SELECT id,kind FROM pending WHERE sender=? AND chat_id=?',(sender,chat_id)).fetchone()",1),
 ("db.execute('DELETE FROM pending WHERE first<?',(now-self.cfg['queue_ttl_seconds'],))",'latency.expire_pending(self,db,now)',2),
 ("removed=latency.expire_pending(self,db,now).rowcount", "removed=latency.expire_pending(self,db,now)",1),
 ("db.execute('UPDATE pending SET chat_id=?,food_anchor_seq=? WHERE sender=?',(chat_id,food_anchor,sender))", "db.execute('UPDATE pending SET chat_id=?,food_anchor_seq=?,received_at=? WHERE sender=?',(chat_id,food_anchor,min(now,timestamp) if timestamp is not None else now,sender))",1),
 ("db.execute(\"SELECT 1 FROM attempts WHERE state='reserved' AND ts>?\",(now-180,)).fetchone()",'latency.model_busy(db,now)',2),
 ("                db.execute('INSERT INTO turns (id,sender,kind,created,expires,status,article,ended,explicit,fast) VALUES (?,?,?,?,?,?,?,?,?,?)',(row['id'],row['sender'],row['kind'],now,now+self.cfg['turn_ttl_seconds'],'active',row['article'],None,row['explicit'],row['fast']))", "                expires=latency.deadline(self,row,now)\n                if expires-now<=5:\n                    db.execute('DELETE FROM pending WHERE id=?',(row['id'],));self.count(db,'expired_queue');continue\n                db.execute('INSERT INTO turns (id,sender,kind,created,expires,status,article,ended,explicit,fast,received_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',(row['id'],row['sender'],row['kind'],now,expires,'active',row['article'],None,row['explicit'],row['fast'],row['received_at'] or row['first']))",1),
 ("expires=now+self.cfg['turn_ttl_seconds'])",'expires=expires)',1),
])
edit('limits/group_guard.py',[
 ("            recovery.bind(p,request,turn['id'])", "            recovery.bind(p,request,turn['id'])\n            import latency\n            latency.bind(p,request,turn['id'],task)",1),
])
edit('limits/model_routing.py',[
 ("max_retry=2,timeout=80,retry_interval=4)","max_retry=2,timeout=310,retry_interval=4)",1),
])
edit('bridge/app.py',[
 ("                if not self.ledger.reserve(identifier):", "                turn_id = (info.additional_config or {}).get('gt_limit_turn')\n                import latency\n                text,wait_info=latency.decorate(self.policy,turn_id,text,managed)\n                if managed is not None and not gd.language_allowed(managed,text):raise Denied('groupdesk_language')\n                if not self.ledger.reserve(identifier):",1),
 ("                article = self.policy.reserve_send(identifier, turn_id,chat_id=str(chat.id))", "                article = self.policy.reserve_send(identifier, turn_id,chat_id=str(chat.id))\n                latency.audit(self.policy,turn_id,identifier,wait_info)",1),
])
edit('core/reply.py',[
 ('{"msg_id", "reply_text", "_reply_id", "_plugin_reply_prompt"}', '{"msg_id", "reply_text", "wait_apology", "_reply_id", "_plugin_reply_prompt"}',1),
 ('    properties["attach_pic"] = {', '''    properties["wait_apology"] = {
        "type": "string",
        "maxLength": 120,
        "description": "预备一句与本次回复同语言、符合当前Persona的简短等待致歉。不要混入正文。系统仅在真实等待超过120秒时使用；未超过时忽略。不编造掉线原因，不要求重发。",
    }
    properties["attach_pic"] = {''',1),
 ('    fast_reply_text = str(invocation_arguments.get("reply_text") or "").strip()', '''    from group_guard import TURN, policy as gt_policy
    from latency import remember as remember_wait_apology
    if invocation_arguments.get("wait_apology"):
        remember_wait_apology(gt_policy(), TURN.get(), invocation_arguments.get("wait_apology"))
    fast_reply_text = str(invocation_arguments.get("reply_text") or "").strip()''',1),
])
path=root/'limits/policy.json';v=json.loads(path.read_text());v.update(direct_turn_ttl_seconds=420,wait_apology_seconds=120)
path.write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n')

# Existing regression fixtures should test the configured deadline, not the
# retired 90s direct deadline. Source freshness assertions stay at 90s.
path=root/'limits/test_policy.py'
if path.exists():
 s=path.read_text().replace('self.message(); self.now+=91','self.message(); self.now+=self.cfg.get("direct_turn_ttl_seconds",self.cfg["queue_ttl_seconds"])+1')
 s=s.replace("self.now+=91\n        with self.assertRaises(Denied): self.p.reserve_send('late',t['id'])", "self.now=t['expires']+1\n        with self.assertRaises(Denied): self.p.reserve_send('late',t['id'])")
 path.write_text(s)
path=root/'limits/test_recovery.py'
if path.exists():
 s=path.read_text().replace('self.now+=100;self.p.dispatch()','self.now+=self.cfg.get("direct_turn_ttl_seconds",self.cfg["turn_ttl_seconds"])+1;self.p.dispatch()')
 path.write_text(s)

path=root/'limits/test_greeting.py'
if path.exists():
 s=path.read_text().replace('asyncio.run(call());self.assertEqual(len(r.context_items),2);self.assertEqual(r.max_tokens,256)', 'asyncio.run(call());self.assertEqual(len(r.context_items),3);self.assertEqual(r.max_tokens,256)')
 path.write_text(s)
