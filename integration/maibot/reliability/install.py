"""Checked, idempotent patch for the Linux bridge and MaiBot lifecycle."""
import argparse
import ast
from pathlib import Path


def replace(source, old, new):
    if new in source:
        return source
    if source.count(old)!=1:
        raise ValueError('Unknown runtime baseline near '+old[:90])
    return source.replace(old,new)


def install(root):
    files={name:(root/name).read_text() for name in (
        'limits/policy.py','limits/group_guard.py','bridge/app.py','patched/reasoning_engine.py')}
    name='limits/policy.py'
    files[name]=replace(files[name],'            frequency.init(db)\n',
        '            frequency.init(db)\n            import chat_reliability\n            chat_reliability.init(db)\n')
    old="                self.count(db,'sender_queue_full'); return 'sender_queue_full'"
    new="""                if direct:
                    return frequency.defer(self,db,seq,sender,display,text,
                        min(now,timestamp) if timestamp is not None else now,chat_id,explicit,
                        gd.revision(managed),topic_refs,reply_source_seq=reply_source_seq)
                self.count(db,'sender_queue_full'); return 'sender_queue_full'"""
    files[name]=replace(files[name],old,new)
    old="""                if not victim:
                    self.count(db,'queue_full'); return 'queue_full'"""
    new="""                if not victim:
                    if direct:
                        return frequency.defer(self,db,seq,sender,display,text,
                            min(now,timestamp) if timestamp is not None else now,chat_id,explicit,
                            gd.revision(managed),topic_refs,reply_source_seq=reply_source_seq)
                    self.count(db,'queue_full'); return 'queue_full'"""
    files[name]=replace(files[name],old,new)
    name='limits/group_guard.py'
    files[name]=replace(files[name],'        TURN.set(turn_id)\n',
        '        TURN.set(turn_id)\n        import chat_reliability\n        chat_reliability.stage(p,turn_id,task)\n')
    files[name]=replace(files[name],'    attempt=Attempt(identifier)\n',
        '    attempt=Attempt(identifier)\n    failure=None\n')
    files[name]=replace(files[name],
        "        except TimeoutError:\n            raise ReqAbortException('GT turn deadline reached') from None",
        "        except TimeoutError as exc:\n            failure=exc\n            raise ReqAbortException('GT turn deadline reached') from None")
    files[name]=replace(files[name],
        '        except Exception as exc:\n            # Compare only in memory;',
        '        except Exception as exc:\n            failure=exc\n            # Compare only in memory;')
    old='        await asyncio.shield(asyncio.to_thread(p.settle_model,identifier,attempt.tokens))'
    files[name]=replace(files[name],old,old+"""
        if failure is not None:
            import chat_reliability
            chat_reliability.model_failed(p,turn_id,task,failure)""")
    old="    config['gt_limit_turn']=identifier or 'unattributed'"
    new="""    config['gt_limit_turn']=identifier or 'unattributed'
    if identifier:
        import chat_reliability
        chat_reliability.stage(policy(),identifier,'sending')"""
    files[name]=replace(files[name],old,new)
    name='patched/reasoning_engine.py'
    old="""                            state.cycle_end = await self._finalize_cycle(
                                cycle_detail=cycle_detail,
                                round_index=round_index,
                                state=state,
                            )"""
    new="""                            from chat_reliability import finalize as finalize_admitted_cycle
                            state.cycle_end = await finalize_admitted_cycle(self._finalize_cycle(
                                cycle_detail=cycle_detail,
                                round_index=round_index,
                                state=state,
                            ), state.cycle_end)"""
    files[name]=replace(files[name],old,new)
    old="""                finally:
                    self._turn_passive_replyer = None"""
    new="""                finally:
                    from chat_reliability import complete_bound_turn
                    complete_bound_turn()
                    self._turn_passive_replyer = None"""
    files[name]=replace(files[name],old,new)
    name='bridge/app.py'
    old='                    turn = self.policy.dispatch()'
    new="""                    import chat_reliability
                    await chat_reliability.send_failure_notice(self)
                    turn = self.policy.dispatch()"""
    files[name]=replace(files[name],old,new)
    old="                self.health['verified_sends'] += 1"
    new="""                import chat_reliability
                chat_reliability.stage(self.policy,turn_id,'sent')
                self.health['verified_sends'] += 1"""
    files[name]=replace(files[name],old,new)
    old="                    self.health['groupdesk']=status"
    new="""                    self.health['groupdesk']=status
                    import chat_reliability
                    try:
                        await chat_reliability.report(self)
                        self.health.pop('request_status_error',None)
                    except Exception as exc:
                        self.health['request_status_error']=type(exc).__name__"""
    files[name]=replace(files[name],old,new)
    # Validation of every target precedes any write.
    for name,source in files.items():
        ast.parse(source.lstrip('\ufeff'),filename=name)
    for name,source in files.items():
        (root/name).write_text(source)
    (root/'limits/chat_reliability.py').write_text((Path(__file__).parent/'chat_reliability.py').read_text())


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('runtime',type=Path)
    args=parser.parse_args()
    install(args.runtime)
