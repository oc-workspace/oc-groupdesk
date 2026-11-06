"""Executed inside this account's Reader. Emit group metadata only, never chats/keys."""
import hashlib,json,sqlite3,tempfile
from pathlib import Path
from chatlog_reader.vault import unwrap
from chatlog_keeper import wechat_db as native

def collect():
 conf=json.loads(Path('/config/reader.json').read_text());account=conf['account'];source=Path('/wechat')/account/'db_storage'
 key=unwrap(Path('/secrets/wechat-key.enc').read_bytes(),account,Path('/secrets/vault-private.pem'))
 try:
  messages=sorted((source/'message').glob('message_*.db'))
  if not messages or not native._verify_key_v4(key,native._read_stable_page1(messages[0])):raise ValueError('key_invalid')
  with tempfile.TemporaryDirectory(prefix='onboarding-contacts-',dir='/work') as work:
   out=Path(work)/'contact.db'
   if not native._decrypt_db_v4(source/'contact/contact.db',key,out):raise ValueError('contacts_unavailable')
   with sqlite3.connect('file:'+str(out)+'?mode=ro',uri=True) as db:
    rows=db.execute('SELECT username,nick_name FROM contact WHERE username LIKE ?',('%@chatroom',)).fetchall()
  groups={str(identifier):str(name or '').strip() for identifier,name in rows if identifier and name and str(name).strip()}
  counts={name:sum(n==name for n in groups.values()) for name in set(groups.values())}
  return {'account_fingerprint':hashlib.sha256(account.encode()).hexdigest(),'groups':[{'native_id':identity,'name':name,'ambiguous':counts[name]>1} for identity,name in sorted(groups.items(),key=lambda x:(x[1],x[0]))][:500]}
 finally:key=None
if __name__=='__main__':
 try:print(json.dumps(collect(),ensure_ascii=False))
 except Exception:print(json.dumps({'error':'reader_unavailable'}));raise SystemExit(1)
