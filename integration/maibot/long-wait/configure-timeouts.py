"""Run on the server only; preserve every credential and unrelated TOML value."""
from pathlib import Path
import re,sys,tomllib
source=Path(sys.argv[1]);target=Path(sys.argv[2]);text=source.read_text()
before=tomllib.loads(text)
def planner(match):
    block,count=re.subn(r'(?m)^([ \t]*hard_timeout[ \t]*=[ \t]*)[0-9.]+', r'\g<1>300.0',match.group())
    if count!=1:raise ValueError('Unexpected planner timeout baseline')
    return block
text,count=re.subn(r'(?ms)^\[model_task_config\.planner\][^\n]*\n.*?(?=^\[|\Z)',planner,text)
if count!=1:raise ValueError('Planner section missing')
def provider(match):
    block,count=re.subn(r'(?m)^([ \t]*timeout[ \t]*=[ \t]*)[0-9.]+', r'\g<1>310',match.group())
    if count!=1:raise ValueError('Unexpected provider timeout baseline')
    return block
text,count=re.subn(r'(?ms)^\[\[api_providers\]\][^\n]*\n.*?(?=^\[|\Z)',provider,text)
if count!=len(before['api_providers']):raise ValueError('Provider sections mismatch')
after=tomllib.loads(text);expected=tomllib.loads(source.read_text())
expected['model_task_config']['planner']['hard_timeout']=300.
for item in expected['api_providers']:item['timeout']=310
if after!=expected:raise ValueError('Unrelated model configuration changed')
target.write_text(text);target.chmod(0o600)
print('Planner hard timeout=300s; provider timeout=310s; all other values preserved')
