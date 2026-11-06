"""Trusted per-robot, per-group naming contract. No message text can set names."""
import hashlib,json,uuid

def validate_bundle(bundle,own_bot_id=None):
    version=bundle.get('bot_identity_contract_version')
    if version is None:
        if any(k in bundle for k in ['bot_identity','bot_identity_sha256','bot_name_instructions']):raise ValueError('Missing bot identity contract')
        return None
    identity=bundle.get('bot_identity')
    if type(version) is not int or version!=1 or not isinstance(identity,dict):raise ValueError('Unsupported bot identity contract')
    if set(identity)!={'bot_id','group_id','display_name','self_reference','mention_names'}:raise ValueError('Invalid bot identity fields')
    for key in ['bot_id','group_id']:uuid.UUID(identity[key])
    if identity['group_id']!=bundle.get('id') or (own_bot_id and identity['bot_id']!=own_bot_id):raise ValueError('Bot identity scope mismatch')
    def valid(text,limit,empty=False):return isinstance(text,str) and (empty or bool(text.strip())) and len(text)<=limit and all(ord(c)>=32 and ord(c)!=127 for c in text)
    if not valid(identity['display_name'],120) or (identity['self_reference'] is not None and not valid(identity['self_reference'],40)):raise ValueError('Invalid bot display name')
    names=identity['mention_names']
    if not isinstance(names,list) or len(names)>12 or any(not valid(n,80) or n!=n.strip() for n in names) or len({n.lower() for n in names})!=len(names):raise ValueError('Invalid group mention names')
    manifest=[1,identity['bot_id'],identity['group_id'],identity['display_name'],identity['self_reference'],names]
    expected=hashlib.sha256(json.dumps(manifest,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()
    if expected!=bundle.get('bot_identity_sha256'):raise ValueError('Bot identity digest mismatch')
    instructions=bundle.get('bot_name_instructions')
    if not isinstance(instructions,list) or not 1<=len(instructions)<=10 or any(not isinstance(s,str) or not 1<=len(s)<=4000 for s in instructions):raise ValueError('Invalid bot naming instructions')
    return identity
