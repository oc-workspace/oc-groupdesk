import copy,sqlite3,unittest
from banter import validate,guide,candidate

def profile():return {'enabled':True,'conversation_policy_contract_version':1,'interaction':'topic','policy':{'topic_scope':'proactive','participation':'active','conversation':{'enabled':True,'banter_replies':True,'frequency':'high','instructions':''}}}
class BanterTests(unittest.TestCase):
 def test_contract_opt_in_and_malformed_policy(self):
  validate({'policy':{}});p=profile();validate(p)
  p['conversation_policy_contract_version']=2
  with self.assertRaises(ValueError):validate(p)
  p=profile();p['policy']['conversation']['enabled']='true'
  with self.assertRaises(ValueError):validate(p)
 def test_serious_questions_language_and_boundary_guidance(self):
  p=profile();self.assertIn('认真问题认真答',guide(p));self.assertIn('不把反讽当事实',guide(p));self.assertIn('配额',guide(p))
  p['policy']['conversation']['banter_replies']=False;self.assertIn('不主动接梗',guide(p))
  p['policy']['conversation']['enabled']=False;self.assertEqual(guide(p),'')
 def test_extra_admission_is_group_scoped_and_cannot_override_quiet_mention_or_scope(self):
  db=sqlite3.connect(':memory:');p=profile()
  self.assertTrue(candidate(db,p,'a',1,'a potential joke',100,[]));self.assertFalse(candidate(db,p,'a',2,'another joke',101,[]))
  self.assertTrue(candidate(db,p,'b',2,'another joke',101,[]));self.assertTrue(candidate(db,p,'a',3,'another joke',161,[]))
  for field,value in [('participation','quiet'),('topic_scope','all')]:
   q=copy.deepcopy(p);q['policy'][field]=value;self.assertFalse(candidate(db,q,'c',9,'another joke',999,[]))
  p['interaction']='mention';self.assertFalse(candidate(db,p,'d',10,'another joke',999,[]))
 def test_disabled_group_does_not_gain_new_candidates(self):
  db=sqlite3.connect(':memory:');p=profile();p['enabled']=False;self.assertFalse(candidate(db,p,'a',1,'another joke',999,[]))
if __name__=='__main__':unittest.main()
