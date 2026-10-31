"""Patch checked copies of the current production files; never edits them in place."""
from pathlib import Path
import argparse,ast,hashlib,json
p=argparse.ArgumentParser();p.add_argument('source',type=Path);p.add_argument('destination',type=Path);a=p.parse_args()
a.destination.mkdir(parents=True,exist_ok=True)
s=(a.source/'utils_model.py').read_text()
snapshot='        model_info = request.model_info\n        api_provider = TempMethodsLLMUtils.get_provider_by_name(model_info.api_provider)\n'
selected='        model_info = TempMethodsLLMUtils.get_model_info_by_name(selected_model_name)\n        api_provider = TempMethodsLLMUtils.get_provider_by_name(model_info.api_provider)\n'
assert s.count(snapshot)==1 and s.count(selected)==1,'Unexpected native selection source'
call='        from model_routing import select_route\n        model_info, api_provider = select_route(model_info, api_provider, self.task_name)\n'
s=s.replace(snapshot,'        model_info = request.model_info\n        from model_routing import select_route\n        model_info, api_provider = select_route(model_info, None, self.task_name)\n        if api_provider is None:\n            api_provider = TempMethodsLLMUtils.get_provider_by_name(model_info.api_provider)\n        request.model_info = model_info\n').replace(selected,selected+call)
ast.parse(s);(a.destination/'utils_model.py').write_text(s)
s=(a.source/'groupdesk_runtime.py').read_text()
anchor="            b=api('/config/'+urllib.parse.quote(external,safe=''));validate_bundle(b,external)\n"
assert s.count(anchor)==1,'Unexpected GroupDesk sync source'
if 'validate_private_route(b,' not in s:
 s=s.replace(anchor,anchor+"            if b.get('model_routing_contract_version')==1 and b.get('model_routing',{}).get('text',{}).get('available'):\n                private=api('/model-credentials',{'group_id':b['id'],'revision':b['revision']})['text_route']\n                from model_routing import validate_private_route\n                validate_private_route(b,private);b['private_text_route']=private\n")
validation="    if bundle.get('policy_contract_version')!=1 or bundle.get('external_id')!=external_id:raise ValueError('GroupDesk contract/group mismatch')\n"
assert validation in s,'Unexpected contract validation source'
if 'Unknown model routing contract' not in s:s=s.replace(validation,validation+"    if bundle.get('model_routing_contract_version') not in [None,1]:raise ValueError('Unknown model routing contract')\n")
ack="api('/ack',{'group_id':group_id,'revision':rev})"
new_ack="api('/ack',{'group_id':group_id,'revision':rev,'model_routing_version':1})"
assert s.count(ack)==1 or s.count(new_ack)==1,'Unexpected GroupDesk ack source'
s=s.replace(ack,new_ack)
ast.parse(s);(a.destination/'groupdesk_runtime.py').write_text(s)
print('Checked native model selection and private route sync patches generated.')
