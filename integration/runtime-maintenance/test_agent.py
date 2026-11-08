"""Synthetic filesystem/metadata tests. Docker/systemd/network calls are mocked."""
import base64,copy,datetime,hashlib,hmac,importlib.util,json,os,tempfile,time,unittest,uuid
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('agent',Path(__file__).with_name('agent.py'));agent=importlib.util.module_from_spec(spec);spec.loader.exec_module(agent)

@unittest.skipUnless(os.geteuid()==0,'Root-owned synthetic manifests required; run on disposable test host directory')
class AgentTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory(prefix='runtime-maintenance-test-');self.root=Path(self.tmp.name);self.saved={k:getattr(agent,k) for k in ['DEPLOY','PERSIST','QDATA','QDEPLOY','STATE','HOST_ROOTS']}
  for k,relative in [('DEPLOY','deploy'),('PERSIST','persist'),('QDATA','qdata'),('QDEPLOY','qdeploy'),('STATE','state')]:setattr(agent,k,self.root/relative);getattr(agent,k).mkdir()
  agent.HOST_ROOTS={'rococo-root':[],'rococo-root2':[]};self.bot=str(uuid.uuid4());self.slug=self.bot.replace('-','');self.project='gdbot-'+self.slug;self.instance=str(uuid.uuid4());self.job=str(uuid.uuid4());self.cfg={'host':'rococo-root2','permit_secret':'synthetic-permit-secret-only'}
  d=agent.DEPLOY/self.slug;d.mkdir();(d/'deployment.json').write_text(json.dumps({'bot_id':self.bot,'runtime_instance_id':self.instance,'deployment':str(d),'persist':str(agent.PERSIST/self.slug)}));p=agent.PERSIST/self.slug;p.mkdir();(p/'wechat').mkdir();(p/'wechat'/'sample').write_text('SYNTHETIC DATA');self.rows=[{'id':'a'*64,'name':'/'+self.project+'-wechat-1','labels':{'com.docker.compose.project':self.project,'com.docker.compose.service':'wechat','com.docker.compose.project.working_dir':str(d)},'mounts':[{'Type':'bind','Source':str(p/'wechat')}],'networks':{},'running':False,'image':'sha256:'+'b'*64,'restart':{'Name':'unless-stopped'}}];self.nets=[{'id':'c'*64,'name':self.project+'_bot','labels':{'com.docker.compose.project':self.project},'containers':{self.rows[0]['id']:{}}}];self.calls=[]
  self.patches=[patch.object(agent.os.path,'ismount',return_value=False),patch.object(agent,'containers',side_effect=lambda:copy.deepcopy(self.rows)),patch.object(agent,'networks',side_effect=lambda project:copy.deepcopy(self.nets)),patch.object(agent,'units',return_value=[]),patch.object(agent,'run',side_effect=self.fake_run)]
  for p in self.patches:p.start()
 def tearDown(self):
  for p in reversed(self.patches):p.stop()
  for k,v in self.saved.items():setattr(agent,k,v)
  self.tmp.cleanup()
 def fake_run(self,*args,**kwargs):
  self.calls.append(args)
  if args[:2]==('docker','rm'):self.rows=[r for r in self.rows if r['id']!=args[2]]
  if args[:3]==('docker','network','rm'):self.nets=[n for n in self.nets if n['id']!=args[3]]
  if args[:2]==('docker','update'):
   for r in self.rows:r['restart']={'Name':'no'}
  return ''
 def signed(self,job,fp=None):
  v={'job_id':job['id'],'host':'rococo-root2','action':job['action'],'bot_id':self.bot,'lease_token':job['lease_token'],'fingerprint':fp or job['plan_hash'],'selection':job['selection'],'retention_days':job['retention_days'],'parent_job_id':job.get('parent_job_id'),'expires':int(time.time())+180};payload=base64.urlsafe_b64encode(json.dumps(v).encode()).decode().rstrip('=');return {'payload':payload,'signature':hmac.new(self.cfg['permit_secret'].encode(),payload.encode(),hashlib.sha256).hexdigest()}
 def qjob(self,selection=None):
  p,_=agent.target(self.bot);return {'id':self.job,'action':'quarantine','bot_id':self.bot,'lease_token':str(uuid.uuid4()),'plan_hash':p['fingerprint'],'selection':selection or ['containers','wechat'],'retention_days':7,'parent_job_id':None}
 def follow(self,q,action):
  p,_=agent.target(self.bot);return {**q,'id':str(uuid.uuid4()),'action':action,'lease_token':str(uuid.uuid4()),'plan_hash':p['quarantine']['fingerprint'],'parent_job_id':q['id']}
 def test_inventory_has_no_mutations_or_private_content(self):
  report=agent.inventory('rococo-root2');self.assertEqual(len(report['bots']),1);self.assertNotIn('SYNTHETIC DATA',json.dumps(report));self.assertEqual(self.calls,[])
 def test_uuid_and_manifest_identity_or_write_permissions_block(self):
  with self.assertRaises(ValueError):agent.canonical(agent.LEGACY)
  p=agent.DEPLOY/self.slug/'deployment.json';p.chmod(0o666);self.assertTrue(agent.target(self.bot)[0]['blocked']);p.chmod(0o644);m=json.loads(p.read_text());m['persist']=str(self.root/'other');p.write_text(json.dumps(m));self.assertTrue(agent.target(self.bot)[0]['blocked'])
 def test_foreign_mounts_include_stopped_containers_and_ancestor_paths(self):
  foreign=copy.deepcopy(self.rows[0]);foreign['id']='d'*64;foreign['name']='/OTHER_BOT';foreign['labels']['com.docker.compose.project']='other';foreign['mounts'][0]['Source']=str(agent.PERSIST);self.rows.append(foreign);r=next(r for r in agent.target(self.bot)[0]['resources'] if r['kind']=='wechat');self.assertTrue(r['blocked']);self.assertIn('OTHER_BOT',r['blocked'][0])
 def test_symlink_and_backup_directories_remain_read_only(self):
  p=agent.PERSIST/self.slug/'wechat';(p/'outside').symlink_to(self.root/'other');self.assertTrue(agent.size_tree(p)['blocked']);(p/'outside').unlink();(p/'backups').mkdir();self.assertTrue(agent.size_tree(p)['blocked']);self.assertEqual(self.calls,[])
 def test_signed_permission_is_required_and_bound_to_exact_host_scope(self):
  j=self.qjob();bad=self.signed(j);bad['signature']='0'*64
  with self.assertRaises(ValueError):agent.perform(j,bad,self.cfg)
  with self.assertRaises(ValueError):agent.perform(j,self.signed(j),{**self.cfg,'host':'rococo-root'})
  self.assertTrue((agent.PERSIST/self.slug/'wechat'/'sample').exists());self.assertEqual(self.calls,[])
 def test_quarantine_is_atomic_and_does_not_remove_containers_or_images(self):
  j=self.qjob();receipt=agent.perform(j,self.signed(j),self.cfg);self.assertEqual(receipt['bytes_released'],0);self.assertFalse((agent.PERSIST/self.slug/'wechat').exists());self.assertEqual(len(self.rows),1);self.assertFalse(any(x[:2]==('docker','rm') for x in self.calls));self.assertFalse(any('prune' in x or 'rmi' in x for x in self.calls));self.assertEqual(agent.target(self.bot)[0]['quarantine']['job_id'],j['id'])
 def test_restore_keeps_containers_disabled_and_never_overwrites_new_data(self):
  j=self.qjob();agent.perform(j,self.signed(j),self.cfg);r=self.follow(j,'restore');(agent.PERSIST/self.slug/'wechat').mkdir()
  with self.assertRaises(ValueError):agent.perform(r,self.signed(r),self.cfg)
  (agent.PERSIST/self.slug/'wechat').rmdir();agent.perform(r,self.signed(r),self.cfg);self.assertEqual((agent.PERSIST/self.slug/'wechat'/'sample').read_text(),'SYNTHETIC DATA');self.assertEqual(self.rows[0]['restart']['Name'],'no');self.assertIsNone(agent.target(self.bot)[0]['quarantine'])
 def test_purge_removes_only_selected_uuid_and_keeps_other_bot_and_backups(self):
  other=self.root/'OTHER';other.mkdir();(other/'keep').write_text('KEEP');j=self.qjob();agent.perform(j,self.signed(j),self.cfg);p=self.follow(j,'purge');receipt=agent.perform(p,self.signed(p),self.cfg);self.assertEqual(receipt['state'],'purged');self.assertEqual((other/'keep').read_text(),'KEEP');self.assertEqual(self.rows,[]);self.assertEqual(self.nets,[]);self.assertFalse(any('prune' in x or 'rmi' in x for x in self.calls));self.assertIsNone(agent.target(self.bot)[0]['quarantine'])
 def test_replaced_quarantine_directory_is_not_purged(self):
  j=self.qjob();agent.perform(j,self.signed(j),self.cfg);q=agent.journal_for(self.bot);source=Path(q['paths'][0]['quarantine']);source.rename(source.with_name('original-held'));source.mkdir();(source/'new').write_text('KEEP NEW DATA');p=self.follow(j,'purge')
  with self.assertRaises(ValueError):agent.perform(p,self.signed(p),self.cfg)
  self.assertEqual((source/'new').read_text(),'KEEP NEW DATA')
 def test_topology_change_between_preview_and_execution_refuses_mutation(self):
  j=self.qjob();self.rows[0]['id']='e'*64
  with self.assertRaises(ValueError):agent.perform(j,self.signed(j),self.cfg)
  self.assertTrue((agent.PERSIST/self.slug/'wechat').exists());self.assertEqual(self.calls,[])
 def test_mid_move_failure_resumes_idempotently_under_same_job(self):
  j=self.qjob(['containers','wechat','deployment']);original=Path.rename;count=[0]
  def rename(path,dest):
   if path==agent.DEPLOY/self.slug and count[0]==0:count[0]+=1;raise OSError('synthetic interrupted move')
   return original(path,dest)
  with patch.object(Path,'rename',rename):
   with self.assertRaises(OSError):agent.perform(j,self.signed(j),self.cfg)
  receipt=agent.perform(j,self.signed(j),self.cfg);self.assertEqual(receipt['state'],'quarantined');p=self.follow(j,'purge');self.assertEqual(agent.perform(p,self.signed(p),self.cfg)['state'],'purged')



@unittest.skipUnless(os.geteuid()==0,'Root-owned synthetic fixture')
class LegacyTests(unittest.TestCase):
 def setUp(self):
  self.base=AgentTests();self.base.setUp();self.saved={k:getattr(agent,k) for k in ['LEGACY_PERSIST','LEGACY_READER','LEGACY_PROFILE']}
  agent.LEGACY_PERSIST=self.base.root/'legacy';agent.LEGACY_READER=self.base.root/'legacy-reader';agent.LEGACY_PROFILE=self.base.root/'legacy-profile.json';agent.LEGACY_PERSIST.mkdir();agent.LEGACY_READER.mkdir();(agent.LEGACY_PERSIST/'wechat').mkdir();(agent.LEGACY_PERSIST/'wechat'/'old').write_text('OLD SYNTHETIC DATA')
  c=self.base.rows[0];c['name']='/wechat-bot';c['labels']={'com.docker.compose.project':'maibot-wechat','com.docker.compose.service':'wechat'};c['mounts']=[{'Type':'bind','Source':str(agent.LEGACY_PERSIST/'wechat')}];c['networks']={'maibot-wechat_bot':{}};self.base.nets[0]['name']='maibot-wechat_bot';self.base.nets[0]['labels']={'com.docker.compose.project':'maibot-wechat'}
  self.profile={'profile':'legacy-ryubuddy-v1','bot_id':agent.LEGACY,'instance_id':self.base.instance,'containers':[{k:copy.deepcopy(c[k]) for k in ['id','name','image','labels','mounts']}],'networks':[{'id':self.base.nets[0]['id'],'name':'maibot-wechat_bot'}],'units':{}};agent.atomic(agent.LEGACY_PROFILE,self.profile)
  self.netpatch=patch.object(agent,'legacy_networks',side_effect=lambda:copy.deepcopy(self.base.nets));self.netpatch.start()
 def tearDown(self):
  self.netpatch.stop()
  for k,v in self.saved.items():setattr(agent,k,v)
  self.base.tearDown()
 def job(self,action='quarantine',parent=None):
  p,_=agent.target(agent.LEGACY);return {'id':str(uuid.uuid4()),'action':action,'bot_id':agent.LEGACY,'lease_token':str(uuid.uuid4()),'plan_hash':p['quarantine']['fingerprint'] if parent else p['fingerprint'],'selection':['wechat','containers','images'],'retention_days':0,'parent_job_id':parent}
 def signed(self,j):
  v={'job_id':j['id'],'host':'rococo-root2','action':j['action'],'bot_id':agent.LEGACY,'lease_token':j['lease_token'],'fingerprint':j['plan_hash'],'selection':j['selection'],'parent_job_id':j.get('parent_job_id'),'expires':int(time.time())+180};payload=base64.urlsafe_b64encode(json.dumps(v).encode()).decode().rstrip('=');return {'payload':payload,'signature':hmac.new(self.base.cfg['permit_secret'].encode(),payload.encode(),hashlib.sha256).hexdigest()}
 def test_profile_pins_container_identity_and_foreign_mounts_block(self):
  self.assertFalse(agent.target(agent.LEGACY)[0]['blocked']);self.base.rows[0]['id']='e'*64;self.assertTrue(agent.target(agent.LEGACY)[0]['blocked'])
 def test_shared_images_and_other_containers_are_retained(self):
  other=copy.deepcopy(self.base.rows[0]);other['id']='d'*64;other['name']='/TATSUMI';other['labels']={'com.docker.compose.project':'other'};other['mounts']=[];self.base.rows.append(other)
  p,_=agent.target(agent.LEGACY);self.assertEqual(p['shared_images'],[other['image']]);self.assertFalse(next(r for r in p['resources'] if r['kind']=='images')['present'])
 def test_contained_hardlinks_allowed_but_external_links_blocked(self):
  root=agent.LEGACY_PERSIST/'wechat';os.link(root/'old',root/'second');self.assertFalse(agent.size_tree(root,allow_contained_links=True)['blocked']);os.link(root/'old',self.base.root/'external');self.assertTrue(agent.size_tree(root,allow_contained_links=True)['blocked'])
 def test_legacy_quarantine_purge_preserves_backups_unknown_files_and_other_bot(self):
  (agent.LEGACY_READER/'backups').mkdir();(agent.LEGACY_READER/'backups'/'keep').write_text('KEEP BACKUP');(agent.LEGACY_PERSIST/'unknown').write_text('KEEP UNKNOWN');j=self.job();agent.perform(j,self.signed(j),self.base.cfg);self.assertFalse((agent.LEGACY_PERSIST/'wechat').exists());p=self.job('purge',j['id']);agent.perform(p,self.signed(p),self.base.cfg)
  self.assertEqual((agent.LEGACY_READER/'backups'/'keep').read_text(),'KEEP BACKUP');self.assertEqual((agent.LEGACY_PERSIST/'unknown').read_text(),'KEEP UNKNOWN');self.assertTrue((agent.PERSIST/self.base.slug/'wechat/sample').exists());self.assertFalse(any('prune' in c or '-f' in c for c in self.base.calls));self.assertTrue(any(c[:3]==('docker','image','rm') for c in self.base.calls))
 def test_legacy_restore_refuses_replaced_quarantine(self):
  j=self.job();agent.perform(j,self.signed(j),self.base.cfg);p=agent.journal_for(agent.LEGACY);path=Path(p['paths'][0]['quarantine']);path.rename(path.with_name('held-original'));path.mkdir();r=self.job('restore',j['id'])
  with self.assertRaises(ValueError):agent.perform(r,self.signed(r),self.base.cfg)



 def test_registered_safe_children_preserve_desktop_backups(self):
  root=agent.LEGACY_PERSIST/'wechat';(root/'xwechat_files').mkdir();(root/'xwechat_files'/'account-db').write_text('SYNTHETIC');(root/'.config').mkdir();(root/'.config'/'menu.xml.bak').write_text('KEEP DESKTOP BACKUP');p=copy.deepcopy(self.profile);p['approved_paths']=[['wechat',str(root/'xwechat_files')]];p['excluded_paths']=[{'path':str(root/'.config'),'reason':'backup retained'}];agent.atomic(agent.LEGACY_PROFILE,p)
  j=self.job();agent.perform(j,self.signed(j),self.base.cfg);r=self.job('purge',j['id']);agent.perform(r,self.signed(r),self.base.cfg);self.assertEqual((root/'.config'/'menu.xml.bak').read_text(),'KEEP DESKTOP BACKUP');self.assertTrue((root/'old').exists());self.assertFalse((root/'xwechat_files').exists())

if __name__=='__main__':unittest.main()
