import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from capture_reader import paths,selection

BOT='11111111-2222-4333-8444-555555555555'

class CaptureScopeTest(unittest.TestCase):
    def test_refuse_legacy_or_noncanonical_paths(self):
        for value in ['00000000-0000-4000-8000-000000000001','../../etc','11111111222243338444555555555555']:
            with self.assertRaises(ValueError):paths(value)

    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.base=Path(self.temp.name).resolve();self.root=self.base/'deployment';self.persist=self.base/'persist';self.root.mkdir();self.persist.mkdir()
        account='wxid_synthetic'
        (self.persist/'wechat/xwechat_files'/account/'db_storage').mkdir(parents=True)
        (self.persist/'groupdesk').mkdir();(self.persist/'reader/config').mkdir(parents=True)
        self.meta={'bot_id':BOT,'deployment':str(self.root),'persist':str(self.persist),'wechat_id':'synthetic','runtime_instance_id':BOT}
        self.connection={'bot_id':BOT,'wechat_id':'synthetic','runtime_instance_id':BOT,'account_fingerprint':hashlib.sha256(account.encode()).hexdigest(),'groups':{'1':'synthetic-chat'}}
        self.settings={'account':account,'groups':[{'chat_id':1,'name':'Synthetic group'}]}
        (self.root/'compose.json').write_text(json.dumps({'services':{'reader':{'image':'sha256:'+'a'*64}}}))
        self.save()

    def tearDown(self):self.temp.cleanup()

    def save(self):
        for path,value in [(self.root/'deployment.json',self.meta),(self.persist/'groupdesk/connection.json',self.connection),(self.persist/'reader/config/reader.json',self.settings)]:path.write_text(json.dumps(value))

    def choose(self,docker='null'):
        with patch('capture_reader.paths',return_value=(self.root,self.persist,'gdbot-synthetic')),patch('capture_reader.output',return_value=docker):return selection(BOT)

    def test_own_account_and_groups_are_selected(self):self.assertEqual(self.choose()[4],self.persist/'wechat/xwechat_files/wxid_synthetic/db_storage')

    def test_foreign_account_fingerprint_is_refused(self):
        self.connection['account_fingerprint']='b'*64;self.save()
        with self.assertRaises(ValueError):self.choose()

    def test_foreign_group_scope_is_refused(self):
        self.connection['groups']={'2':'another-chat'};self.save()
        with self.assertRaises(ValueError):self.choose()

    def test_existing_runtime_is_never_interrupted_for_capture(self):
        with self.assertRaises(ValueError):self.choose('{"ID":"synthetic-running-container"}')

    def test_database_symlink_outside_own_wechat_tree_is_refused(self):
        db=self.persist/'wechat/xwechat_files/wxid_synthetic/db_storage';db.rmdir()
        outside=self.base/'foreign-db';outside.mkdir();db.symlink_to(outside)
        with self.assertRaises(ValueError):self.choose()

if __name__=='__main__':unittest.main()
