import contextlib,copy,hashlib,io,json,runpy,sqlite3,sys,tempfile,time,unittest,uuid
from pathlib import Path
from types import SimpleNamespace as N
from unittest.mock import patch
from ops import Driver,Failure,append_scope,save,sha
BOT='11111111-2222-4333-8444-555555555555';SLUG=BOT.replace('-','')
SELECTED={'id':'a'*64,'native_id':'new_room@chatroom','name':'New selected group','ambiguous':False,'external_id':None}
class Fake(Driver):
 def __init__(self,base):
  base=str(Path(base).resolve())
  root=Path(base)/'docker/oc-projects/groupdesk-bots'/SLUG;persist=Path(base)/'persist/groupdesk-bots'/SLUG;root.mkdir(parents=True);persist.mkdir(parents=True)
  account='synthetic_account';connection={'bot_id':BOT,'runtime_instance_id':BOT,'account_fingerprint':hashlib.sha256(account.encode()).hexdigest(),'groups':{'1':'bowxt-'+SLUG+':1'},'token':'must-remain-private','url':'https://example.com'}
  save(root/'deployment.json',{'bot_id':BOT,'runtime_instance_id':BOT});save(root/'compose.json',{'services':{'wechat-bridge':{'environment':{}}}})
  for path,value in [(persist/'reader/config/reader.json',{'account':account,'groups':[{'chat_id':1,'name':'Old group','native_id':'old_room@chatroom'}]}),(persist/'bridge/groups.json',{'Old group':{'chat_id':1,'min_seq':10}}),(persist/'groupdesk/connection.json',connection),(persist/'wechat/bowxt/allowed-chat-names.json',['Old group']),(persist/'bridge/control.json',{'enabled':True,'send_enabled':True})]:save(path,value)
  (persist/'limits').mkdir();(persist/'reader/data').mkdir(parents=True)
  with sqlite3.connect(persist/'limits/limits.sqlite3') as db:db.executescript('CREATE TABLE turns(status TEXT,expires REAL);CREATE TABLE pending(id TEXT);')
  with sqlite3.connect(persist/'bridge/delivery.sqlite3') as db:db.executescript("CREATE TABLE reader_cursors(chat_id INTEGER PRIMARY KEY,epoch TEXT,after_seq INTEGER,cutover REAL,pending_seq INTEGER,retry_until REAL);INSERT INTO reader_cursors VALUES(1,'old-epoch',444,100,NULL,0);")
  self.actions=[];self.fail=None;super().__init__(BOT,base)
 def discover(self):return {'candidates':[copy.deepcopy(SELECTED)],'desktop_url':'http://127.0.0.1:18180/'}
 def api(self,path,body=None):return {'chat':{'id':2}} if path=='chats' else {'wechat_connected':True,'queue_depth':0}
 def command(self,args,**kw):self.actions.append(args);return ''
 def reload_reader(self):
  self.actions.append('reader')
  if self.fail=='reader':self.fail=None;raise Failure('reader_unavailable')
 def reload_sender(self):self.actions.append('sender')
 def reload_bridge(self):self.actions.append('bridge')
 def verify(self,external):return {'reader':True,'wechat':True,'sender':True}
 def exec(self,*args,**kwargs):return {'epoch':'b'*32,'watermark':991,'cutover_at':time.time()}
class OperationTests(unittest.TestCase):
 def setUp(self):self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.d=Fake(self.tmp.name)
 def job(self):return {'id':str(uuid.uuid4()),'kind':'connect','candidate':SELECTED}
 def test_append_scope_preserves_every_existing_mapping_and_secret(self):
  before=self.d.configurations();after=append_scope(before,SELECTED,2,'bowxt-'+SLUG+':2');self.assertEqual(before,self.d.configurations());self.assertEqual(after['connection']['groups']['1'],before['connection']['groups']['1']);self.assertEqual(after['connection']['token'],'must-remain-private');self.assertEqual(after['reader']['groups'][0],before['reader']['groups'][0])
 def test_rejects_replacement_and_max_groups(self):
  c=self.d.configurations()
  with self.assertRaises(Failure):append_scope(c,SELECTED,1,'bowxt-'+SLUG+':1')
  c['reader']['groups']=[{'chat_id':i,'name':'Old'+str(i),'native_id':'r'+str(i)+'@chatroom'} for i in range(1,11)]
  with self.assertRaises(Failure):append_scope(c,SELECTED,99,'bowxt-'+SLUG+':99')
 def test_connect_only_new_tail_keeps_old_cursor_and_retries_without_any_replay(self):
  job=self.job();result=self.d.handle(job);self.assertEqual(result['chat_id'],2)
  with sqlite3.connect(self.d.persist/'bridge/delivery.sqlite3') as db:
   self.assertEqual(db.execute('SELECT after_seq FROM reader_cursors WHERE chat_id=1').fetchone()[0],444);self.assertEqual(db.execute('SELECT after_seq FROM reader_cursors WHERE chat_id=2').fetchone()[0],991)
  actions=list(self.d.actions);self.assertEqual(self.d.handle(job),result);self.assertEqual(self.d.actions,actions)
  self.assertTrue(json.loads((self.d.persist/'bridge/control.json').read_text())['enabled']);self.assertFalse(any('wechat-1' in str(a) and 'restart' in str(a) for a in self.d.actions))
 def test_reader_failure_restores_original_files_and_controls_without_restoring_ledgers(self):
  before=self.d.configurations();self.d.fail='reader'
  with self.assertRaises(Failure):self.d.handle(self.job())
  self.assertEqual(self.d.configurations(),before);self.assertTrue(json.loads((self.d.persist/'bridge/control.json').read_text())['enabled'])
 def test_unknown_cross_account_and_arbitrary_rpc_are_rejected(self):
  for value in [{'id':'../../etc','kind':'discover'},{'id':str(uuid.uuid4()),'kind':'restart'},{'id':str(uuid.uuid4()),'kind':'verify','external_id':'bowxt-another:1'},{'id':str(uuid.uuid4()),'kind':'discover','command':'rm'}]:
   with self.assertRaises(Failure):self.d.handle(value)
 def test_pending_work_does_not_change_any_file_or_restart_any_service(self):
  before=self.d.configurations()
  with sqlite3.connect(self.d.persist/'limits/limits.sqlite3') as db:db.execute('INSERT INTO pending VALUES("busy")')
  with self.assertRaises(Failure):self.d.handle(self.job())
  self.assertEqual(self.d.configurations(),before);self.assertEqual(self.d.actions,[])
 def test_atomic_writes_keep_container_read_permissions_and_owner(self):
  p=self.d.persist/'reader/config/reader.json';mode=p.stat().st_mode;uid=p.stat().st_uid;save(p,json.loads(p.read_text()));self.assertEqual(p.stat().st_mode,mode);self.assertEqual(p.stat().st_uid,uid)
 def test_interrupted_write_recovers_only_its_own_known_hash(self):
  before=self.d.configurations();backup=self.d.state/'synthetic-backup';backup.mkdir()
  for k,p in self.d.paths().items():(backup/(k+'.json')).write_bytes(p.read_bytes())
  target=self.d.paths()['allowed'];save(target,['Old group','Partially added']);state={'backup':str(backup),'expected':{'allowed':sha(target)},'original_control':{'enabled':True,'send_enabled':True}}
  self.d.recover(state);self.assertEqual(self.d.configurations(),before)
  save(target,['Operator change'])
  with self.assertRaises(Failure):self.d.recover(state)
  self.assertEqual(json.loads(target.read_text()),['Operator change'])
class GreetingTests(unittest.TestCase):
 def test_repeated_greeting_uses_one_normal_pending_task_and_never_requeues_an_uncertain_send(self):
  with tempfile.TemporaryDirectory() as t:
   path=Path(t)/'state.db'
   with sqlite3.connect(path) as db:db.executescript('CREATE TABLE pending(id TEXT PRIMARY KEY,sender TEXT,display TEXT,kind TEXT,first REAL,last REAL,text TEXT,article INTEGER,explicit INTEGER,fast INTEGER,greeting INTEGER,chat_id TEXT,policy_revision TEXT,received_at REAL);CREATE TABLE sends(turn_id TEXT,status TEXT);CREATE TABLE turns(id TEXT,status TEXT,expires REAL);')
   @contextlib.contextmanager
   def connect():
    db=sqlite3.connect(path);db.row_factory=sqlite3.Row
    try:
     with db:yield db
    finally:db.close()
   policy=N(cfg={},db=connect,_quota=lambda *a,**k:None);gd=N(profile=lambda *a:{},available=lambda *a:True,revision=lambda *a:'2')
   job=str(uuid.uuid4());payload=json.dumps({'job_id':job,'chat_id':2})
   def run():
    out=io.StringIO()
    with patch.dict(sys.modules,{'policy':N(Policy=lambda *a:policy),'groupdesk_runtime':gd}),patch.object(sys,'stdin',io.StringIO(payload)),contextlib.redirect_stdout(out):runpy.run_path(str(Path(__file__).parent/'greeting.py'))
    return json.loads(out.getvalue())
   self.assertEqual(run()['greeting_status'],'queued');self.assertEqual(run()['greeting_status'],'queued')
   with connect() as db:
    self.assertEqual(db.execute('SELECT count(*) FROM pending').fetchone()[0],1);db.execute('INSERT INTO sends VALUES(?,"uncertain")',(job.replace('-',''),))
   self.assertEqual(run()['greeting_status'],'uncertain')
   with connect() as db:self.assertEqual(db.execute('SELECT count(*) FROM pending').fetchone()[0],1)
if __name__=='__main__':unittest.main()
