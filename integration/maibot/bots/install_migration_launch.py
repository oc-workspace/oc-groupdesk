"""Patch only reviewed staged Tatsumi bridge hooks for migration launch."""
import argparse
from pathlib import Path


def once(source,old,new):
    if new in source:return source
    if source.count(old)!=1:raise ValueError('Unknown bridge migration anchor')
    return source.replace(old,new,1)


def main(runtime):
    source=Path(__file__).resolve().parent
    bridge_file=runtime/'bridge/app.py'
    bridge=bridge_file.read_text()
    bridge=once(bridge,'from reply_mention import deliver, target_for_reply\n',
                'from reply_mention import deliver, target_for_reply, strict_migration_reply\nimport migration_launch\n')
    bridge=once(bridge,'                member = target_for_reply(self.policy, source_id, chat.id)\n',
                '''                member = target_for_reply(self.policy, source_id, chat.id)
                strict_migration = strict_migration_reply(self.policy, turn_id)
                if strict_migration and not member:raise Denied('migration_reply_member_unavailable')
''')
    bridge=once(bridge,"                                       member=member, before_fallback=before_fallback)\n",
                "                                       member=member, before_fallback=before_fallback, allow_fallback=not strict_migration)\n")
    bridge=once(bridge,'run_interactions(self), run_summaries(self))',
                'run_interactions(self), run_summaries(self), migration_launch.run(self))')
    bridge=once(bridge,'                status=await asyncio.to_thread(bot_runtime.sync,self)\n                self.policy.cfg=settings()\n',
                '''                status=await asyncio.to_thread(bot_runtime.sync,self)
                self.health.pop('groupdesk_error',None)
                self.policy.cfg=settings()
''')
    files={bridge_file:bridge,
           runtime/'limits/migration_launch.py':(source/'migration_launch.py').read_text(),
           runtime/'limits/reply_mention.py':(source.parent/'native-mentions/reply_mention.py').read_text()}
    for path,text in files.items():compile(text,str(path),'exec')
    for path,text in files.items():path.write_text(text)


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('runtime',type=Path)
    main(parser.parse_args().runtime)
