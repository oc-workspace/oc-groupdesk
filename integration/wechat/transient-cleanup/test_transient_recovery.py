import tempfile,time,unittest
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch,Mock
from bowxt import WeChatClient
from bowxt.models import ChatType,Direction,Rect
from bowxt.service import BowxtService
from bowxt.store import SQLiteStore
from bowxt.transient_recovery import begin_profile,observe_profile,cleanup_owned_profile,sender_ready,sender_started
from fakes import FakeNode,FakeAccessibility,FakeInput,sample_tree
from test_store import incoming
import test_client as client_fixtures
from test_service import FakeServiceClient

class OwnedProfileTests(unittest.TestCase):
 def fixture(self):
  root,access,inputs=client_fixtures.ClientTests._profile_fixture(closes_on_escape=False)
  inputs.is_active_wechat_window=lambda:True
  inputs.shortcut_active_wechat=lambda *keys:None
  client=WeChatClient(accessibility=access,input_backend=inputs,uia_sender=True,sleeper=lambda _:None).connect()
  with self.assertRaises(RuntimeError):client.get_visible_messages(chat_type=ChatType.GROUP)
  self.assertTrue(client.is_input_blocked)
  return client,access,inputs
 def test_owned_profile_can_be_closed_but_old_session_stays_locked(self):
  c,a,i=self.fixture();calls=[]
  def close(*keys):calls.append(keys);a.popup=None
  i.shortcut_active_wechat=close
  self.assertTrue(cleanup_owned_profile(c));self.assertEqual(calls,[('esc',)]);self.assertTrue(c.is_input_blocked)
  self.assertFalse(cleanup_owned_profile(c));self.assertEqual(len(calls),1)
  before=len(i.events)
  with self.assertRaises(Exception):c.send_text('测试群','not allowed')
  self.assertEqual(before,len(i.events))
 def test_preexisting_or_unowned_window_never_gets_escape(self):
  c,a,i=self.fixture();a.popup.token='unowned';i.shortcut_active_wechat=Mock()
  self.assertFalse(cleanup_owned_profile(c));i.shortcut_active_wechat.assert_not_called()
 def test_named_unknown_dialog_is_not_treated_as_avatar_popover(self):
  c,a,i=self.fixture();a.popup.role='dialog';a.popup.name='Incoming Call';i.shortcut_active_wechat=Mock()
  self.assertFalse(cleanup_owned_profile(c));i.shortcut_active_wechat.assert_not_called()
 def test_non_wechat_focus_never_gets_keyboard_input(self):
  c,a,i=self.fixture();i.is_active_wechat_window=lambda:False;i.shortcut_active_wechat=Mock()
  self.assertFalse(cleanup_owned_profile(c));i.shortcut_active_wechat.assert_not_called()
 def test_changed_main_window_or_chat_and_expired_ownership_are_rejected(self):
  for mode in ['root','chat','age']:
   c,a,i=self.fixture();i.shortcut_active_wechat=Mock()
   if mode=='root':a.root.token='different-root'
   if mode=='chat':c._is_chat_open=lambda *_:False;c._verified_controls=lambda *_:None
   if mode=='age':c._profile_lease['started']-=31
   self.assertFalse(cleanup_owned_profile(c));i.shortcut_active_wechat.assert_not_called()
 def test_empty_avatar_created_filler_is_owned_but_modal_is_not(self):
  root,_=sample_tree();c=SimpleNamespace();window=FakeNode('filler',bounds=Rect(400,150,280,594),token='profile')
  begin_profile(c,root,'测试群',{root.identity});observe_profile(c,root,[window]);self.assertIn('profile',c._profile_lease['owned'])
  c=SimpleNamespace();window.states={'modal'};begin_profile(c,root,'测试群',{root.identity});observe_profile(c,root,[window]);self.assertFalse(c._profile_lease['owned'])

class SenderAndDirectionTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.store=SQLiteStore(Path(self.tmp.name)/'messages.db')
 def test_known_nickname_does_not_open_avatar_just_to_fetch_organization(self):
  client=FakeServiceClient();client.uia_sender=True;client.get_visible_messages=lambda *a,**k:[incoming('arrival:1')]
  client.enrich_visible_senders=Mock(side_effect=AssertionError('No avatar click'))
  service=BowxtService(self.store,client_factory=lambda:client);chat=service.add_chat('测试群',ChatType.GROUP)
  service._poll_chat(client,chat);self.assertEqual(service.status()['sender_queue_depth'],0);client.enrich_visible_senders.assert_not_called()
 def test_stable_arrival_preserves_known_direction_and_original_first_capture(self):
  for direction in [Direction.INCOMING,Direction.OUTGOING]:
   original=replace(incoming('arrival:'+direction.value),direction=direction,sender=None)
   first,_=self.store.save_message(original);later,created=self.store.save_message(replace(original,direction=Direction.UNKNOWN))
   self.assertFalse(created);self.assertEqual(later.direction,direction.value);self.assertEqual(later.observed_at,first.observed_at)
 def test_unknown_direction_is_never_upgraded_without_evidence(self):
  m=replace(incoming('arrival:unknown'),direction=Direction.UNKNOWN,sender=None)
  self.store.save_message(m);stored,_=self.store.save_message(m);self.assertEqual(stored.direction,'unknown')
 def test_sender_read_retries_back_off_are_bounded_and_do_not_block_another_member(self):
  service=BowxtService(self.store);key=(1,'arrival:one')
  with patch('bowxt.transient_recovery.time.monotonic',return_value=100):
   sender_started(service,key);service._queue_sender_job(*key);self.assertEqual(service.status()['sender_queue_depth'],0)
  with patch('bowxt.transient_recovery.time.monotonic',return_value=103):
   service._queue_sender_job(*key);job=service._next_sender_job();self.assertEqual(job.message_id,key[1]);sender_started(service,key)
   service._queue_sender_job(1,'arrival:other');self.assertEqual(service._next_sender_job().message_id,'arrival:other')
  with patch('bowxt.transient_recovery.time.monotonic',return_value=112):sender_started(service,key)
  with patch('bowxt.transient_recovery.time.monotonic',return_value=200):service._queue_sender_job(*key);self.assertIsNone(service._next_sender_job())
 def test_failed_sender_can_retry_without_becoming_a_new_message(self):
  client=FakeServiceClient();client.uia_sender=True;m=replace(incoming('arrival:retry'),sender=None)
  client.get_visible_messages=lambda *a,**k:[m];count=[0]
  def enrich(items,**kwargs):
   count[0]+=1
   if count[0]==1:raise RuntimeError('temporary UI lock')
   return [replace(items[0],sender='Synthetic member',raw={'sender_source':'profile_uia'})]
  client.enrich_visible_senders=enrich
  service=BowxtService(self.store,client_factory=lambda:client);chat=service.add_chat('测试群',ChatType.GROUP)
  with patch('bowxt.transient_recovery.time.monotonic',return_value=100):service._poll_chat(client,chat);service._execute_sender_job(client,service._next_sender_job())
  original=self.store.get_messages(chat.id)[0]
  with patch('bowxt.transient_recovery.time.monotonic',return_value=103):service._poll_chat(client,chat);service._execute_sender_job(client,service._next_sender_job())
  latest=self.store.get_messages(chat.id)[0];self.assertEqual(latest.seq,original.seq);self.assertEqual(latest.observed_at,original.observed_at);self.assertEqual(latest.sender,'Synthetic member')

class NavigationRefreshTests(unittest.TestCase):
 def fixture(self,popup=False):
  old,_=sample_tree();old.nodes=[n for n in old.nodes if n.token!='search']
  fresh,_=sample_tree();fresh.nodes[2].name='Target';fresh.nodes[-1].name='Target';fresh.token='new-root'
  class RefreshAccessibility(FakeAccessibility):
   calls=0
   def connect(self):
    self.calls+=1
    if self.calls>1:self.root=fresh
    return self.root
   def windows(self):
    return [self.root]+([FakeNode('dialog','Unknown',token='dialog')] if popup and self.calls>1 else [])
  a=RefreshAccessibility(old);i=FakeInput();c=WeChatClient(accessibility=a,input_backend=i,sleeper=lambda _:None).connect()
  return c,a,i
 def test_stale_root_refresh_finds_requested_chat_before_typing(self):
  c,a,i=self.fixture();c.open_chat('Target',chat_type=ChatType.GROUP)
  self.assertEqual(c.current_chat,'Target');self.assertEqual(a.calls,2);self.assertEqual(i.events,[])
 def test_unknown_popup_after_refresh_still_locks_before_any_input(self):
  c,a,i=self.fixture(True)
  with self.assertRaises(Exception):c.open_chat('Target',chat_type=ChatType.GROUP)
  self.assertTrue(c.is_input_blocked);self.assertEqual(i.events,[])

if __name__=='__main__':unittest.main()
