"""Select a private GroupDesk text route for the admitted source group only."""
import time

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
    if route.get('source')=='legacy':return model_info,api_provider
    private=managed.get('private_text_route') or {}
    if route.get('source')=='disabled' or not route.get('available'):deny()
    if any(private.get(k)!=route.get(k) for k in ['credential_id','credential_revision','model_id']) or not private.get('api_key'):deny()
    protocol=private.get('client_type','openai')
    if protocol not in ['openai','openai_responses','gemini'] or route.get('client_type','openai')!=protocol:deny()
    provider_name='groupdesk-'+private['credential_id']+'-v'+str(private['credential_revision'])
    provider=APIProvider(name=provider_name,base_url=private['base_url'],api_key=private['api_key'],client_type=protocol,auth_type='bearer',max_retry=2,timeout=80,retry_interval=4)
    # Keep MaiBot's task slot name so native selection/retry accounting stays balanced.
    # The actual identifier and provider are request-local and used for the wire call.
    model=model_info.model_copy(deep=True,update={'model_identifier':private['model_id'],'api_provider':provider_name,'send_temperature':False,'extra_params':request_extra_params(protocol,private['model_id'])})
    return model,provider
