import contextlib,io,json,tempfile,unittest,uuid
from pathlib import Path
from unittest.mock import patch,Mock
import device_setup as d
class DeviceSetupTests(unittest.TestCase):
 def test_inspect_does_not_write_or_network_and_unknown_stays_unverified(self):
  with patch.object(d.platform,'system',return_value='Windows'),patch.object(d.shutil,'which',return_value=None),patch.object(d.urllib.request,'build_opener',side_effect=AssertionError('network')):
   result=d.inspect_device()
  self.assertEqual(result['detected_os'],'windows');self.assertFalse(result['changes_made']);self.assertFalse(result['docker']['ok']);self.assertIn('未验证',result['compatibility'])
 def test_windows_and_other_sites_refuse_before_input_or_network(self):
  with patch.object(d.getpass,'getpass',side_effect=AssertionError('input')):
   with patch.object(d.os,'name','nt'):
    with self.assertRaisesRegex(ValueError,'Windows'):d.pair('https://groupdesk.rococo.dev',str(uuid.uuid4()),'/new')
   with self.assertRaises(ValueError):d.pair('https://unapproved.example',str(uuid.uuid4()),'/new')
 def test_existing_directory_and_non_https_refused_before_code_input(self):
  with tempfile.TemporaryDirectory() as t,patch.object(d.getpass,'getpass',side_effect=AssertionError('input')):
   with self.assertRaises(ValueError):d.pair('https://groupdesk.rococo.dev',str(uuid.uuid4()),t)
   for url in ['http://groupdesk.rococo.dev','https://name:secret@groupdesk.rococo.dev','https://groupdesk.rococo.dev/?token=secret']:
    with self.assertRaises(ValueError):d.pair(url,str(uuid.uuid4()),t+'/new')
 def test_pair_posts_only_minimal_fields_and_saves_private_never_prints_token(self):
  bot=str(uuid.uuid4());response=Mock();opener=Mock()
  def perform(req,timeout):
   payload=json.loads(req.data);self.assertEqual(set(payload),{'bot_id','instance_id','code','detected_os'})
   value={'contract':1,'bot_id':bot,'runtime_instance_id':payload['instance_id'],'url':'https://groupdesk.rococo.dev','token':'a'*43,'groups':{}}
   response.__enter__=Mock(return_value=response);response.__exit__=Mock(return_value=False);response.read.return_value=json.dumps(value).encode();return response
  opener.open.side_effect=perform
  with tempfile.TemporaryDirectory() as t,patch.object(d.getpass,'getpass',return_value='b'*43),patch.object(d.urllib.request,'build_opener',return_value=opener),contextlib.redirect_stdout(io.StringIO()) as output:
   path=Path(t)/'new';d.pair('https://groupdesk.rococo.dev',bot,path);self.assertEqual((path/'connection.json').stat().st_mode&0o777,0o600);self.assertEqual(path.stat().st_mode&0o777,0o700);self.assertNotIn('a'*43,output.getvalue());self.assertNotIn('b'*43,output.getvalue())
 def test_pair_rejects_other_bot_without_writing(self):
  with tempfile.TemporaryDirectory() as t,patch.object(d.getpass,'getpass',return_value='b'*43),patch.object(d.urllib.request,'build_opener') as opener:
   opener.return_value.open.return_value.__enter__.return_value.read.return_value=b'{"bot_id":"wrong"}'
   with self.assertRaises(ValueError):d.pair('https://groupdesk.rococo.dev',str(uuid.uuid4()),Path(t)/'new')
   self.assertFalse((Path(t)/'new').exists())

class ReaderPreflightTests(unittest.TestCase):
 def wechat(self,**changes):
  return {'detected_os':'linux','cpu_arch':'x86_64','version':'4.1.13.23','build':'','installation':'deb','fingerprint':d.LINUX_ELF,**changes}
 def report(self,**wechat):
  w=self.wechat(**wechat);return {'detected_os':w['detected_os'],'wechat':w,'reader_compatibility':d.reader_compatibility(w)}
 def test_exact_linux_build_is_only_build_evidence_not_account_or_runtime(self):
  c=d.reader_compatibility(self.wechat());self.assertEqual(c['chatlog-keeper']['status'],'project_verified_build');self.assertEqual(c['chatlog']['status'],'not_supported');self.assertFalse(c['account_read_verified']);self.assertFalse(c['groupdesk_runtime_verified'])
 def test_same_version_wrong_binary_and_arm_are_not_verified(self):
  for w in [self.wechat(fingerprint='wrong'),self.wechat(cpu_arch='aarch64'),self.wechat(version='4.1.13.24')]:self.assertEqual(d.reader_compatibility(w)['chatlog-keeper']['status'],'needs_verification')
 def test_missing_wechat_cannot_be_inferred_from_installed_reader(self):
  c=d.reader_compatibility(self.wechat(version='待检测'));self.assertEqual(c['chatlog-keeper']['status'],'wechat_not_detected')
 def test_mac_exact_build_is_upstream_only_and_intel_is_unverified(self):
  w=self.wechat(detected_os='macos',cpu_arch='arm64',version='4.1.13',build='269579');self.assertEqual(d.reader_compatibility(w)['chatlog-keeper']['status'],'upstream_reported')
  for change in [{'build':'different'},{'cpu_arch':'x86_64'}]:self.assertEqual(d.reader_compatibility({**w,**change})['chatlog-keeper']['status'],'needs_verification')
 def test_upstream_linux_version_never_claims_project_validation(self):self.assertEqual(d.reader_compatibility(self.wechat(version='4.1.13.9'))['chatlog-keeper']['status'],'upstream_reported')
 def test_container_failure_never_uses_host_os_or_version(self):
  with patch.object(d,'command',return_value={'ok':False,'version':''}):w=d.wechat_info('macos','arm64','my-own-wechat')
  self.assertEqual(w['detected_os'],'unknown');self.assertEqual(w['version'],'待检测');self.assertEqual(w['cpu_arch'],'unknown')
 def test_named_container_probes_only_fixed_paths_and_not_env_or_chats(self):
  commands=[]
  def cmd(args):
   commands.append(args)
   if args[-1]=='-s':return {'ok':True,'version':'Linux'}
   if args[-1]=='-m':return {'ok':True,'version':'x86_64'}
   if 'dpkg-query' in args:return {'ok':True,'version':'4.1.13.23'}
   return {'ok':True,'version':d.LINUX_ELF+'  /opt/wechat/wechat'}
  with patch.object(d,'command',side_effect=cmd):w=d.wechat_info('macos','arm64','own-wechat');d.reader_tools(container='own-reader')
  self.assertEqual(d.reader_compatibility(w)['chatlog-keeper']['status'],'project_verified_build');self.assertTrue(all(c[0:2]==['docker','exec'] for c in commands));self.assertTrue(all(c[2] in ['own-wechat','own-reader'] for c in commands));self.assertFalse(any(any(x in ['env','inspect','find','cat','rm','restart','secrets','db_storage'] for x in c) for c in commands))
 def test_container_names_reject_options_shell_and_traversal(self):
  for name in ['--privileged','a;restart','../other','a b','*','a/b']:
   with self.assertRaises(ValueError):d.container_name(name)
 def test_private_installed_record_is_not_treated_as_healthy(self):
  with tempfile.TemporaryDirectory() as t,patch.object(d.shutil,'which',return_value=None),patch.object(d.importlib.metadata,'version',side_effect=d.importlib.metadata.PackageNotFoundError):
   root=Path(t);(root/'venv/bin').mkdir(parents=True);(root/'venv/bin/chatlog-keeper').write_text('synthetic');(root/'groupdesk-reader-install.json').write_text(json.dumps({'installed':True,'upstream_commit':d.KEEPER_COMMIT,'archive_sha256':d.KEEPER_SHA256}))
   readers=d.reader_tools(directory=t);self.assertTrue(readers['chatlog-keeper']['detected']);self.assertFalse(readers['groupdesk-reader']['detected']);self.assertNotIn('healthy',readers['chatlog-keeper'])
 def test_plan_has_no_side_effects_and_container_install_is_blocked(self):
  with patch.object(d.sys,'version_info',(3,12)),patch.object(d.urllib.request,'build_opener',side_effect=AssertionError('network')):
   p=d.reader_plan(self.report());self.assertTrue(p['can_install_keeper_component']);self.assertFalse(p['changes_made']);self.assertFalse(d.reader_plan(self.report(container='own-wechat'))['can_install_keeper_component'])
  self.assertIn('不能pip install chatlog-keeper',str(p));self.assertFalse(p['account_read_verified'])
 def test_installer_requires_consent_before_inspection_input_network_or_writes(self):
  with tempfile.TemporaryDirectory() as t,patch.object(d,'inspect_device',side_effect=AssertionError('inspect')),patch.object(d.urllib.request,'build_opener',side_effect=AssertionError('network')):
   path=Path(t)/'new'
   with self.assertRaisesRegex(ValueError,'confirm-install'):d.install_reader(path)
   self.assertFalse(path.exists())
 def test_installer_refuses_existing_unknown_and_container_targets_before_network(self):
  with tempfile.TemporaryDirectory() as t,patch.object(d.os,'geteuid',return_value=1000),patch.object(d.urllib.request,'build_opener',side_effect=AssertionError('network')):
   with self.assertRaisesRegex(ValueError,'已存在'):d.install_reader(t,True,self.report())
   for w in [{'fingerprint':'other'},{'container':'own-wechat'}]:
    with self.assertRaisesRegex(ValueError,'自动准备范围'):d.install_reader(Path(t)/'new',True,self.report(**w))
   self.assertFalse((Path(t)/'new').exists())
 def test_installer_refuses_root_windows_and_unsupported_python(self):
  with tempfile.TemporaryDirectory() as t,patch.object(d.os,'geteuid',return_value=0):
   with self.assertRaisesRegex(ValueError,'root'):d.install_reader(Path(t)/'new',True,self.report())
  with patch.object(d.os,'name','nt'):
   with self.assertRaisesRegex(ValueError,'Windows'):d.install_reader('new',True,self.report())
  with patch.object(d.sys,'version_info',(3,13)):self.assertFalse(d.reader_plan(self.report())['can_install_keeper_component'])
 def test_archive_hash_and_traversal_refused_before_source_execution(self):
  import io,tarfile,hashlib
  with tempfile.TemporaryDirectory() as t:
   with self.assertRaisesRegex(ValueError,'SHA256'):d.unpack_keeper(b'not-source',Path(t))
   buffer=io.BytesIO()
   with tarfile.open(fileobj=buffer,mode='w:gz') as archive:
    m=tarfile.TarInfo('chatlog-keeper-'+d.KEEPER_COMMIT+'/../bad');m.size=1;archive.addfile(m,io.BytesIO(b'x'))
   data=buffer.getvalue()
   with patch.object(d,'KEEPER_SHA256',hashlib.sha256(data).hexdigest()):
    with self.assertRaisesRegex(ValueError,'路径'):d.unpack_keeper(data,Path(t))
   self.assertEqual(list(Path(t).iterdir()),[])
 def test_installer_bad_download_hash_leaves_no_directory(self):
  response=Mock();response.__enter__=Mock(return_value=response);response.__exit__=Mock(return_value=False);response.read.return_value=b'bad'
  with tempfile.TemporaryDirectory() as t,patch.object(d.os,'geteuid',return_value=1000),patch.object(d.sys,'version_info',(3,12)),patch.object(d.urllib.request,'build_opener') as opener:
   opener.return_value.open.return_value=response
   with self.assertRaisesRegex(ValueError,'SHA256'):d.install_reader(Path(t)/'new',True,self.report())
   self.assertFalse((Path(t)/'new').exists())
 def test_installer_uses_fresh_venv_pinned_source_and_never_calls_key_export_or_server(self):
  import io,tarfile,hashlib
  buffer=io.BytesIO()
  with tarfile.open(fileobj=buffer,mode='w:gz') as archive:
   m=tarfile.TarInfo('chatlog-keeper-'+d.KEEPER_COMMIT+'/pyproject.toml');m.size=1;archive.addfile(m,io.BytesIO(b'x'))
  data=buffer.getvalue();response=Mock();response.__enter__=Mock(return_value=response);response.__exit__=Mock(return_value=False);response.read.return_value=data
  with tempfile.TemporaryDirectory() as t,patch.object(d.os,'geteuid',return_value=1000),patch.object(d.sys,'version_info',(3,12)),patch.object(d,'KEEPER_SHA256',hashlib.sha256(data).hexdigest()),patch.object(d.urllib.request,'build_opener') as opener,patch.object(d.venv,'EnvBuilder') as builder,patch.object(d.subprocess,'run') as run:
   opener.return_value.open.return_value=response;result=d.install_reader(Path(t)/'new',True,self.report());self.assertTrue(result['installed']);self.assertFalse(result['account_read_verified']);self.assertFalse(result['groupdesk_runtime_verified']);self.assertEqual((Path(t)/'new').stat().st_mode&0o777,0o700);self.assertEqual((Path(t)/'new/groupdesk-reader-install.json').stat().st_mode&0o777,0o600)
   self.assertEqual(builder.return_value.create.call_count,1);self.assertEqual(run.call_count,2)
   commands=[c.args[0] for c in run.call_args_list];self.assertTrue(all('pip' in c for c in commands));self.assertIn('--only-binary=:all:',commands[0]);self.assertIn('--no-index',commands[1]);self.assertNotIn('chatlog-keeper',commands[0]);self.assertFalse(any(x in ['extract-key','decrypt','sudo','prune','server','restart'] for c in commands for x in c))

 def test_maibot_and_bridge_probe_is_exact_name_status_only(self):
  with patch.object(d,'command',return_value={'ok':True,'version':'true'}) as cmd:
   self.assertEqual(d.selected_component('own-maibot')['status'],'running');self.assertFalse(d.selected_component('own-bridge')['healthy_verified']);self.assertEqual(d.selected_component(None)['status'],'not_checked')
   for c in cmd.call_args_list:self.assertEqual(c.args[0][:5],['docker','inspect','--type','container','--format'])

class GuiAndDiagnosticTests(unittest.TestCase):
 def report(self):
  w={'detected_os':'linux','cpu_arch':'x86_64','version':'4.1.13.23','build':'','installation':'deb','fingerprint':d.LINUX_ELF};return {'detected_os':'linux','wechat':w,'reader_compatibility':d.reader_compatibility(w)}
 def test_gui_can_be_selected_without_claiming_screen_permission_or_bridge_health(self):
  with patch.object(d.urllib.request,'build_opener',side_effect=AssertionError('network')):
   plan=d.reader_plan(self.report(),'gui');self.assertEqual(plan['route'],'gui_review');self.assertEqual(plan['recommended_tool'],'gui');self.assertFalse(plan['can_install_keeper_component']);self.assertTrue(plan['requires_user_confirmation']);self.assertFalse(plan['gui']['screen_access_verified']);self.assertFalse(plan['gui']['groupdesk_gui_adapter_verified']);self.assertFalse(plan['account_read_verified'])
 def test_auto_proposes_gui_for_unverified_database_but_never_silently_falls_back(self):
  report=self.report();report['wechat']['fingerprint']='wrong';report['reader_compatibility']=d.reader_compatibility(report['wechat']);self.assertEqual(d.reader_plan(report,'auto')['route'],'compare_database_and_gui');self.assertTrue(d.reader_plan(report,'auto')['requires_user_confirmation']);self.assertEqual(d.reader_plan(report,'database')['route'],'database_review')
 def test_metadata_event_drops_unknown_fields_paths_tokens_and_messages(self):
  report={**self.report(),'token':'private-token','chat':'private text','screenshot':'private bytes','path':'/private/other'};event=d.diagnostic_event(report,'plan','planned','gui','gui');text=json.dumps(event);self.assertNotIn('private',text);self.assertNotIn('token',event);self.assertEqual(event['used_method'],'unknown');self.assertEqual(event['wechat_version'],'4.1.13.23');self.assertTrue(d.validate_diagnostics({'contract':1,'events':[event]}))
 def test_raw_log_and_secret_fields_cannot_be_uploaded(self):
  event=d.diagnostic_event({},'plan','planned')
  for field in ['api_key','stdout','chat','path','screenshot']:
   with self.assertRaises(ValueError):d.validate_diagnostics({'contract':1,'events':[{**event,field:'private'}]})
  with self.assertRaises(ValueError):d.validate_diagnostics({'contract':1,'events':[{**event,'wechat_version':'sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'}]})
 def test_selected_or_installed_gui_cannot_be_reported_as_actually_reading(self):
  for phase in ['plan','install','connect']:
   with self.assertRaises(ValueError):d.diagnostic_event({},phase,'success','gui','gui','gui')
  event=d.diagnostic_event({},'verify','success','gui','gui','gui');self.assertEqual(event['used_method'],'gui')
 def test_private_file_is_bounded_and_contains_no_raw_input(self):
  with tempfile.TemporaryDirectory() as t:
   directory=Path(t)/'own-bot'
   for _ in range(55):d.write_diagnostic(directory,d.diagnostic_event({},'plan','planned','gui','gui'))
   value=d.read_diagnostics(directory);self.assertEqual(len(value['events']),50);self.assertEqual(directory.stat().st_mode&0o777,0o700);self.assertEqual((directory/'installation-report.json').stat().st_mode&0o777,0o600);self.assertFalse(any(p.name.startswith('.report-') for p in directory.iterdir()))
 def test_reports_refuse_symlinks_and_broad_shared_directories(self):
  with tempfile.TemporaryDirectory() as t:
   root=Path(t);private=root/'private';private.mkdir(mode=0o700);link=root/'link';link.symlink_to(private,target_is_directory=True)
   with self.assertRaises(ValueError):d.write_diagnostic(link,d.diagnostic_event({},'plan','planned'))
   private.chmod(0o755)
   with self.assertRaises(ValueError):d.write_diagnostic(private,d.diagnostic_event({},'plan','planned'))
 def test_report_upload_is_own_bot_scoped_minimal_and_never_prints_bearer(self):
  with tempfile.TemporaryDirectory() as t:
   root=Path(t);connection=root/'connection';connection.mkdir(mode=0o700);reports=root/'reports';bot=str(uuid.uuid4());instance=str(uuid.uuid4());(connection/'connection.json').write_text(json.dumps({'bot_id':bot,'runtime_instance_id':instance,'url':d.APPROVED_SITE,'token':'s'*43}));(connection/'connection.json').chmod(0o600);d.write_diagnostic(reports,d.diagnostic_event({},'verify','success','gui','gui','gui'))
   response=Mock();response.__enter__=Mock(return_value=response);response.__exit__=Mock(return_value=False);response.read.return_value=b'{"ok":true}'
   with patch.object(d.urllib.request,'build_opener') as opener:
    opener.return_value.open.return_value=response;result=d.upload_diagnostics(connection,reports);request=opener.return_value.open.call_args.args[0];payload=json.loads(request.data);self.assertEqual(set(payload),{'bot_id','instance_id','report'});self.assertEqual(payload['bot_id'],bot);self.assertNotIn('s'*43,json.dumps(payload));self.assertNotIn('s'*43,str(result));self.assertEqual(request.full_url,d.APPROVED_SITE+'/api/device-onboarding/report')
 def test_upload_refuses_wrong_site_before_network(self):
  with tempfile.TemporaryDirectory() as t,patch.object(d.urllib.request,'build_opener',side_effect=AssertionError('network')):
   root=Path(t);(root/'connection.json').write_text(json.dumps({'url':'https://unapproved.example','token':'a'*43}));(root/'connection.json').chmod(0o600)
   with self.assertRaisesRegex(ValueError,'HTTPS'):d.upload_diagnostics(root,root)
 def test_pair_success_does_not_retry_or_fail_when_diagnostic_upload_is_unavailable(self):
  with tempfile.TemporaryDirectory() as t,patch.object(d.sys,'argv',['tool','pair','--site',d.APPROVED_SITE,'--bot',str(uuid.uuid4()),'--directory',t+'/connection','--report-directory',t+'/reports']),patch.object(d,'pair') as pair,patch.object(d,'upload_diagnostics',side_effect=ValueError('安装报告尚未上传')),contextlib.redirect_stdout(io.StringIO()) as output:
   d.main();self.assertEqual(pair.call_count,1);self.assertIn('安装报告尚未上传',output.getvalue());events=d.read_diagnostics(t+'/reports')['events'];self.assertEqual(events[-1]['phase'],'connect');self.assertEqual(events[-1]['outcome'],'success');self.assertEqual(events[-1]['used_method'],'unknown')

 def test_reports_reject_non_string_fields_boolean_contract_and_success_with_unknown_method(self):
  event=d.diagnostic_event({},'plan','planned')
  for extra in [{'contract':True},{'generated_at':{}},{'report_id':42},{'phase':[]}]:
   with self.assertRaises(ValueError):d.validate_diagnostics({'contract':1,'events':[{**event,**extra}]})
  with self.assertRaises(ValueError):d.diagnostic_event({},'verify','success')
 def test_later_step_context_keeps_only_prior_safe_version_metadata(self):
  with tempfile.TemporaryDirectory() as t:
   directory=Path(t)/'reports';d.write_diagnostic(directory,d.diagnostic_event(self.report(),'inspect','info'))
   event=d.diagnostic_event(d.diagnostic_context(directory),'verify','success','gui','gui','gui');self.assertEqual(event['wechat_version'],'4.1.13.23');self.assertEqual(event['platform'],'linux');self.assertNotIn('path',event)
if __name__=='__main__':unittest.main()
