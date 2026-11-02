"""Synthetic UI images, identities and isolated SQLite only; no real sends."""
import tempfile,unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import Mock,patch
from PIL import Image,ImageDraw
from bowxt.models import Direction,Rect,ChatType
from bowxt.vision import VisualSnapshot
from bowxt.identity_recovery import avatar_direction,observe,attempt,ready,stats
from bowxt.store import SQLiteStore
from bowxt.service import BowxtService
from test_store import incoming
from test_service import FakeServiceClient

class AvatarEvidenceTests(unittest.TestCase):
 def image(self,side=None):
  image=Image.new('RGB',(360,180),(245,245,245));d=ImageDraw.Draw(image)
  # Sparse grey content in a very wide bubble need not satisfy whole-row 2.2x.
  d.rectangle((70,4,290,170),fill=(255,255,255))
  for y in range(18,165,14):d.rectangle((78,y,280,y+2),fill=(80,80,80))
  if side in {'left','both'}:d.rectangle((19,10,51,42),fill=(60,90,130))
  if side in {'right','both'}:d.rectangle((309,10,341,42),fill=(60,90,130))
  return VisualSnapshot(image,Rect(0,0,360,180))
 def test_left_avatar_confirms_incoming_without_using_body_distribution(self):self.assertEqual(avatar_direction(self.image('left'),Rect(0,0,360,180),Rect(0,0,360,180)),Direction.INCOMING)
 def test_right_avatar_is_outgoing(self):self.assertEqual(avatar_direction(self.image('right'),Rect(0,0,360,180),Rect(0,0,360,180)),Direction.OUTGOING)
 def test_both_or_no_avatars_stay_unknown(self):
  for side in ['both',None]:self.assertEqual(avatar_direction(self.image(side),Rect(0,0,360,180),Rect(0,0,360,180)),Direction.UNKNOWN)
 def test_avatar_above_viewport_or_window_is_never_guessed(self):
  for clip in [Rect(0,30,360,150),Rect(0,0,300,180)]:self.assertEqual(avatar_direction(self.image('left'),Rect(0,0,360,180),clip),Direction.UNKNOWN)
  self.assertEqual(avatar_direction(self.image('left'),Rect(0,-30,360,180),Rect(0,0,360,180)),Direction.UNKNOWN)
 def test_bubble_only_bounds_and_small_rows_are_rejected(self):
  for row in [Rect(70,0,220,180),Rect(0,0,360,30)]:self.assertEqual(avatar_direction(self.image('left'),row,Rect(0,0,360,180)),Direction.UNKNOWN)

class IdentityReadTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.store=SQLiteStore(Path(self.tmp.name)/'messages.db');self.client=FakeServiceClient();self.client.uia_sender=True;self.service=BowxtService(self.store,client_factory=lambda:self.client);self.chat=self.service.add_chat('测试群',ChatType.GROUP)
 def msg(self,id='arrival:missing',direction=Direction.UNKNOWN):return replace(incoming(id),sender=None,direction=direction)
 def test_unknown_direction_gets_bounded_read_job_but_no_unverified_avatar_click(self):
  m=self.msg();self.client.get_visible_messages=lambda *a,**kw:[m];self.client.enrich_visible_senders=Mock(side_effect=AssertionError('No unverified profile click'))
  for n,at in enumerate([100,103,112]):
   with patch('bowxt.transient_recovery.time.monotonic',return_value=at):
    self.service._poll_chat(self.client,self.chat);job=self.service._next_sender_job();self.assertIsNotNone(job);self.service._execute_sender_job(self.client,job)
  self.assertEqual(stats(self.store)['unresolved'],1)
  with patch('bowxt.transient_recovery.time.monotonic',return_value=200):self.service._poll_chat(self.client,self.chat);self.assertIsNone(self.service._next_sender_job())
  self.assertEqual(self.store.get_messages(self.chat.id)[0].direction,'unknown');self.client.enrich_visible_senders.assert_not_called()
 def test_exhausted_backlog_does_not_starve_later_member(self):
  first=self.msg('arrival:first',Direction.INCOMING);second=self.msg('arrival:second',Direction.INCOMING)
  for m in [first,second]:r,_=self.store.save_message(m);observe(self.store,r)
  for _ in range(3):attempt(self.store,self.chat.id,first.id,'profile_name_unavailable')
  self.client.get_visible_messages=lambda *a,**kw:[first,second]
  self.service._poll_chat(self.client,self.chat);self.assertEqual(self.service._next_sender_job().message_id,second.id)
 def test_retry_budget_persists_across_service_restart(self):
  r,_=self.store.save_message(self.msg());observe(self.store,r)
  for _ in range(3):attempt(self.store,self.chat.id,r.message_id,'direction_not_confirmed')
  restarted=BowxtService(self.store);self.assertFalse(ready(self.store,self.chat.id,r.message_id));restarted._queue_sender_job(self.chat.id,r.message_id);self.assertIsNone(restarted._next_sender_job())
 def test_new_verified_direction_allows_one_new_sender_phase(self):
  m=self.msg();r,_=self.store.save_message(m);observe(self.store,r)
  for _ in range(3):attempt(self.store,self.chat.id,m.id,'direction_not_confirmed')
  r,_=self.store.save_message(replace(m,direction=Direction.INCOMING));self.assertTrue(observe(self.store,r));self.assertTrue(ready(self.store,self.chat.id,m.id));self.assertFalse(observe(self.store,r))
  for _ in range(3):attempt(self.store,self.chat.id,m.id,'profile_name_unavailable')
  self.assertFalse(observe(self.store,r));self.assertFalse(ready(self.store,self.chat.id,m.id))
 def test_sender_enrichment_preserves_arrival_seq_first_capture_and_original_time(self):
  m=self.msg(direction=Direction.INCOMING);self.client.get_visible_messages=lambda *a,**kw:[m]
  self.client.enrich_visible_senders=lambda values,**kw:[replace(values[0],id='uia-generated-id',sender='Synthetic member',raw={'sender_source':'profile_uia'})]
  self.service._poll_chat(self.client,self.chat);before=self.store.get_messages(self.chat.id)[0];self.service._execute_sender_job(self.client,self.service._next_sender_job());rows=self.store.get_messages(self.chat.id)
  self.assertEqual(len(rows),1);self.assertEqual(rows[0].message_id,m.id);self.assertEqual(rows[0].observed_at,before.observed_at);self.assertEqual(rows[0].timestamp,before.timestamp);self.assertEqual(rows[0].sender,'Synthetic member');self.assertEqual(stats(self.store)['resolved'],1)
 def test_read_job_can_recheck_unknown_then_enrich_after_independent_direction_evidence(self):
  m=self.msg();self.client.get_visible_messages=lambda *a,**kw:[m];self.service._poll_chat(self.client,self.chat);original=self.store.get_messages(self.chat.id)[0]
  self.client.get_visible_messages=lambda *a,**kw:[replace(m,direction=Direction.INCOMING)]
  self.client.enrich_visible_senders=lambda values,**kw:[replace(values[0],sender='Verified member',raw={'sender_source':'profile_uia'})]
  self.service._execute_sender_job(self.client,self.service._next_sender_job());r=self.store.get_messages(self.chat.id)[0]
  self.assertEqual(r.seq,original.seq);self.assertEqual(r.observed_at,original.observed_at);self.assertEqual(r.direction,'incoming');self.assertEqual(r.sender,'Verified member')
 def test_completed_identity_is_not_reopened_or_reported_pending(self):
  m=self.msg(direction=Direction.INCOMING);r,_=self.store.save_message(m);observe(self.store,r);r,_=self.store.save_message(replace(m,sender='Verified member'));observe(self.store,r)
  self.assertFalse(ready(self.store,self.chat.id,m.id));self.assertEqual(stats(self.store),{'resolved':1})

if __name__=='__main__':unittest.main()
