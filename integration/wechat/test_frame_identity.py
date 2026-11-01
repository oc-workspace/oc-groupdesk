import hashlib,json,tempfile,unittest
from dataclasses import replace
from datetime import datetime,timezone,timedelta
from pathlib import Path
from bowxt.models import Message,MessageType,Direction,ChatType
from bowxt.store import SQLiteStore
from bowxt.frame_identity import track_frame,PREFIX

TIME=datetime(2026,11,1,8,39,tzinfo=timezone.utc)
def bubble(text,sender=None,time=None,occurrence=0,chat='Synthetic room'):
    # Deliberately reproduces Qt's reused content/time/occurrence hash.
    identifier=hashlib.sha256(json.dumps([text,time.isoformat() if time else None,occurrence,chat]).encode()).hexdigest()[:24]
    return Message(id=identifier,chat=chat,content=text,type=MessageType.TEXT,direction=Direction.INCOMING,sender=sender,timestamp=time,chat_type=ChatType.GROUP,raw={'visible_occurrence':occurrence})

class FrameIdentityTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.path=Path(self.tmp.name)/'messages.db';self.store=SQLiteStore(self.path)
    def frame(self,items,chat='Synthetic room'):
        return track_frame(self.store,items,chat=chat)
    def save(self,items):return [self.store.save_message(m)[0] for m in items]
    def test_original_untimed_reconciliation_loses_a_second_members_equal_text(self):
        original,_=self.store.save_message(bubble('摸鱼','Synthetic Alpha',TIME))
        merged,created=self.store.save_message(bubble('摸鱼'))
        self.assertFalse(created);self.assertEqual(merged.seq,original.seq)
        # The anchored path below must bypass this ambiguous legacy merge.
        self.save(self.frame([bubble('摸鱼','Synthetic Alpha',TIME),bubble('a unique anchor')]))
        current=self.frame([bubble('a unique anchor'),bubble('摸鱼')])
        second,created=self.store.save_message(current[-1]);self.assertTrue(created);self.assertNotEqual(second.seq,original.seq)
        enriched,_=self.store.save_message(replace(current[-1],sender='Synthetic Beta',raw={**current[-1].raw,'sender_source':'profile_uia'}))
        self.assertEqual(enriched.seq,second.seq);self.assertEqual(enriched.sender,'Synthetic Beta')
        self.assertEqual(self.store.get_message(original.seq).sender,'Synthetic Alpha')
    def test_same_text_from_two_members_gets_two_captures_and_two_deliveries(self):
        anchor=bubble('start');self.save(self.frame([anchor]))
        first=self.frame([anchor,bubble('摸鱼','Synthetic Alpha')]);first_row=self.save(first)[-1]
        middle=self.frame([*first,bubble('another anchor')]);self.save(middle)
        second=self.frame([bubble('another anchor'),bubble('摸鱼','Synthetic Beta')]);second_row=self.save(second)[-1]
        self.assertNotEqual(first[-1].id,second[-1].id);self.assertNotEqual(first_row.seq,second_row.seq)
        self.assertTrue(second[-1].id.startswith(PREFIX))
        deliveries=self.store.claim_agent_messages('synthetic',chat_ids=[first_row.chat_id],require_sender=True,replay_existing=True)
        self.assertEqual({d.message.seq for d in deliveries},{first_row.seq,second_row.seq})
    def test_repeated_poll_and_sender_enrichment_keep_id_and_first_capture(self):
        self.save(self.frame([bubble('anchor')]))
        current=self.frame([bubble('anchor'),bubble('摸鱼')]);stored=self.save(current)[-1]
        again=self.frame([bubble('anchor'),bubble('摸鱼','Synthetic member')]);updated,created=self.store.save_message(again[-1])
        self.assertFalse(created);self.assertEqual(updated.seq,stored.seq);self.assertEqual(updated.observed_at,stored.observed_at)
    def test_no_sender_can_be_inherited_from_another_members_cache_key(self):
        self.frame([bubble('anchor')]);first=self.frame([bubble('anchor'),bubble('摸鱼')])
        cache={first[-1].id:'Synthetic Alpha'}
        self.frame([bubble('摸鱼'),bubble('new anchor')])
        second=self.frame([bubble('new anchor'),bubble('摸鱼')])
        self.assertNotIn(second[-1].id,cache)
    def test_two_equal_bubbles_in_one_new_burst_remain_distinct(self):
        self.frame([bubble('anchor')]);items=self.frame([bubble('anchor'),bubble('摸鱼'),bubble('摸鱼',occurrence=1)])
        self.assertEqual(len({m.id for m in items}),3)
    def test_longest_suffix_wins_over_wrong_lcs_for_reordered_equal_text(self):
        old=self.frame([bubble('摸鱼'),bubble('anchor')]);new=self.frame([bubble('anchor'),bubble('摸鱼')])
        self.assertEqual(new[0].id,old[-1].id);self.assertNotEqual(new[-1].id,old[0].id)
    def test_time_separator_disappearing_does_not_create_duplicate(self):
        old=self.frame([bubble('a',time=TIME),bubble('b',time=TIME)])
        new=self.frame([bubble('a'),bubble('b')]);self.assertEqual([m.id for m in old],[m.id for m in new])
    def test_explicit_different_time_is_not_matched_as_the_same_message(self):
        old=self.frame([bubble('same',time=TIME)]);new=self.frame([bubble('same',time=TIME+timedelta(days=1))])
        self.assertNotEqual(old[0].id,new[0].id)
    def test_frame_state_survives_service_restart(self):
        self.frame([bubble('anchor')]);old=self.frame([bubble('anchor'),bubble('摸鱼')])
        self.store=SQLiteStore(self.path);new=self.frame([bubble('anchor'),bubble('摸鱼')])
        self.assertEqual([m.id for m in old],[m.id for m in new])
    def test_scrolling_back_then_returning_reuses_known_forward_edges(self):
        self.frame([bubble('a'),bubble('b')]);original=self.frame([bubble('a'),bubble('b'),bubble('c')])
        self.frame([bubble('a'),bubble('b')]);again=self.frame([bubble('a'),bubble('b'),bubble('c')])
        self.assertEqual(original[-1].id,again[-1].id)
    def test_newly_exposed_history_does_not_enter_agent_queue(self):
        self.save(self.frame([bubble('b'),bubble('c')]))
        rows=self.save(self.frame([bubble('older','Synthetic member'),bubble('b'),bubble('c')]))
        self.assertEqual(rows[0].delivery_status,'historical')
        self.assertEqual(self.store.claim_agent_messages('history',replay_existing=True),[])
    def test_initial_view_only_seeds_history_and_does_not_grant_old_checkins(self):
        rows=self.save(self.frame([bubble('摸鱼','Synthetic member')]))
        self.assertEqual(rows[0].delivery_status,'historical')
        self.assertEqual(self.store.claim_agent_messages('bootstrap',replay_existing=True),[])
    def test_preexisting_live_rows_are_not_relabelled_historical_on_upgrade(self):
        existing,_=self.store.save_message(bubble('live','Synthetic member'))
        updated=self.save(self.frame([bubble('live','Synthetic member')]))[0]
        self.assertEqual(updated.seq,existing.seq);self.assertEqual(updated.delivery_status,'observed')
    def test_groups_are_independent(self):
        self.frame([bubble('anchor')]);one=self.frame([bubble('anchor'),bubble('摸鱼')])
        other=self.frame([bubble('摸鱼',chat='Other synthetic room')],chat='Other synthetic room')
        self.assertNotEqual(one[-1].id,other[-1].id)
    def test_steady_frames_do_not_grow_the_edge_history(self):
        self.frame([bubble('a')]);self.frame([bubble('a'),bubble('b'),bubble('c')])
        with self.store._database() as db:before=db.execute('SELECT payload FROM visible_identity_frames').fetchone()[0]
        for _ in range(5):self.frame([bubble('a'),bubble('b'),bubble('c')])
        with self.store._database() as db:after=db.execute('SELECT payload FROM visible_identity_frames').fetchone()[0]
        self.assertEqual(before,after)
    def test_legacy_quote_filter_does_not_discard_a_proven_new_tail(self):
        self.store.save_message(bubble('reply\n引用 Synthetic Alpha 的消息：摸鱼','Synthetic Beta'))
        self.frame([bubble('anchor')]);message=self.frame([bubble('anchor'),bubble('摸鱼')])[-1]
        self.assertFalse(self.store.is_historical_quote_source(message))
        self.assertTrue(self.store.is_historical_quote_source(bubble('摸鱼')))
    def test_real_client_assigns_arrival_id_before_consulting_sender_cache(self):
        from bowxt import WeChatClient
        from fakes import FakeAccessibility,sample_tree
        from unittest.mock import patch
        root,_=sample_tree();client=WeChatClient(accessibility=FakeAccessibility(root)).connect()
        self.addCleanup(client.disconnect);client._chat='Synthetic room';client.uia_sender=True;client.visual_direction=True
        client.visible_identity_tracker=lambda messages,**kwargs:track_frame(self.store,messages,**kwargs)
        class Snapshot:
            def classify(self,_bounds):return Direction.INCOMING
        frames=[[bubble('anchor')],[bubble('anchor'),bubble('摸鱼')],[bubble('摸鱼'),bubble('next')],[bubble('next'),bubble('摸鱼')]]
        with patch.object(client.parser,'parse_list',side_effect=frames),patch('bowxt.vision.VisualDirectionDetector.capture',return_value=Snapshot()):
            client.get_visible_messages(chat_type=ChatType.GROUP,enrich_senders=False)
            first=client.get_visible_messages(chat_type=ChatType.GROUP,enrich_senders=False)[-1]
            client._visual_cache[first.id]=(Direction.INCOMING,'Synthetic Alpha','Synthetic org',1.,'profile_uia')
            client.get_visible_messages(chat_type=ChatType.GROUP,enrich_senders=False)
            second=client.get_visible_messages(chat_type=ChatType.GROUP,enrich_senders=False)[-1]
        self.assertNotEqual(first.id,second.id);self.assertIsNone(second.sender)
    def test_confirmed_local_send_is_not_duplicated_by_its_tracked_ui_echo(self):
        original=replace(bubble('reply'),id='local:synthetic',direction=Direction.OUTGOING)
        sent,_=self.store.save_message(original)
        with self.store._database() as db:db.execute('UPDATE messages SET message_id=?,client_id=? WHERE seq=?',('legacy-receipt','synthetic-client',sent.seq))
        self.frame([bubble('anchor')]);echo=replace(bubble('reply'),direction=Direction.OUTGOING)
        tracked=self.frame([bubble('anchor'),echo])[-1];same,created=self.store.save_message(tracked)
        self.assertFalse(created);self.assertEqual(same.seq,sent.seq)
        # A later separate outgoing bubble must not merge into that receipt.
        self.frame([tracked,bubble('another anchor')]);later=self.frame([bubble('another anchor'),echo])[-1]
        separate,created=self.store.save_message(later);self.assertTrue(created);self.assertNotEqual(separate.seq,sent.seq)

if __name__=='__main__':unittest.main()
