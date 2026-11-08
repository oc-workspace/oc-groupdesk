import contextlib,io,json,tempfile,unittest,uuid
from pathlib import Path
from unittest.mock import patch,Mock
import device_setup as d
class DeviceSetupTests(unittest.TestCase):
 def test_inspect_does_not_write_or_network_and_unknown_stays_unverified(self):
  with patch.object(d.platform,'system',return_value='Windows'),patch.object(d.shutil,'which',return_value=None),patch.object(d.urllib.request,'build_opener',side_effect=AssertionError('network')):
   result=d.inspect_device()
  self.assertEqual(result['detected_os'],'windows');self.assertFalse(result['changes_made']);self.assertFalse(result['docker']['ok']);self.assertIn('未验证',result['compatibility'])
 def test_existing_directory_and_non_https_refused_before_code_input(self):
  with tempfile.TemporaryDirectory() as t,patch.object(d.getpass,'getpass',side_effect=AssertionError('input')):
   with self.assertRaises(ValueError):d.pair('https://example.com',str(uuid.uuid4()),t)
   for url in ['http://example.com','https://name:secret@example.com','https://example.com/?token=secret']:
    with self.assertRaises(ValueError):d.pair(url,str(uuid.uuid4()),t+'/new')
 def test_pair_posts_only_minimal_fields_and_saves_private_never_prints_token(self):
  bot=str(uuid.uuid4());response=Mock();opener=Mock()
  def perform(req,timeout):
   payload=json.loads(req.data);self.assertEqual(set(payload),{'bot_id','instance_id','code','detected_os'})
   value={'contract':1,'bot_id':bot,'runtime_instance_id':payload['instance_id'],'url':'https://example.com','token':'a'*43,'groups':{}}
   response.__enter__=Mock(return_value=response);response.__exit__=Mock(return_value=False);response.read.return_value=json.dumps(value).encode();return response
  opener.open.side_effect=perform
  with tempfile.TemporaryDirectory() as t,patch.object(d.getpass,'getpass',return_value='b'*43),patch.object(d.urllib.request,'build_opener',return_value=opener),contextlib.redirect_stdout(io.StringIO()) as output:
   path=Path(t)/'new';d.pair('https://example.com',bot,path);self.assertEqual((path/'connection.json').stat().st_mode&0o777,0o600);self.assertEqual(path.stat().st_mode&0o777,0o700);self.assertNotIn('a'*43,output.getvalue());self.assertNotIn('b'*43,output.getvalue())
 def test_pair_rejects_other_bot_without_writing(self):
  with tempfile.TemporaryDirectory() as t,patch.object(d.getpass,'getpass',return_value='b'*43),patch.object(d.urllib.request,'build_opener') as opener:
   opener.return_value.open.return_value.__enter__.return_value.read.return_value=b'{"bot_id":"wrong"}'
   with self.assertRaises(ValueError):d.pair('https://example.com',str(uuid.uuid4()),Path(t)/'new')
   self.assertFalse((Path(t)/'new').exists())
if __name__=='__main__':unittest.main()
