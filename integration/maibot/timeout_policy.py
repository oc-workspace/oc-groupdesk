"""Validated per-group time budgets; never mutate shared native task/provider settings."""
DEFAULTS={'planner_seconds':300,'request_seconds':310,'direct_ttl_seconds':420}
LIMITS={'planner_seconds':(30,600),'request_seconds':(40,660),'direct_ttl_seconds':(105,1800)}

def validate(value):
    if not isinstance(value,dict) or set(value)!=set(DEFAULTS):raise ValueError('Invalid timeout policy fields')
    for key,(lower,upper) in LIMITS.items():
        if type(value[key]) is not int or not lower<=value[key]<=upper:raise ValueError('Invalid timeout policy bounds')
    if value['request_seconds']<value['planner_seconds']+10 or value['direct_ttl_seconds']<value['request_seconds']+65:
        raise ValueError('Inconsistent timeout policy budgets')
    return dict(value)

def for_group(config,chat):
    managed=config.get('managed_groups',{}).get(str(chat))
    raw=(managed or {}).get('policy',{}).get('timeouts')
    if raw is not None:return validate(raw)
    # Preserve pre-contract behavior and unmanaged regression fixtures.
    return {**DEFAULTS,'direct_ttl_seconds':config.get('direct_turn_ttl_seconds',config.get('turn_ttl_seconds',420))}

def task_timeout(task,native_timeout):
    if task!='planner':return native_timeout
    from group_guard import policy,TURN
    import groupdesk_runtime as gd
    from src.llm_models.exceptions import ReqAbortException
    p=policy();turn=p.active_turn()
    if not turn:return native_timeout  # Existing admission gate rejects background work.
    managed=gd.profile(p.cfg,turn.get('chat_id',''))
    if not managed or 'timeouts' not in managed.get('policy',{}):return native_timeout
    if not gd.available(managed,p.clock()) or str(turn.get('policy_revision',''))!=gd.revision(managed) or (TURN.get() and TURN.get()!=turn['id']):
        raise ReqAbortException('GroupDesk timeout policy unavailable')
    return min(for_group(p.cfg,turn['chat_id'])['planner_seconds'],max(.1,turn['expires']-p.clock()-5))

def scoped_provider(provider,seconds):
    # Native client cache is keyed by provider name, not its timeout. The suffix
    # keeps requests with different budgets on different cached SDK clients.
    return provider.model_copy(deep=True,update={'name':provider.name+'-groupdesk-t'+str(seconds),'timeout':seconds})
