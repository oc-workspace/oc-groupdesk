import unittest,uuid
from render_stack import render
class StackTests(unittest.TestCase):
 def test_two_accounts_share_no_persist_paths_or_network_names(self):
  images={k:'sha256:'+'a'*64 for k in ['maibot','wechat','reader']}
  a=render(str(uuid.uuid4()),'wx_new',[18101,18180,18543,18187],images);b=render(str(uuid.uuid4()),'wx_other',[18201,18280,18643,18287],images)
  self.assertNotEqual(a['persist'],b['persist']);self.assertNotEqual(a['compose']['name'],b['compose']['name'])
  for stack in [a,b]:
   self.assertNotIn('external',stack['compose']['networks']['data'])
   self.assertEqual(stack['compose']['services']['reader']['networks']['data']['aliases'],['chatlog-reader'])
   for name,service in stack['compose']['services'].items():
    self.assertNotIn('container_name',service)
    for port in service.get('ports',[]):self.assertTrue(port.startswith('127.0.0.1:'))
    for mount in service.get('volumes',[]):self.assertNotIn('/opt/persist/maibot-wechat',mount);self.assertNotIn('docker.sock',mount)
    if name!='wechat':self.assertEqual(service['profiles'],['runtime'])
 def test_refuses_legacy_bad_images_or_port_collisions(self):
  images={k:'sha256:'+'a'*64 for k in ['maibot','wechat','reader']}
  for id,ports,im in [('00000000-0000-4000-8000-000000000001',[18101,18180,18543,18187],images),(str(uuid.uuid4()),[18080]*4,images),(str(uuid.uuid4()),[18101,18180,18543,18187],{**images,'maibot':'latest'})]:
   with self.assertRaises(ValueError):render(id,'wx_new',ports,im)
if __name__=='__main__':unittest.main()
