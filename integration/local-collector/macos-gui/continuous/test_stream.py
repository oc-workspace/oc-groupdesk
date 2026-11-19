import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import uuid
import sys
sys.path.insert(0,str(Path(__file__).parent))
import stream as source
sys.modules['mac_gui_stream']=source
from sender import MacSender
from install_bridge import install


def config():
    selector={'path':[], 'role':'AXStaticText','attribute':'AXValue'}
    return {'contract':1,'bot_id':str(uuid.uuid4()),'account_id':str(uuid.uuid4()),'wechat_build':'12345',
            'group':{'id':31,'name':'Synthetic group'},
            'roster':{'Alice':{'id':str(uuid.uuid4()),'name':'Alice','self':False},
                      'Bob':{'id':str(uuid.uuid4()),'name':'Bob','self':False},
                      'My Bot':{'id':str(uuid.uuid4()),'name':'My Bot','self':True}},
            'profile':{'title':'Synthetic group','header':selector,'account':selector,'account_value':'My Bot',
                       'container':{'path':[],'role':'AXList'},'row':{'role':'AXRow'},
                       'sender':selector,'body':selector,'scroll':{'path':[],'role':'AXScrollBar'},'composer_top':0.7,'scroll_step':0.001}}


def message(text, who='Alice', **extra):
    return {'sender':who,'content':text,**extra}


def snapshot(*rows, bottom=True, top=False):
    return {'contract':1,'title':'Synthetic group','rows':list(rows),'at_bottom':bottom,'at_top':top,'position':1 if bottom else 0.3}


class MemoryCapture:
    def __init__(self,*pages):
        self.pages=list(pages);self.index=0;self.actions=[]
    def snapshot(self):return self.pages[self.index]
    def scroll(self,direction):
        self.actions.append(direction)
        self.index=0 if direction=='bottom' else min(len(self.pages)-1,self.index+1)


class StreamTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name);self.cfg=config()
        self.clock=[2000.0]
        self.archive=source.Archive(self.root,self.cfg,lambda:self.clock[0])
    def tearDown(self):self.temp.cleanup()
    def baseline(self,*rows):
        normalized=source.normalize(self.cfg,snapshot(*rows))
        self.archive.commit(None,normalized,normalized,baseline=True)
        return normalized
    def test_two_senders_same_body_are_distinct(self):
        rows=source.normalize(self.cfg,snapshot(message('摸鱼'),message('摸鱼','Bob')))
        self.assertNotEqual(rows[0]['signature'],rows[1]['signature'])
        self.assertNotEqual(rows[0]['sender_id'],rows[1]['sender_id'])
    def test_unlisted_sender_gets_local_identity_and_no_wxid_claim(self):
        row=source.normalize(self.cfg,snapshot(message('Hello','New member')))[0]
        self.assertEqual(row['sender'],'New member');self.assertTrue(row['sender_id'].startswith('mac-ui-'))
    def test_initial_view_is_archived_but_not_replied_to(self):
        collector=source.Collector(self.archive,MemoryCapture(snapshot(message('old'),message('context','Bob'))))
        collector.cycle();self.assertEqual(len(self.archive.page()),2)
        self.assertFalse(any(row['eligible'] for row in self.archive.page()))
    def test_restart_same_snapshot_never_duplicates(self):
        page=snapshot(message('1'),message('2','Bob'))
        source.Collector(self.archive,MemoryCapture(page)).cycle()
        source.Collector(self.archive,MemoryCapture(page)).cycle()
        self.assertEqual(len(self.archive.page()),2)
    def test_same_body_after_context_is_a_new_occurrence(self):
        capture=MemoryCapture(snapshot(message('same'),message('anchor','Bob')))
        collector=source.Collector(self.archive,capture);collector.cycle()
        capture.pages=[snapshot(message('anchor','Bob'),message('same'))]
        self.assertEqual(collector.cycle(),1)
        self.assertEqual([r['content'] for r in self.archive.page()],['same','anchor','same'])
    def test_repeated_identical_context_fails_without_advancing(self):
        left=self.baseline(message('same'),message('same'))
        with self.assertRaisesRegex(source.Blocked,'ambiguous_overlap'):
            source.overlap(left,source.normalize(self.cfg,snapshot(message('same'),message('same'),message('new'))))
        self.assertEqual(self.archive.checkpoint()[0],left)
    def test_backfill_scans_to_anchor_then_commits_in_order_once(self):
        self.baseline(message('a'),message('b','Bob'))
        pages=[snapshot(message('e'),message('f','Bob')),
               snapshot(message('c'),message('d','Bob'),message('e'),bottom=False),
               snapshot(message('b','Bob'),message('c'),bottom=False)]
        capture=MemoryCapture(*pages)
        self.assertEqual(source.Collector(self.archive,capture).cycle(),4)
        rows=self.archive.page();self.assertEqual([x['content'] for x in rows],list('abcdef'))
        self.assertTrue(all(r['backfilled'] for r in rows[2:]));self.assertFalse(any(r['eligible'] for r in rows))
        self.assertEqual(capture.actions,['up','up','bottom'])
    def test_recovery_finds_saved_tail_inside_an_older_page(self):
        self.baseline(message('a'),message('b','Bob'))
        capture=MemoryCapture(snapshot(message('e'),message('f','Bob')),
                              snapshot(message('x'),message('a'),message('b','Bob'),message('c'),message('d','Bob'),message('e'),bottom=False))
        self.assertEqual(source.Collector(self.archive,capture).cycle(),4)
        self.assertEqual([r['content'] for r in self.archive.page()],list('abcdef'))
    def test_missing_anchor_is_reported_and_original_cursor_remains(self):
        left=self.baseline(message('a'),message('b','Bob'))
        capture=MemoryCapture(snapshot(message('x'),message('y','Bob'),top=True))
        with self.assertRaisesRegex(source.Blocked,'history_gap'):source.Collector(self.archive,capture).cycle()
        self.assertEqual(self.archive.checkpoint()[0],left);self.assertEqual(len(self.archive.page()),2)
    def test_failed_middle_page_does_not_partially_commit(self):
        left=self.baseline(message('a'),message('b','Bob'))
        capture=MemoryCapture(snapshot(message('e'),message('f','Bob')),snapshot(message('x'),message('e'),bottom=False))
        with self.assertRaises(source.Blocked):source.Collector(self.archive,capture,max_pages=2).cycle()
        self.assertEqual(self.archive.checkpoint()[0],left);self.assertEqual(len(self.archive.page()),2)
    def test_wrong_chat_empty_sender_and_unknown_media_do_not_advance(self):
        for data in [dict(snapshot(message('x')),title='Other group'),snapshot(message('x','')),snapshot(message(''))]:
            with self.assertRaises(source.Blocked):source.normalize(self.cfg,data)
    def test_same_ui_identity_with_changed_body_blocks_transaction(self):
        self.cfg['profile']['message_id']={'path':[],'role':'AXRow','attribute':'AXIdentifier'}
        first=source.normalize(self.cfg,snapshot(message('old',ui_id='1'),message('context','Bob',ui_id='2')))
        self.archive.commit(None,first,first,baseline=True)
        altered=source.normalize(self.cfg,snapshot(message('edited',ui_id='1')))
        with self.assertRaisesRegex(source.Blocked,'message_identity_changed'):
            self.archive.commit(first,altered,altered)
        self.assertEqual(len(self.archive.page()),2)
    def test_archives_refuse_other_bot_group_account_or_layout(self):
        for field in ['bot_id','account_id']:
            changed=json.loads(json.dumps(self.cfg));changed[field]=str(uuid.uuid4())
            with self.assertRaisesRegex(source.Blocked,'configuration_changed'):source.Archive(self.root,changed)
    def test_concurrent_cursor_cannot_skip_another_collector(self):
        first=self.baseline(message('a'),message('b','Bob'))
        second=source.normalize(self.cfg,snapshot(message('b','Bob'),message('c')))
        self.archive.commit(first,second,second[1:])
        with self.assertRaisesRegex(source.Blocked,'concurrent_collector'):self.archive.commit(first,first,[])
    def test_maibot_claim_ack_durable_and_sender_preserved(self):
        first=self.baseline(message('a'),message('b','Bob'))
        second=source.normalize(self.cfg,snapshot(message('b','Bob'),message('new','Bob')))
        self.archive.commit(first,second,second[1:]);self.archive.status('collecting')
        agent=source.GUIAgent(object(),self.archive)
        batch=agent.claim(chat_ids=[31]);self.assertEqual(len(batch),1)
        self.assertEqual(batch[0].message.sender,'Bob');self.assertEqual(batch[0].message.content,'new')
        self.assertEqual(batch[0].message.source_kind,'wechat_gui')
        self.assertEqual(agent.claim(chat_ids=[31]),[])
        agent.ack(batch[0])
        self.assertEqual(source.GUIAgent(object(),self.archive).claim(chat_ids=[31]),[])
    def test_abandoned_lease_retries_same_id_but_late_ack_fails(self):
        first=self.baseline(message('a'))
        current=source.normalize(self.cfg,snapshot(message('a'),message('b','Bob')))
        self.archive.commit(first,current,current[1:]);self.archive.status('collecting')
        agent=source.GUIAgent(object(),self.archive)
        firstlease=agent.claim(chat_ids=[31],lease_seconds=1)[0]
        self.clock[0]+=2;self.archive.status('collecting')
        newlease=agent.claim(chat_ids=[31],lease_seconds=1)[0]
        self.assertEqual(newlease.message.seq,firstlease.message.seq)
        with self.assertRaisesRegex(source.Blocked,'stale_lease'):agent.ack(firstlease)
        agent.ack(newlease)
    def test_backfilled_rows_do_not_turn_old_history_into_live_replies(self):
        first=self.baseline(message('a'))
        current=source.normalize(self.cfg,snapshot(message('a'),message('old reply','Bob')))
        self.archive.commit(first,current,current[1:],backfilled=True);self.archive.status('collecting')
        agent=source.GUIAgent(object(),self.archive)
        self.assertEqual(agent.claim(chat_ids=[31]),[])
        self.assertEqual(len(agent.get_history(31,duration_seconds=100,until=__import__('datetime').datetime.fromtimestamp(2001,__import__('datetime').timezone.utc))),2)
    def test_unhealthy_source_or_wrong_group_never_forwards(self):
        self.archive.status('blocked','permission_required')
        agent=source.GUIAgent(object(),self.archive)
        self.assertEqual(agent.claim(chat_ids=[31]),[]);self.assertFalse(agent.source_status['connected'])
        self.assertEqual(agent.claim(chat_ids=[42]),[])
    def test_existing_bot_lifecycle_can_check_paused_source_and_reset_ingress(self):
        first=self.baseline(message('a'))
        current=source.normalize(self.cfg,snapshot(message('a'),message('new','Bob')))
        self.archive.commit(first,current,current[1:]);self.archive.status('collecting')
        delegate=type('Delegate',(),{'status':lambda _: {'wechat_connected':True,'queue_depth':0}})()
        agent=source.GUIAgent(delegate,self.archive)
        self.assertEqual(agent.request('/v1/status',{}),{'ok':True,'source':'macos_gui'})
        self.assertTrue(agent.status()['wechat_connected'])
        agent.reset_live_cursors([31])
        self.assertEqual(agent.claim(chat_ids=[31]),[])
        self.assertEqual(len(self.archive.page()),2)
        self.archive.status('blocked','login_required')
        self.assertFalse(agent.request('/v1/status',{})['ok'])
        self.assertFalse(agent.status()['wechat_connected'])
    def test_second_collector_cannot_take_the_same_window_lock(self):
        with source.capture_lock(self.root):
            with self.assertRaisesRegex(source.Blocked,'collector_already_running'):
                with source.capture_lock(self.root):pass
        with source.capture_lock(self.root):pass
    def test_archive_private_permissions_and_summary_has_no_messages(self):
        self.baseline(message('private body','Bob'))
        data=self.archive.status('blocked','permission_required')
        self.assertNotIn('private body',json.dumps(data));self.assertNotIn('Bob',json.dumps(data))
        self.assertEqual(self.archive.path.stat().st_mode&0o777,0o600)
    def test_capture_converts_raw_errors_to_fixed_code(self):
        binary=self.root/'capture';binary.write_text('test');binary.chmod(0o700)
        capture=source.Capture(binary,self.cfg)
        with patch.object(source.subprocess,'run') as run:
            run.return_value=type('Result',(),{'stdout':'{"error":"private chat"}','returncode':2})()
            with self.assertRaisesRegex(source.Blocked,'^capture_unavailable$'):capture.snapshot()
    def test_sender_crash_is_not_retried_for_same_client_id(self):
        binary=self.root/'send';binary.write_text('fixture');binary.chmod(0o700)
        capture=self.root/'capture';capture.write_text('fixture');capture.chmod(0o700)
        sender=MacSender(self.archive,binary,capture)
        with patch.object(sender.capture,'snapshot',return_value=snapshot(message('a'))),patch('sender.subprocess.run',side_effect=OSError) as run:
            a=sender.send_text(31,'Test',client_id='job-1');b=sender.send_text(31,'Test',client_id='job-1')
            self.assertEqual(a.delivery_status,'uncertain');self.assertEqual(a.seq,b.seq);self.assertEqual(run.call_count,1)
            with self.assertRaisesRegex(source.Blocked,'send_id_conflict'):sender.send_text(31,'Different',client_id='job-1')
    def test_supported_bridge_installs_source_without_starting_or_mutating_policy(self):
        runtime=self.root/'runtime';(runtime/'bridge').mkdir(parents=True);(runtime/'limits').mkdir()
        target=runtime/'bridge/app.py'
        code = """from chatlog_runtime import attach_reader
class Bridge:
    def __init__(self):
        self.agent = attach_reader(AgentClient('maibot-gt', base_url=os.environ.get('BOWXT_BASE_URL', 'http://wechat:8787')),self.state_dir)
    def heartbeat(self):
        self.health['data_source']='chatlog-keeper' if getattr(self.agent,'source_kind',None)=='wechat_database' else 'bowxt-ui'
        if self.health['data_source']=='chatlog-keeper':self.health['reader']=dict(self.agent.source_status)
"""
        target.write_text(code)
        expected=__import__('hashlib').sha256(target.read_bytes()).hexdigest()
        preview=install(Path(__file__).parent,runtime,expected,check=True)
        self.assertFalse(preview['started']);self.assertEqual(target.read_text(),code)
        result=install(Path(__file__).parent,runtime,expected,confirmed=True)
        self.assertTrue(result['installed']);self.assertFalse(result['started'])
        self.assertIn('macos-gui',target.read_text())
        self.assertTrue((runtime/'limits/mac_gui_stream.py').is_file())
        self.assertEqual(next((runtime/'backups').glob('*/app.py')).read_text(),code)
        with self.assertRaises(ValueError):install(Path(__file__).parent,runtime,expected,confirmed=True)
    def test_installer_requires_bridge_review_and_preserves_file_on_failed_preflight(self):
        runtime=self.root/'runtime';(runtime/'bridge').mkdir(parents=True);(runtime/'limits').mkdir()
        target=runtime/'bridge/app.py';target.write_text('print("Unreviewed")')
        with self.assertRaises(ValueError):install(Path(__file__).parent,runtime,'bad',check=True)
        with self.assertRaises(ValueError):install(Path(__file__).parent,runtime,__import__('hashlib').sha256(target.read_bytes()).hexdigest(),check=True)
        self.assertEqual(target.read_text(),'print("Unreviewed")')


if __name__=='__main__':unittest.main()
