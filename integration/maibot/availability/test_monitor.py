import copy,unittest
from monitor import run,classify,next_action

def snapshot(**values):return {'paused':False,'running':{'wechat':True,'bridge':True,'maibot':True},'wechat':True,'bridge':True,'maibot':True,**values}
class Fake:
 def __init__(self,*states):self.states=list(states);self.actions=[];self.notices=[];self.reconciliations=[];self.reports=[]
 def observe(self):return copy.deepcopy(self.states.pop(0) if len(self.states)>1 else self.states[0])
 def act(self,value):self.actions.append(value);return 'ok'
 def wait(self,value):pass
 def notify(self,*values):self.notices.append(values)
 def reconcile(self,incident,at):self.reconciliations.append((incident,at));return {"queued":0,"coverage":"recorded_only"}
 def transport_recoveries(self):return []
 def report(self,value):self.reports.append(value)
class MonitorTests(unittest.TestCase):
 def test_healthy_idle_group_needs_no_messages_or_model_calls(self):
  f=Fake(snapshot());r=run(f,{},10000);self.assertEqual(r['state'],'online');self.assertEqual(f.actions+f.notices+f.reconciliations,[])
 def test_manual_pause_is_respected_even_if_other_states_fail(self):
  f=Fake(snapshot(paused=True,wechat=False,desktop='login_ready'));r=run(f,{},10000);self.assertEqual(r['state'],'maintenance');self.assertFalse(f.actions or f.notices)
 def test_phone_confirmation_never_restarts_or_clicks(self):
  f=Fake(snapshot(wechat=False,desktop='needs_phone'));r=run(f,{},10000);self.assertEqual(r['state'],'needs_phone');self.assertFalse(f.actions);self.assertEqual(len(f.notices),1)
 def test_identical_phone_warning_is_not_sent_hourly(self):
  f=Fake(snapshot(wechat=False,desktop='needs_phone'));r=run(f,{'notified':'needs_phone:phone_confirmation','incident':'old'},10000);self.assertFalse(f.notices)
 def test_locked_desktop_requires_phone_unlock(self):
  f=Fake(snapshot(wechat=False,desktop='needs_unlock'));r=run(f,{},10000);self.assertEqual(r['state'],'needs_unlock');self.assertFalse(f.actions)
 def test_login_button_is_clicked_only_once_then_stops_for_phone(self):
  f=Fake(snapshot(wechat=False,desktop='login_ready'),snapshot(wechat=False,desktop='needs_phone'));r=run(f,{},10000);self.assertEqual(f.actions,['click_login']);self.assertEqual(r['state'],'needs_phone')
 def test_missing_wechat_starts_before_optional_login_click(self):
  f=Fake(snapshot(wechat=False,desktop='process_missing'),snapshot(wechat=False,desktop='login_ready'),snapshot());r=run(f,{},10000);self.assertEqual(f.actions,['start_wechat','click_login']);self.assertEqual(r['state'],'online');self.assertEqual(len(f.reconciliations),1)
 def test_read_layer_restarts_without_touching_wechat(self):
  f=Fake(snapshot(wechat=False,desktop='ui_unavailable'),snapshot());run(f,{},10000);self.assertEqual(f.actions,['restart_adapter'])
 def test_same_failed_recovery_does_not_loop(self):
  f=Fake(snapshot(wechat=False,desktop='ui_unavailable'));run(f,{},10000);self.assertEqual(f.actions,['restart_adapter'])
 def test_global_two_recovery_actions_per_hour_cap(self):
  f=Fake(snapshot(bridge=False));run(f,{'attempts':[{'at':9990,'action':'restart_bridge'},{'at':9995,'action':'restart_adapter'}]},10000);self.assertFalse(f.actions)
 def test_recovery_scan_only_once_per_incident(self):
  f=Fake(snapshot());r=run(f,{'incident':'prior','notified':'needs_phone:phone_confirmation'},10000);self.assertEqual(f.reconciliations,[('prior',10000)]);self.assertIsNone(r['incident']);run(f,r,13600);self.assertEqual(len(f.reconciliations),1)
 def test_stopped_container_is_not_automatically_started(self):
  f=Fake(snapshot(running={'wechat':False,'bridge':True,'maibot':True},wechat=False));r=run(f,{},10000);self.assertEqual(r['state'],'offline');self.assertFalse(f.actions)
 def test_notification_failure_keeps_retry_pending(self):
  class Failure(Fake):
   def notify(self,*values):raise OSError('offline')
  r=run(Failure(snapshot(wechat=False,desktop='needs_phone')),{},10000);self.assertTrue(r['notification_pending']);self.assertIsNone(r['notified'])
 def test_status_upload_failure_keeps_local_diagnosis(self):
  class Failure(Fake):
   def report(self,*values):raise OSError('offline')
  r=run(Failure(snapshot()),{},10000);self.assertTrue(r['report_pending']);self.assertEqual(r['state'],'online')
 def test_reconciliation_failure_keeps_the_original_recovery_window(self):
  class Failure(Fake):
   def reconcile(self,*values):raise OSError('offline')
  r=run(Failure(snapshot()),{'incident':'old'},10000)
  self.assertTrue(r['reconciliation_pending']);self.assertEqual(r['incident'],'old');self.assertEqual(r['recovered_at'],10000)
  f=Fake(snapshot());run(f,r,13600);self.assertEqual(f.reconciliations,[('old',10000)])
class UiLockTests(unittest.TestCase):
 def test_ui_lock_is_not_healthy_even_when_connected_flag_is_true(self):
  f=Fake(snapshot(ui_input_blocked=True));r=run(f,{},10000)
  self.assertEqual(r['state'],'degraded');self.assertEqual(r['reason'],'ui_window_blocked')
  self.assertFalse(f.actions);self.assertEqual(len(f.notices),1)
 def test_same_ui_lock_alert_is_deduplicated_and_manual_pause_still_wins(self):
  f=Fake(snapshot(ui_input_blocked=True));run(f,{'notified':'degraded:ui_window_blocked','incident':'prior'},10000);self.assertFalse(f.notices)
  self.assertEqual(classify(snapshot(ui_input_blocked=True,paused=True)),('maintenance','manual_pause'))
if __name__=='__main__':unittest.main()
