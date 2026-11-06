"""Account-local group metadata only. No chat bodies or keys are returned."""
import hashlib,json,sqlite3,sys,tempfile,unicodedata
from contextlib import closing
from pathlib import Path
from chatlog_reader.vault import unwrap
from chatlog_keeper import wechat_db as native

def normalized(value):return ' '.join(unicodedata.normalize('NFKC',str(value or '')).casefold().split())
def group_metadata(contact,session=None,group_name=''):
 groups={}
 for identifier,nick,remark in contact.execute("SELECT username,nick_name,remark FROM contact WHERE username LIKE ?",('%@chatroom',)):
  aliases=[str(v).strip() for v in [nick,remark] if v and str(v).strip()]
  if aliases:groups[str(identifier)]={'native_id':str(identifier),'name':aliases[0],'aliases':aliases}
 if session is not None:
  exists=session.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='SessionNoContactInfoTable'").fetchone()
  if exists:
   for identifier,title in session.execute("SELECT username,session_title FROM SessionNoContactInfoTable WHERE username LIKE ?",('%@chatroom',)):
    if not title or not str(title).strip():continue
    title=str(title).strip();entry=groups.setdefault(str(identifier),{'native_id':str(identifier),'name':title,'aliases':[]});entry['aliases'].append(title)
 counts={}
 for g in groups.values():counts[normalized(g['name'])]=counts.get(normalized(g['name']),0)+1
 query=normalized(group_name)
 return [{'native_id':g['native_id'],'name':g['name'],'ambiguous':counts[normalized(g['name'])]>1} for g in sorted(groups.values(),key=lambda g:(g['name'],g['native_id'])) if not query or any(normalized(v)==query for v in g['aliases'])][:500]

def collect(group_name=''):
 conf=json.loads(Path('/config/reader.json').read_text());account=conf['account'];source=Path('/wechat')/account/'db_storage'
 key=unwrap(Path('/secrets/wechat-key.enc').read_bytes(),account,Path('/secrets/vault-private.pem'))
 try:
  messages=sorted((source/'message').glob('message_*.db'))
  if not messages or not native._verify_key_v4(key,native._read_stable_page1(messages[0])):raise ValueError('key_invalid')
  with tempfile.TemporaryDirectory(prefix='onboarding-contacts-',dir='/work') as work:
   out=Path(work)/'contact.db'
   if not native._decrypt_db_v4(source/'contact/contact.db',key,out):raise ValueError('contacts_unavailable')
   with closing(sqlite3.connect('file:'+str(out)+'?mode=ro',uri=True)) as contact:
    session_path=source/'session/session.db';session_out=Path(work)/'session.db'
    if session_path.exists():
     if not native._decrypt_db_v4(session_path,key,session_out):raise ValueError('sessions_unavailable')
     with closing(sqlite3.connect('file:'+str(session_out)+'?mode=ro',uri=True)) as session:groups=group_metadata(contact,session,group_name)
    else:groups=group_metadata(contact,None,group_name)
  return {'account_fingerprint':hashlib.sha256(account.encode()).hexdigest(),'groups':groups}
 finally:key=None
if __name__=='__main__':
 try:
  query=json.loads(sys.stdin.read() or '{}').get('group_name','');print(json.dumps(collect(query),ensure_ascii=False))
 except Exception:print(json.dumps({'error':'reader_unavailable'}));raise SystemExit(1)
