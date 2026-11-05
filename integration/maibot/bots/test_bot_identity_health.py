import json,tempfile,unittest
from pathlib import Path
from types import SimpleNamespace as N
from unittest.mock import patch
import bot_names as names,bot_health as health

class NamesTests(unittest.TestCase):
 def test_literals_boundaries_case_and_unicode_space(self):
  p=names.compile_names(['Tatsumi','Tatsumisaki'])
  for s in ['@Tatsumi\u2005给你注入灵魂了，说句话','tatsumi，hello','@Tatsumisaki hi']:self.assertIsNotNone(p.search(s))
  for s in ['OtherTatsumi','Tatsumiverse','小T','GT小跟班']:self.assertIsNone(p.search(s))
  self.assertEqual(p.sub('','@Tatsumi hi'),'@ hi')
  self.assertIsNotNone(names.compile_names(['a.b']).search('@a.b '));self.assertIsNone(names.compile_names(['a.b']).search('@axb '))
 def test_new_instance_never_inherits_legacy_names_and_overrides_reload(self):
  with tempfile.TemporaryDirectory() as t,patch.object(names.gd,'CONNECTION',Path(t)/'connection.json'):
   names.gd.CONNECTION.write_text(json.dumps({'bot_id':'new'}));self.assertIsNone(names.NAME.search('小T'))
   p=Path(t)/'mention-names.json';p.write_text('["Tatsumi"]');self.assertIsNotNone(names.NAME.search('@Tatsumi '))
   p.write_text('["RyuBuddy"]');self.assertIsNone(names.NAME.search('@Tatsumi '));self.assertIsNotNone(names.NAME.search('@RyuBuddy '))
 def test_invalid_config_fails_closed(self):
  for nameset in [[],[''],['x'*81],'.*']:
   with self.assertRaises(ValueError):names.compile_names(nameset)

class HealthTests(unittest.TestCase):
 def test_first_report_then_hourly_and_scoped_no_models_or_history(self):
  with tempfile.TemporaryDirectory() as t:
   b=N(state_dir=Path(t),router=N(check_connection=lambda p:True));calls=[]
   def api(path,body=None):calls.append((path,body));return {'configured':False} if path=='/notification' else {'ok':True}
   with patch.object(health.gd,'api',side_effect=api):
    for now in [10000,10030,13000,13600]:health.report(b,{'groups':{'1':'own'}},{'wechat_connected':True,'running':True},True,True,now)
   reports=[v for path,v in calls if path=='/health'];self.assertEqual(len(reports),2);self.assertTrue(all(r['state']=='online' and r['external_id']=='own' for r in reports))
 def test_recovery_updates_without_waiting_an_hour(self):
  with tempfile.TemporaryDirectory() as t:
   b=N(state_dir=Path(t),router=N(check_connection=lambda p:True));conf={'groups':{'1':'own'}}
   with patch.object(health.gd,'api',return_value={'configured':False}) as api:
    health.report(b,conf,{'running':True,'wechat_connected':False},True,True,10000)
    health.report(b,conf,{'running':True,'wechat_connected':True},True,True,10060)
    self.assertEqual(api.call_args.args[1]['state'],'online')
 def test_reader_down_pause_and_bounded_retry(self):
  with tempfile.TemporaryDirectory() as t:
   b=N(state_dir=Path(t),router=N(check_connection=lambda p:True));conf={'groups':{'1':'own'}};status={'wechat_connected':True,'running':True}
   with patch.object(health.gd,'api',return_value={'configured':False}) as api:
    health.report(b,conf,status,False,True,10000);self.assertEqual(api.call_args.args[1]['reason'],'chatlog_reader_unavailable')
    health.report(b,conf,status,False,False,14000);self.assertEqual(api.call_args.args[1]['state'],'maintenance')
   with patch.object(health.gd,'api',side_effect=OSError('offline')) as api:
    with self.assertRaises(OSError):health.report(b,conf,status,True,True,18000)
    health.report(b,conf,status,True,True,18030);self.assertEqual(api.call_count,2)
if __name__=='__main__':unittest.main()
