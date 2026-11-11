import json
from pathlib import Path
from http.server import ThreadingHTTPServer
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request

from chatlog_reader.server import Handler
from chatlog_reader.store import Store

class ReferenceHTTPTests(unittest.TestCase):
    def setUp(self):
        self.folder=tempfile.TemporaryDirectory();self.addCleanup(self.folder.cleanup)
        store=Store(Path(self.folder.name)/'archive.db','synthetic',[{'chat_id':1,'name':'A'}])
        store.ingest('synthetic',1,[{'native_key':'one','chat_id':1,'sender_id':'bot','sender':None,
            'content':'Summary first part','source_at':100,'observed_at':101,'is_self':1,
            'msg_type':1,'server_id':'123','is_summary':1}],1)
        class Engine:
            def __init__(self):self.store=store
            def status(self):return {'ok':True,'source':'test','state':'ready','last_checked':time.time()}
            def quote_target(self,chat,server_id):return {'epoch':store.epoch,'last_checked':time.time(),
                'messages':[],'target':store.quote_target(chat,server_id)}
        self.server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
        self.server.engine=Engine();self.server.token='a'*64
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
        self.addCleanup(self.close)
    def close(self):
        self.server.shutdown();self.thread.join();self.server.server_close()
    def fetch(self,path,authorized=True):
        url='http://127.0.0.1:'+str(self.server.server_port)+path
        request=urllib.request.Request(url,headers={'Authorization':'Bearer '+('a'*64 if authorized else 'wrong')})
        with urllib.request.urlopen(request,timeout=3) as response:return json.load(response)
    def test_reference_requires_token_and_same_group(self):
        with self.assertRaises(urllib.error.HTTPError) as error:self.fetch('/v1/reference?chat=1&server_id=123',False)
        self.assertEqual(error.exception.code,401);error.exception.close()
        with self.assertRaises(urllib.error.HTTPError) as error:self.fetch('/v1/reference?chat=2&server_id=123')
        self.assertEqual(error.exception.code,404);error.exception.close()
        target=self.fetch('/v1/reference?chat=1&server_id=123')['target']
        self.assertEqual((target['server_id'],target['content'],target['unique_text']),('123','Summary first part',True))

if __name__=='__main__':unittest.main()
