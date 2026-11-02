"""Per-group non-mention reply rounds and follow-up recognition; no quota bypass."""
DEFAULTS={'enabled':True,'max_rounds':2,'reset_seconds':180,'followup_seconds':180}

def validate(value):
 if not isinstance(value,dict) or set(value)!=set(DEFAULTS):raise ValueError('Invalid reply limit fields')
 if type(value['enabled']) is not bool:raise ValueError('Invalid reply limit switch')
 for key,low,high in [('max_rounds',1,20),('reset_seconds',30,1800),('followup_seconds',30,1800)]:
  if type(value[key]) is not int or not low<=value[key]<=high:raise ValueError('Invalid reply limit bounds')
 return dict(value)

def validate_bundle(p):
 version=p.get('reply_limits_contract_version');raw=p.get('policy',{}).get('conversation',{}).get('reply_limits')
 if version is None and raw is None:return
 if version!=1 or raw is None:raise ValueError('Unknown or missing reply limits contract')
 validate(raw)

def for_group(config,chat):
 profile=config.get('managed_groups',{}).get(str(chat))
 if profile and (profile.get('reply_limits_contract_version') is not None or profile.get('policy',{}).get('conversation',{}).get('reply_limits') is not None):
  validate_bundle(profile)
  return validate(profile['policy']['conversation']['reply_limits'])
 # Old server contracts and unmanaged fixtures retain their original behavior.
 return {'enabled':True,'max_rounds':config.get('conversation_rounds',2),'reset_seconds':config.get('conversation_reset_seconds',180),'followup_seconds':config.get('followup_seconds',180)}
