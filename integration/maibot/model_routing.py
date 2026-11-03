"""Select a private GroupDesk text route for the admitted source group only."""
import time

STAGES=('planner','replyer','fast_model','utils','summary')
RUNTIME_STAGES=STAGES[:-1]

def validate_stage_routes(bundle,private):
    if bundle.get('model_stage_routing_contract_version')!=1:raise ValueError('Unknown stage routing contract')
    routes=bundle.get('model_routing',{}).get('stages')
    if not isinstance(routes,dict) or set(routes)!=set(STAGES) or not isinstance(private,dict) or set(private)!=set(RUNTIME_STAGES):raise ValueError('Incomplete stage routes')
    for stage in RUNTIME_STAGES:
        route=routes[stage]
        if route.get('available'):validate_private_route({'model_routing':{'text':route}},private[stage])
        elif private[stage] is not None:raise ValueError('Unexpected unavailable stage credential')

def shortcut_allowed(managed):
    if not managed or 'model_stage_routing_contract_version' not in managed:return True
    if managed.get('model_stage_routing_contract_version')!=1:return False
    stages=managed.get('model_routing',{}).get('stages',{})
    planner=stages.get('planner',{});replyer=stages.get('replyer',{})
    if planner.get('source')=='legacy' and replyer.get('source')=='legacy':return True
    keys=('credential_id','credential_revision','model_id','client_type')
    return bool(planner.get('available') and replyer.get('available') and all(planner.get(k)==replyer.get(k) for k in keys))

def validate_private_route(bundle,private):
    route=bundle['model_routing']['text']
    if not isinstance(private,dict) or any(private.get(k)!=route.get(k) for k in ['credential_id','credential_revision','model_id']):raise ValueError('Private model route mismatch')
    if route.get('client_type','openai')!=private.get('client_type'):raise ValueError('Private model protocol mismatch')
    if not isinstance(private.get('api_key'),str) or not private['api_key'] or not str(private.get('base_url','')).startswith('https://') or private.get('client_type') not in ['openai','openai_responses','gemini']:raise ValueError('Invalid private model route')

def request_extra_params(protocol,model_id):
    if protocol=='openai_responses':return {'store':False}
    if protocol=='gemini' and model_id=='gemini-3.8-flash':
        return {'thinking_config':{'thinking_level':'LOW','include_thoughts':False}}
    return {}

def select_route(model_info,api_provider,task):
    from group_guard import policy,TURN
    import groupdesk_runtime as gd
    from src.llm_models.exceptions import ReqAbortException
    from src.config.model_configs import APIProvider
    p=policy();turn=p.active_turn()
    if not turn:return model_info,api_provider  # Existing admission gate still rejects background requests.
    managed=gd.profile(p.cfg,turn.get('chat_id',''))
    if not managed or 'model_routing_contract_version' not in managed:return model_info,api_provider
    def deny():raise ReqAbortException('GroupDesk text route unavailable')
    if managed.get('model_routing_contract_version')!=1 or not gd.available(managed,p.clock()) or str(turn.get('policy_revision',''))!=gd.revision(managed):deny()
    if TURN.get() and TURN.get()!=turn['id']:deny()
    route=managed.get('model_routing',{}).get('text',{})
    private=managed.get('private_text_route') or {}
    if 'model_stage_routing_contract_version' in managed:
        if managed.get('model_stage_routing_contract_version')!=1:deny()
        if task in RUNTIME_STAGES:
            route=managed.get('model_routing',{}).get('stages',{}).get(task,{})
            private=managed.get('private_stage_routes',{}).get(task) or {}
    from timeout_policy import for_group,scoped_provider
    seconds=for_group(p.cfg,turn['chat_id'])['request_seconds']
    if route.get('source')=='legacy':
        if 'timeouts' not in managed.get('policy',{}):return model_info,api_provider
        if api_provider is None:
            from src.llm_models.utils_model import TempMethodsLLMUtils
            api_provider=TempMethodsLLMUtils.get_provider_by_name(model_info.api_provider)
        return model_info,scoped_provider(api_provider,seconds)
    if route.get('source')=='disabled' or not route.get('available'):deny()
    if any(private.get(k)!=route.get(k) for k in ['credential_id','credential_revision','model_id']) or not private.get('api_key'):deny()
    protocol=private.get('client_type','openai')
    if protocol not in ['openai','openai_responses','gemini'] or route.get('client_type','openai')!=protocol:deny()
    provider_name='groupdesk-'+private['credential_id']+'-v'+str(private['credential_revision'])+'-t'+str(seconds)
    provider=APIProvider(name=provider_name,base_url=private['base_url'],api_key=private['api_key'],client_type=protocol,auth_type='bearer',max_retry=2,timeout=seconds,retry_interval=4)
    # Keep MaiBot's task slot name so native selection/retry accounting stays balanced.
    # The actual identifier and provider are request-local and used for the wire call.
    model=model_info.model_copy(deep=True,update={'model_identifier':private['model_id'],'api_provider':provider_name,'send_temperature':False,'extra_params':request_extra_params(protocol,private['model_id'])})
    return model,provider
