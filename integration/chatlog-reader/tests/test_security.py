import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from chatlog_reader.vault import initialize,wrap,unwrap,private_write
from chatlog_reader.server import Handler
from chatlog_reader.store import Store

class VaultTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.folder=tempfile.TemporaryDirectory();cls.root=Path(cls.folder.name)
        initialize(cls.root/'secrets',cls.root/'client')
    @classmethod
    def tearDownClass(cls):cls.folder.cleanup()
    def test_only_wrapped_database_key_is_persisted(self):
        key=bytes(range(32))
        envelope=wrap(key,'synthetic-account',self.root/'secrets/vault-public.pem')
        private_write(self.root/'secrets/wechat-key.enc',envelope)
        self.assertEqual(unwrap(envelope,'synthetic-account',self.root/'secrets/vault-private.pem'),key)
        for path in (self.root/'secrets').iterdir():
            self.assertEqual(path.stat().st_mode&0o777,0o600)
            self.assertNotIn(key,path.read_bytes())
            self.assertNotIn(key.hex().encode(),path.read_bytes())
    def test_account_mismatch_and_ciphertext_tampering_are_rejected(self):
        envelope=wrap(b'k'*32,'synthetic-account',self.root/'secrets/vault-public.pem')
        with self.assertRaises(ValueError):unwrap(envelope,'another-account',self.root/'secrets/vault-private.pem')
        data=json.loads(envelope);data['ciphertext']=data['ciphertext'][:-8]+'AAAAAAAA'
        with self.assertRaises(ValueError):unwrap(json.dumps(data),'synthetic-account',self.root/'secrets/vault-private.pem')
    def test_init_is_idempotent_and_does_not_rotate_credentials(self):
        private=(self.root/'secrets/vault-private.pem').read_bytes();token=(self.root/'client/api-token').read_bytes()
        initialize(self.root/'secrets',self.root/'client')
        self.assertEqual(private,(self.root/'secrets/vault-private.pem').read_bytes())
        self.assertEqual(token,(self.root/'client/api-token').read_bytes())

class HTTPTests(unittest.TestCase):
    def setUp(self):
        self.folder=tempfile.TemporaryDirectory();self.addCleanup(self.folder.cleanup)
        store=Store(Path(self.folder.name)/'archive.db','synthetic',[{'chat_id':1,'name':'Synthetic'}])
        class Fake:
            def status(self):return {'ok':True,'source':'chatlog-keeper','state':'ready','epoch':store.epoch,'last_checked':time.time()}
            def sync(self):pass
            def page(self,*args):return {**store.page(*args),'last_checked':time.time()}
        engine=Fake();engine.store=store
        self.server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
        self.server.engine=engine;self.server.token='a'*64;self.server.daemon_threads=True
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
        self.addCleanup(self.close)
        self.url='http://127.0.0.1:'+str(self.server.server_port)
    def close(self):self.server.shutdown();self.thread.join();self.server.server_close()
    def get(self,path,authorized=True):
        request=urllib.request.Request(self.url+path,headers={'Authorization':'Bearer '+('a'*64 if authorized else 'wrong')})
        with urllib.request.urlopen(request,timeout=3) as response:return json.load(response)
    def rejects(self,path,code,authorized=True):
        with self.assertRaises(urllib.error.HTTPError) as raised:self.get(path,authorized)
        self.assertEqual(raised.exception.code,code)
        raised.exception.close()
    def test_message_api_requires_the_internal_credential(self):self.rejects('/v1/stream?chat=1',401,False)
    def test_group_scope_and_private_paths_cannot_be_enumerated(self):
        self.rejects('/v1/stream?chat=2',404)
        self.rejects('/v1/key',404)
        self.rejects('/secrets/vault-private.pem',404)
    def test_health_does_not_expose_keys_or_group_content(self):
        result=self.get('/healthz',False)
        self.assertEqual(set(result),{'ok','source','state'})
    def test_duplicate_parameters_nonfinite_times_and_long_ranges_are_rejected(self):
        self.rejects('/v1/stream?chat=1&chat=2',400)
        self.rejects('/v1/history?chat=1&start=NaN&end=1',400)
        self.rejects('/v1/history?chat=1&start=1&end=99999999',400)
    def test_history_reconciles_on_demand_after_authorization(self):
        from unittest.mock import Mock
        self.server.engine.sync=Mock()
        path='/v1/history?chat=1&start='+str(time.time()-60)+'&end='+str(time.time()-1)
        self.rejects(path,401,False);self.server.engine.sync.assert_not_called()
        self.get(path);self.server.engine.sync.assert_called_once()
    def test_event_monitor_metadata_requires_authentication(self):
        from types import SimpleNamespace
        self.server.monitor=SimpleNamespace(snapshot=lambda:{'mode':'inotify','periodic_scan_seconds':None})
        self.assertEqual(self.get('/v1/status')['monitor']['mode'],'inotify')
        self.rejects('/v1/status',401,False)
        self.assertNotIn('monitor',self.get('/healthz',False))
    def test_tail_is_empty_and_creates_a_fresh_cutover_boundary(self):
        result=self.get('/v1/stream?chat=1&after=tail')
        self.assertEqual(result['messages'],[]);self.assertGreater(result['cutover_at'],0)

if __name__=='__main__':unittest.main()
