"""Install only recognized public-code hooks; validate every file before writing."""
import argparse
import ast
import hashlib
from pathlib import Path
import shutil

parser=argparse.ArgumentParser()
parser.add_argument('--root',type=Path,required=True)
parser.add_argument('--bowxt-only',action='store_true')
args=parser.parse_args()
root=args.root
changes={}

def plan(name,expected,pairs):
    if args.bowxt_only and name!='.build/wechat-adapter/bowxt/src/bowxt/service.py':return
    path=root/name
    original=path.read_text()
    if all(after in original for _,after in pairs):
        return
    if hashlib.sha256(path.read_bytes()).hexdigest()!=expected:
        raise ValueError('Unknown native baseline: '+name)
    result=original
    for before,after in pairs:
        if result.count(before)!=1:
            raise ValueError('Ambiguous native hook: '+name)
        result=result.replace(before,after,1)
    ast.parse(result)
    changes[path]=result

plan('bridge/app.py','840ba7e014b9b21d23daa31fee1ffb4d9801645664f83c1eb41d2735bd769b33',[
    ('from summary_runtime import run as run_summaries','from summary_runtime import run as run_summaries\nfrom chatlog_runtime import attach_reader'),
    ("self.agent = AgentClient('maibot-gt', base_url=os.environ.get('BOWXT_BASE_URL', 'http://wechat:8787'))",
     "self.agent = attach_reader(AgentClient('maibot-gt', base_url=os.environ.get('BOWXT_BASE_URL', 'http://wechat:8787')),self.state_dir)"),
    ("    value=getattr(message,'observed_at',None) or message.timestamp",
     "    value=message.timestamp if getattr(message,'source_kind',None)=='wechat_database' else getattr(message,'observed_at',None) or message.timestamp"),
    ('    def heartbeat(self):\n        value = dict(self.health,',
     "    def heartbeat(self):\n        self.health['data_source']='chatlog-keeper' if getattr(self.agent,'source_kind',None)=='wechat_database' else 'bowxt-ui'\n        if self.health['data_source']=='chatlog-keeper':self.health['reader']=dict(self.agent.source_status)\n        value = dict(self.health,"),
    ('昵称来自微信界面，时间可能缺失。没有完整群史查询工具，不能声称已读取过去12小时全部消息；此类请求应简短说明限制。',
     '昵称和时间以当前数据源提供的节选为准。当前回复只包含已提供的近期背景；长时段总结由GroupDesk的群聊总结读取服务器记录，不能声称本次回复已经查询完整群史。')
])
plan('wechat-adapter/launch-bowxt.py','17797a79a00f4f5e24bdd7f856a159e562d2b5c906d93c25558f5db6b1c0a72c',[
    ("if mode not in {'paused', 'polling'}:","if mode not in {'paused', 'polling', 'send_only'}:"),
    ("Only paused or allowlisted polling mode is supported","Only paused, allowlisted polling or send_only mode is supported")
])
plan('limits/summary_runtime.py','735b1d50f326fa6057a19610f912e98f2be30413d293cd53fa9d6f419ebda9a5',[
    ("payload={'token':job['token'],**({'messages':data} if data else {'error':'no_messages'})}",
     "payload={'token':job['token'],'source_kind':'wechat_database' if getattr(bridge.agent,'source_kind',None)=='wechat_database' else 'ui_archive',**({'messages':data} if data else {'error':'no_messages'})}")
])
plan('.build/wechat-adapter/bowxt/src/bowxt/service.py','d2e89480d7b0b7f84fab903f98253892d5f727f6ae99c5ea8d63a403fd8a4791',[
    ('    POLLING = "polling"\n    UNREAD', '    POLLING = "polling"\n    SEND_ONLY = "send_only"\n    UNREAD'),
    ('                # Sender-card reads are background work.',
     '''                if mode is SyncMode.SEND_ONLY:
                    # The database sidecar owns automatic ingress. Explicit
                    # sends still use the unchanged guarded UI queue above.
                    if not client.is_main_ui_ready:
                        client.disconnect()
                        client = None
                        applied_action_delay = None
                        applied_mode = None
                        self._set_status(wechat_connected=False, last_error="WeChat login is required")
                    self._wake.wait(self.poll_gap)
                    self._wake.clear()
                    continue

                # Sender-card reads are background work.''')
])
plan('availability/monitor.py','5a0b65ce99d2ea3e8278b042ccb67d8b9319c78dc029f9878f61a0bdc0f80608',[
    ("    if s.get('identity_unresolved',0):return 'degraded','message_identity_incomplete'",
     "    if s.get('reader_required') and not s.get('reader_ok'):return 'degraded','chatlog_reader_unavailable'\n    if s.get('identity_unresolved',0):return 'degraded','message_identity_incomplete'"),
    ("if s.get('ui_input_blocked') or reason=='message_identity_incomplete':return None",
     "if s.get('ui_input_blocked') or reason in {'message_identity_incomplete','chatlog_reader_unavailable'}:return None"),
    ("        if not wechat and running['wechat'] and not result['paused']:result['desktop']=self.desktop()",
     "        result['reader_required']=health.get('data_source')=='chatlog-keeper'\n        result['reader_ok']=bool(health.get('reader',{}).get('connected') and time.time()-health.get('reader',{}).get('checked_at',0)<60)\n        if result['reader_required']:result['identity_unresolved']=0\n        if not wechat and running['wechat'] and not result['paused']:result['desktop']=self.desktop()"),
    ("        if reason=='message_identity_incomplete':message+=",
     "        if reason=='chatlog_reader_unavailable':message+='\\nChatlog Reader读取服务异常，请检查容器健康、数据库密钥与同步状态；没有自动回退到旧采集或重启微信。'\n        if reason=='message_identity_incomplete':message+="),
    ("        rows=[]\n        with sqlite3.connect('file:'+str(PERSIST/'wechat/bowxt/messages.db')+'?mode=ro',uri=True) as db:\n            db.row_factory=sqlite3.Row\n            for group in config.values():\n                for row in db.execute('SELECT seq,chat_id,sender,content,message_type,direction,observed_at,is_at_me FROM messages WHERE chat_id=? AND seq>? AND direction=\"incoming\" AND message_type=\"text\" AND sender IS NOT NULL',(group['chat_id'],group.get('min_seq',0))):\n                    value=dict(row)\n                    try:value['source_at']=datetime.fromisoformat(value.pop('observed_at')).timestamp()\n                    except (ValueError,TypeError):continue\n                    if recovered_at-12*3600<=value['source_at']<=recovered_at:rows.append(value)",
     """        rows=[]
        health=json.loads((PERSIST/'bridge/health.json').read_text())
        if health.get('data_source')=='chatlog-keeper':
            process=subprocess.run(['docker','exec',NAMES['bridge'],'/MaiMBot/.venv/bin/python','-m','chatlog_runtime','recovery',str(recovered_at)],capture_output=True,text=True,check=True,timeout=60)
            rows=json.loads(process.stdout)['rows']
        else:
            with sqlite3.connect('file:'+str(PERSIST/'wechat/bowxt/messages.db')+'?mode=ro',uri=True) as db:
                db.row_factory=sqlite3.Row
                for group in config.values():
                    for row in db.execute('SELECT seq,chat_id,sender,content,message_type,direction,observed_at,is_at_me FROM messages WHERE chat_id=? AND seq>? AND direction="incoming" AND message_type="text" AND sender IS NOT NULL',(group['chat_id'],group.get('min_seq',0))):
                        value=dict(row)
                        try:value['source_at']=datetime.fromisoformat(value.pop('observed_at')).timestamp()
                        except (ValueError,TypeError):continue
                        if recovered_at-12*3600<=value['source_at']<=recovered_at:rows.append(value)""")
])
runtime=Path(__file__).resolve().parent.parent/'maibot/chatlog_runtime.py'
destination=root/'limits/chatlog_runtime.py'
if not args.bowxt_only and destination.exists() and destination.read_bytes()!=runtime.read_bytes():
    raise ValueError('Unexpected pre-existing reader runtime')
for path,text in changes.items():
    path.write_text(text)
if not args.bowxt_only:shutil.copy2(runtime,destination)
bowxt=root/'.build/wechat-adapter/bowxt'
if (bowxt/'tests').is_dir():shutil.copy2(Path(__file__).parent/'test_send_only.py',bowxt/'tests/test_send_only.py')
print('native_reader_hooks_ready=True')
