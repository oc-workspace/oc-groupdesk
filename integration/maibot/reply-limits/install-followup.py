"""Permit already recognized direct follow-ups without enabling passive chat."""
from pathlib import Path
import ast,hashlib,json,sys

def patched(data):
    baselines=json.loads(Path(__file__).with_name('followup-baseline.json').read_text())
    digest=hashlib.sha256(data).hexdigest()
    if digest==baselines['after']:return data
    if digest!=baselines['before']:raise ValueError('Unknown follow-up policy baseline')
    before="if not explicit and (managed.get('interaction')=='mention' or managed['policy']['participation']=='quiet'):return 'mention_only'"
    after="if not explicit and (managed['policy']['participation']=='quiet' or (managed.get('interaction')=='mention' and kind!='direct')):return 'mention_only'"
    source=data.decode()
    if source.count(before)!=1:raise ValueError('Ambiguous follow-up gate')
    previous="AND s.status=\"sent\" AND s.ts>?', (sender,now-reply_limits.for_group(self.cfg,chat_id)['followup_seconds']))"
    updated="AND s.status=\"sent\" AND t.ended>?', (sender,now-reply_limits.for_group(self.cfg,chat_id)['followup_seconds']))"
    if source.count(previous)!=1:raise ValueError('Ambiguous follow-up completion time')
    result=source.replace(before,after,1).replace(previous,updated,1).encode();ast.parse(result.decode())
    if hashlib.sha256(result).hexdigest()!=baselines['after']:raise ValueError('Unexpected follow-up policy result')
    return result

if __name__=='__main__':
    path=Path(sys.argv[1]);data=path.read_bytes();result=patched(data)
    if data!=result:path.write_bytes(result)
    print('Verified direct follow-up gate installed')
