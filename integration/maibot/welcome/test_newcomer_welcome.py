import copy,json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
import newcomer_welcome as w
import groupdesk_runtime as gd
from policy import Policy,Denied,settings
from test_groupdesk_runtime import bundle

INTRO='给大家介绍一下，这是刚进群的小林，做技术的。'
def welcome_profile(now):
    p=bundle(now);p.update(newcomer_welcome_contract_version=1,newcomer_welcome=dict(w.POLICY),persona_feature_skills=[{'skill_name':'newcomer-welcome'}]);return p

class ContractTests(unittest.TestCase):
    def test_opt_in_requires_known_selected_feature_and_exact_contract(self):
        self.assertFalse(w.validate(bundle()))
        p=welcome_profile(100);self.assertTrue(w.validate(p))
        for change in [lambda p:p.pop('newcomer_welcome_contract_version'),lambda p:p.update(newcomer_welcome_contract_version=2),lambda p:p.update(persona_feature_skills=[]),lambda p:p['newcomer_welcome'].update(min_delay_seconds=True),lambda p:p['newcomer_welcome'].update(max_delay_seconds=41),lambda p:p['newcomer_welcome'].update(extra=1)]:
            bad=copy.deepcopy(p);change(bad)
            with self.assertRaises(ValueError):w.validate(bad)

    def test_explicit_introductions_in_three_languages(self):
        for text in [INTRO,'请大家欢迎今天加入的新成员小张','Please welcome Alice, our new member.','Meet Alice, who just joined the group.','新しく入った田中さんです。皆さんよろしく！']:
            self.assertTrue(w.introduction(text),text)

    def test_quotes_templates_events_and_ordinary_greetings_do_not_trigger(self):
        for text in ['你好','欢迎回来，小林','欢迎参加明天的技术活动','怎么欢迎新群友？','这是欢迎新成员的模板','如果来了新群友，请欢迎','不要欢迎新成员','不是新群友，只是改了昵称','> '+INTRO,'“'+INTRO+'”','引用 GT 的消息：'+INTRO,'```'+INTRO+'```','https://example.com/new-member','How to welcome a new member','Please welcome our conference speaker.','我是刚进群的小林。']:
            self.assertFalse(w.introduction(text),text)

    def test_native_sync_ack_declares_scheduler_only_after_valid_full_bundle(self):
        from test_persona_composition import composed
        p=composed();p['persona_feature_skills'][0]['skill_name']='newcomer-welcome'
        p.update(newcomer_welcome_contract_version=1,newcomer_welcome=dict(w.POLICY));acks=[]
        def api(path,body=None):
            if path.startswith('/config/'):return p
            if path=='/ack':acks.append(body);return {'ok':True}
            raise AssertionError(path)
        with tempfile.TemporaryDirectory() as folder:
            connection=Path(folder)/'connection.json';connection.write_text(json.dumps({'groups':{'1':p['external_id']}}))
            with patch.object(gd,'CONNECTION',connection),patch.object(gd,'SNAPSHOT',Path(folder)/'state'),patch.object(gd,'api',side_effect=api):result=gd.sync()
        self.assertTrue(result['1']['enabled']);self.assertEqual(acks[0]['newcomer_welcome_policy_version'],1)

    def test_bad_scheduler_contract_never_acknowledges_the_group(self):
        from test_persona_composition import composed
        p=composed();p['persona_feature_skills'][0]['skill_name']='newcomer-welcome';acks=[]
        def api(path,body=None):
            if path.startswith('/config/'):return p
            acks.append(body);return {'ok':True}
        with tempfile.TemporaryDirectory() as folder:
            connection=Path(folder)/'connection.json';connection.write_text(json.dumps({'groups':{'1':p['external_id']}}))
            with patch.object(gd,'CONNECTION',connection),patch.object(gd,'SNAPSHOT',Path(folder)/'state'),patch.object(gd,'api',side_effect=api):result=gd.sync()
        self.assertFalse(result['1']['enabled']);self.assertFalse(acks)

class QueueTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.now=1793430000.;self.cfg=settings();self.cfg['managed_groups']={'1':welcome_profile(self.now),'2':bundle(self.now)}
        self.p=Policy(self.tmp.name,self.cfg,lambda:self.now);self.seq=0
    def message(self,text=INTRO,sender='Alice',chat='1',**kwargs):
        self.seq+=1;return self.p.ingest(self.seq,sender,text,chat_id=chat,**kwargs)
    def row(self):
        with self.p.db() as db:return dict(db.execute('SELECT * FROM pending').fetchone())
    def advance(self,seconds):
        self.now+=seconds
        for p in self.cfg['managed_groups'].values():p['valid_until']=self.now+75

    def test_wait_has_both_inclusive_bounds_and_no_model_before_due(self):
        for random,delay in [(0,15),(25,40)]:
            with self.subTest(delay=delay),tempfile.TemporaryDirectory() as folder,patch.object(w.secrets,'randbelow',return_value=random):
                p=Policy(folder,self.cfg,lambda:self.now);start=self.now
                self.assertEqual(p.ingest(1,'Alice',INTRO,chat_id='1'),'queued_welcome')
                self.assertIsNone(p.dispatch());self.assertEqual(p.snapshot()['model_calls_today'],0)
                self.advance(delay-.01);self.assertIsNone(p.dispatch());self.advance(.01)
                turn=p.dispatch();self.assertIsNotNone(turn);self.assertEqual(turn['welcome_due'],start+delay)
                self.assertEqual(turn['kind'],'passive');self.assertTrue(turn['fast']);self.assertFalse(turn['explicit'])
                self.assertEqual(p.active_turn()['welcome_due'],start+delay);self.assertLessEqual(turn['expires'],start+90)

    def test_duplicate_sequence_and_restart_preserve_exact_timer(self):
        with patch.object(w.secrets,'randbelow',return_value=9):self.message()
        due=self.row()['welcome_due'];self.advance(5)
        self.assertEqual(self.p.ingest(self.seq,'Alice',INTRO,chat_id='1'),'duplicate')
        self.p=Policy(self.tmp.name,self.cfg,lambda:self.now)
        self.assertEqual(self.row()['welcome_due'],due)

    def test_round_coalesces_multiple_introducers_without_resetting_timer(self):
        self.message();due=self.row()['welcome_due'];self.advance(5)
        self.assertEqual(self.message('请大家欢迎今天加入的新成员小张','Bob'),'coalesced_welcome')
        row=self.row();self.assertEqual(row['welcome_due'],due);self.assertIn('小张',row['text']);self.assertIn('小林',row['text'])
        self.advance(40);turn=self.p.dispatch();self.p.fail_turn(turn['id'])
        self.assertEqual(self.message(sender='Carol'),'welcome_cooldown')

    def test_same_speaker_chatter_does_not_merge_or_postpone_welcome(self):
        self.message();before=self.row();self.advance(3)
        self.assertEqual(self.message('今天阳光不错'),'welcome_background')
        self.assertEqual(self.row()['text'],before['text']);self.assertEqual(self.row()['welcome_due'],before['welcome_due'])

    def test_direct_request_from_same_person_yields_welcome_immediately(self):
        self.message();self.advance(1)
        self.assertEqual(self.message('小T hello',at_me=True),'queued');row=self.row()
        self.assertEqual(row['welcome_due'],0);self.assertEqual(row['kind'],'direct')
        self.advance(1);self.assertIsNotNone(self.p.dispatch())

    def test_normal_pending_task_is_never_replaced_by_a_welcome(self):
        self.message('小T 帮我解释一下技术方案',at_me=True);before=self.row()
        self.assertEqual(self.message(),'welcome_existing_task');self.assertEqual(self.row()['id'],before['id']);self.assertEqual(self.row()['text'],before['text'])

    def test_unselected_group_and_no_feature_are_unchanged(self):
        self.assertEqual(self.message(chat='2'),'filtered');self.assertEqual(self.p.snapshot()['pending'],0)

    def test_quiet_mention_and_strict_topic_scope_do_not_gain_permission(self):
        p=self.cfg['managed_groups']['1']
        for field,value in [('participation','quiet'),('topic_scope','all')]:
            old=p['policy'][field];p['policy'][field]=value
            self.assertNotEqual(self.message(),'queued_welcome');p['policy'][field]=old
        p['interaction']='mention';self.assertNotEqual(self.message(),'queued_welcome');self.assertEqual(self.p.snapshot()['pending'],0)

    def test_disabled_and_stale_lease_cannot_admit(self):
        p=self.cfg['managed_groups']['1'];p['enabled']=False;self.assertNotEqual(self.message(),'queued_welcome')
        p['enabled']=True;p['valid_until']=self.now-1;self.assertNotEqual(self.message(),'queued_welcome')
        self.assertEqual(self.p.snapshot()['pending'],0)

    def test_source_age_and_total_freshness_are_bounded(self):
        self.assertEqual(self.message(timestamp=self.now-91),'expired')
        self.message();self.advance(91);self.assertIsNone(self.p.dispatch());self.assertEqual(self.p.snapshot()['pending'],0)

    def test_configuration_change_cancels_and_send_gate_rechecks_revision(self):
        self.message();self.advance(40);self.cfg['managed_groups']['1']['revision']+=1
        self.assertIsNone(self.p.dispatch());self.advance(121);self.message(sender='Bob');self.advance(40)
        turn=self.p.dispatch();self.cfg['managed_groups']['1']['revision']+=1
        with self.assertRaisesRegex(Denied,'groupdesk_revision'):self.p.reserve_send('no-real-send',turn['id'],chat_id='1')

    def test_expired_welcome_cannot_send_and_wrong_group_is_refused(self):
        self.message();self.advance(40);turn=self.p.dispatch()
        with self.assertRaisesRegex(Denied,'wrong_target_group'):self.p.reserve_send('no-real-send',turn['id'],chat_id='2')
        self.advance(51)
        with self.assertRaisesRegex(Denied,'no_active_turn'):self.p.reserve_send('late',turn['id'],chat_id='1')

    def test_budget_and_queue_bounds_are_still_enforced(self):
        self.cfg['daily_tokens']=0;self.assertEqual(self.message(),'budget');self.assertEqual(self.p.snapshot()['pending'],0)
        self.cfg['daily_tokens']=100000;self.cfg['queue_limit']=0;self.assertEqual(self.message(),'queue_full')

    def test_ordinary_direct_request_in_another_group_is_not_delayed(self):
        self.message();self.assertEqual(self.message('小T hello','Bob','2',at_me=True),'queued');self.advance(1)
        turn=self.p.dispatch();self.assertEqual(turn['chat_id'],'2');self.assertEqual(turn['welcome_due'],0)

try:
    from test_published_persona import NATIVE,NativeBindingTests
except ImportError:NATIVE=False
@unittest.skipUnless(NATIVE,'Pinned native request classes required')
class NativeWelcomeTests(unittest.TestCase):
    def test_trusted_marker_is_present_only_for_current_welcome_turn(self):
        request=NativeBindingTests.request(self);p=type('P',(),{'cfg':{'managed_groups':{'1':welcome_profile(100)}},'clock':lambda self:100})()
        turn={'chat_id':'1','welcome_due':100}
        w.bind(p,request,turn,'planner');text=NativeBindingTests.content(self,request)
        self.assertIn('[GT_NEWCOMER_WELCOME]',text);self.assertIn('15—40秒',text)
        w.bind(p,request,{'chat_id':'1','welcome_due':0},'planner');self.assertNotIn('[GT_NEWCOMER_WELCOME]',NativeBindingTests.content(self,request))

if __name__=='__main__':unittest.main()
