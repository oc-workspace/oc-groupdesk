"""Validated per-group time budgets; never mutate shared native task/provider settings."""
DEFAULTS={'planner_seconds':300,'replyer_seconds':300,'request_seconds':310,'direct_ttl_seconds':420,'wait_apology_seconds':300}
LIMITS={'planner_seconds':(30,600),'replyer_seconds':(30,600),'request_seconds':(40,660),'direct_ttl_seconds':(105,1800),'wait_apology_seconds':(60,1800)}

def validate(value,require_apology=False,require_replyer=False):
    required=set(DEFAULTS)-{'wait_apology_seconds','replyer_seconds'}
    if require_apology:required.add('wait_apology_seconds')
    if require_replyer:required.add('replyer_seconds')
    if not isinstance(value,dict) or not required<=set(value)<=set(DEFAULTS):raise ValueError('Invalid timeout policy fields')
    value={**DEFAULTS,**({'replyer_seconds':min(300,value['request_seconds']-10)} if 'replyer_seconds' not in value and type(value.get('request_seconds')) is int else {}),**value}
    for key,(lower,upper) in LIMITS.items():
        if type(value[key]) is not int or not lower<=value[key]<=upper:raise ValueError('Invalid timeout policy bounds')
    if value['wait_apology_seconds']%60!=0:raise ValueError('Apology threshold must be whole minutes')
    if value['request_seconds']<max(value['planner_seconds'],value['replyer_seconds'])+10 or value['direct_ttl_seconds']<value['request_seconds']+65:
        raise ValueError('Inconsistent timeout policy budgets')
    return dict(value)

def for_group(config,chat):
    managed=config.get('managed_groups',{}).get(str(chat))
    raw=(managed or {}).get('policy',{}).get('timeouts')
    if raw is not None:
        result=validate(raw)
        if 'wait_apology_seconds' not in raw:result['wait_apology_seconds']=config.get('wait_apology_seconds',300)
        return result
    # Preserve pre-contract behavior and unmanaged regression fixtures.
    return {**DEFAULTS,'direct_ttl_seconds':config.get('direct_turn_ttl_seconds',config.get('turn_ttl_seconds',420)),'wait_apology_seconds':config.get('wait_apology_seconds',300)}

def task_timeout(task,native_timeout):
    if task not in {'planner','replyer'}:return native_timeout
    from group_guard import policy,TURN
    import groupdesk_runtime as gd
    from src.llm_models.exceptions import ReqAbortException
    p=policy();turn=p.active_turn()
    if not turn:return native_timeout  # Existing admission gate rejects background work.
    managed=gd.profile(p.cfg,turn.get('chat_id',''))
    if not managed or 'timeouts' not in managed.get('policy',{}):return native_timeout
    if task=='replyer' and 'replyer_seconds' not in managed['policy']['timeouts']:return native_timeout
    if not gd.available(managed,p.clock()) or str(turn.get('policy_revision',''))!=gd.revision(managed) or (TURN.get() and TURN.get()!=turn['id']):
        raise ReqAbortException('GroupDesk timeout policy unavailable')
    return min(for_group(p.cfg,turn['chat_id'])[task+'_seconds'],max(.1,turn['expires']-p.clock()-5))

def scoped_provider(provider,seconds):
    # Native client cache is keyed by provider name, not its timeout. The suffix
    # keeps requests with different budgets on different cached SDK clients.
    return provider.model_copy(deep=True,update={'name':provider.name+'-groupdesk-t'+str(seconds),'timeout':seconds})
