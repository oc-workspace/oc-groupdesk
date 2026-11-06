import tempfile,time,unittest
from pathlib import Path
from chatlog_reader.references import text_reference
from chatlog_reader.store import Store
from chatlog_runtime import ReaderAgent
from types import SimpleNamespace as N
import test_engine

def xml(title='A new reply',server='103',subtype='57'):
 return f'<msg><appmsg><title>{title}</title><type>{subtype}</type><refermsg><svrid>{server}</svrid><displayname>小T</displayname><content>OLD QUOTED CONTENT</content></refermsg></appmsg></msg>'

class ReferenceParserTests(unittest.TestCase):
 def test_authored_title_is_separate_from_quoted_content(self):
  value=text_reference('wxid_member:\n'+xml('Hello &amp; good morning'))
  self.assertEqual(value['content'],'Hello & good morning');self.assertNotIn('OLD',value['content']);self.assertEqual(value['reference_server_id'],'103')
 def test_other_app_messages_and_unsafe_xml_are_not_promoted(self):
  for raw in [xml(subtype='5'),'<msg>',xml(' '),'<!DOCTYPE msg [<!ENTITY x "unsafe">]>'+xml('&x;'),'x'*262145]:self.assertIsNone(text_reference(raw))
 def test_invalid_reference_id_does_not_invent_a_bot_reference(self):
  self.assertIsNone(text_reference(xml(server='not-an-id'))['reference_server_id'])

class QuotedEngineTests(unittest.TestCase):
 setUp=test_engine.EngineTests.setUp
 table=test_engine.EngineTests.table
 add=test_engine.EngineTests.add
 def add_quote(self,group='native-a@chatroom',server='103',message_id=120):
  import sqlite3
  db=sqlite3.connect(self.message)
  db.execute('INSERT INTO '+self.table(group)+' VALUES(49,?,?,?,?,NULL)',(int(time.time())-1,2,xml(server=server),message_id));db.commit();db.close()
 def test_reference_to_verified_bot_is_authored_text_and_explicit(self):
  self.add_quote();self.engine.sync();row=self.engine.page(1,0,200)['messages'][-1]
  self.assertEqual(row['content'],'A new reply');self.assertEqual(row['msg_type'],49);self.assertTrue(row['reference']['is_bot']);self.assertEqual(row['reference']['bot_text'],'Own normal reply')
  with tempfile.TemporaryDirectory() as d:
   a=ReaderAgent(N(consumer='synthetic'),d,'http://chatlog-reader:5030','unused');message=a.message(row,1,self.engine.store.epoch,live=True)
   self.assertEqual(a.message(row,1,self.engine.store.epoch,live=False).content,'A new reply')
  self.assertEqual(message.message_type,'text');self.assertTrue(message.is_at_me);self.assertTrue(message.content.startswith('A new reply\n'));self.assertIn('Own normal reply',message.content);self.assertIn('引用 当前机器人 的消息',message.content);self.assertNotIn('引用 小T 的消息',message.content)
 def test_reference_to_other_member_with_bot_display_name_is_not_explicit(self):
  self.add_quote(server='101');self.engine.sync();row=self.engine.page(1,0,200)['messages'][-1];self.assertFalse(row['reference']['is_bot']);self.assertNotIn('bot_text',row['reference'])
  with tempfile.TemporaryDirectory() as d:
   a=ReaderAgent(N(consumer='synthetic'),d,'http://chatlog-reader:5030','unused');m=a.message(row,1,self.engine.store.epoch,live=True)
  self.assertEqual(m.message_type,'text');self.assertFalse(m.is_at_me);self.assertEqual(m.content,'A new reply')
 def test_cross_group_reference_is_not_explicit(self):
  self.add('native-b@chatroom',1,'BOT IN OTHER GROUP',130);self.add_quote(server='130');self.engine.sync();row=self.engine.page(1,0,200)['messages'][-1];self.assertFalse(row['reference']['is_bot']);self.assertNotIn('BOT IN OTHER GROUP',str(row['reference']))
 def test_missing_original_does_not_trust_name_or_claimed_identity(self):
  self.add_quote(server='999999');self.engine.sync();row=self.engine.page(1,0,200)['messages'][-1];self.assertFalse(row['reference']['is_bot'])
 def test_reference_upgrade_keeps_sequence_and_first_observation(self):
  self.add_quote();self.engine.sync();before=self.engine.page(1,0,200)['messages'][-1]
  with self.engine.store.connect() as db:db.execute('UPDATE messages SET reference_kind=NULL,reference_server_id=NULL WHERE seq=?',(before['seq'],))
  self.engine.signatures.clear();self.engine.sync();after=self.engine.page(1,0,200)['messages'][-1]
  self.assertEqual(before['seq'],after['seq']);self.assertEqual(before['observed_at'],after['observed_at']);self.assertTrue(after['reference']['is_bot'])
 def test_normal_text_and_nonquote_media_keep_original_types(self):
  self.engine.sync();rows=self.engine.page(1,0,200)['messages'];self.assertNotIn('reference',rows[0]);self.assertEqual(rows[0]['msg_type'],1)

if __name__=='__main__':unittest.main()
