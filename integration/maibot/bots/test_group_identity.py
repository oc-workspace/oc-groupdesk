import copy,hashlib,json,tempfile,unittest,uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch
import bot_identity,bot_names,groupdesk_runtime as gd
from install_group_identity import patched

def bundle(group=None,names=None,bot=None):
    gid=group or str(uuid.uuid4());bid=bot or str(uuid.uuid4())
    value={'bot_id':bid,'group_id':gid,'display_name':'Tatsumi','self_reference':None,'mention_names':names if names is not None else ['Tatsumi']}
    sha=hashlib.sha256(json.dumps([1,bid,gid,'Tatsumi',None,value['mention_names']],ensure_ascii=False,separators=(',',':')).encode()).hexdigest()
    return {'id':gid,'bot_identity_contract_version':1,'bot_identity':value,'bot_identity_sha256':sha,'bot_name_instructions':['You are the named bot, not another person.']}

class NamingTests(unittest.TestCase):
    def test_scoped_literals_and_empty_list(self):
        a,b=bundle(names=['Little T','T.+']),bundle(names=[])
        class Policy:
            cfg={'managed_groups':{'a':a,'b':b}}
            @bot_names.scoped_names
            def ingest(self,seq,sender,text,timestamp=None,at_me=False,chat_id=''):
                return bool(at_me or bot_names.NAME.search(text))
        p=Policy()
        for chat,text,want in [('a','@Little T hi',True),('a','T.+ hello',True),('a','Txx hello',False),('b','Little T hello',False),('a','Little Team',False)]:self.assertEqual(p.ingest(1,'sender',text,chat_id=chat),want)
        self.assertTrue(p.ingest(2,'s','anything',at_me=True,chat_id='b'))
        self.assertFalse(bot_names.addressed(p.cfg,'b','T.+'))
        with ThreadPoolExecutor(max_workers=2) as pool:self.assertEqual(list(pool.map(lambda chat:p.ingest(1,'s','Little T',chat_id=chat),['a','b']*50)),[True,False]*50)
        self.assertIsNone(bot_names._scoped.get())
    def test_scope_resets_after_failure(self):
        class P:
            cfg={'managed_groups':{'a':bundle(names=['Only A'])}}
            @bot_names.scoped_names
            def ingest(self,seq,sender,text,timestamp=None,at_me=False,chat_id=''):
                raise RuntimeError('synthetic')
        with self.assertRaises(RuntimeError):P().ingest(1,'s','text',chat_id='a')
        self.assertIsNone(bot_names._scoped.get())
    def test_contract_scope_hash_and_names_fail_closed(self):
        p=bundle();self.assertEqual(bot_identity.validate_bundle(p,p['bot_identity']['bot_id']),p['bot_identity'])
        for mutate in [lambda x:x.update(id=str(uuid.uuid4())),lambda x:x.update(bot_identity_sha256='0'*64),lambda x:x['bot_identity'].update(mention_names=['T','t']),lambda x:x.update(bot_name_instructions='bad')]:
            b=copy.deepcopy(p);mutate(b)
            with self.assertRaises(ValueError):bot_identity.validate_bundle(b)
        with self.assertRaises(ValueError):bot_identity.validate_bundle(p,str(uuid.uuid4()))
    def test_installer_rejects_unknown_policy_shape_and_is_repeatable(self):
        s='from bot_names import NAME\nclass Policy:\n    def ingest(self, seq, sender, text, timestamp=None, at_me=False,chat_id=""):\n        return NAME.search(text)\n'
        out=patched(s);self.assertEqual(patched(out),out);self.assertIn('@scoped_names',out)
        with self.assertRaises(ValueError):patched(s.replace('chat_id','room'))
    def test_sync_ack_and_prompt_cover_identity_even_short(self):
        from test_groupdesk_runtime import bundle as oldbundle
        p=oldbundle();p.update(bundle());p['enabled']=True;p['policy']['identity']={'disclosure':'when_asked','personal_questions':'tactful'}
        acks=[]
        def api(path,body=None):
            if path.startswith('/config/'):return p
            if path=='/ack':acks.append(body);return {'ok':True}
            raise AssertionError(path)
        with tempfile.TemporaryDirectory() as directory:
            connection=Path(directory)/'connection.json';connection.write_text(json.dumps({'groups':{'a':p['external_id']},'bot_id':p['bot_identity']['bot_id']}))
            with patch.object(gd,'CONNECTION',connection),patch.object(gd,'SNAPSHOT',Path(directory)/'snapshot'),patch.object(gd,'api',side_effect=api):self.assertTrue(gd.sync()['a']['enabled'])
        self.assertEqual(acks[0]['bot_identity_sha256'],p['bot_identity_sha256']);self.assertEqual(acks[0]['bot_identity_version'],1)
        for short in [True,False]:self.assertTrue(gd.generation_rules(p,short=short).endswith(p['bot_name_instructions'][-1]))

if __name__=='__main__':unittest.main()
