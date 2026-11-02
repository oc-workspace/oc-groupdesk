"""One-shot, visible startup capture in a Docker profile. Public key only."""
import hashlib
import json
import os
from pathlib import Path
import resource
import shutil
import sys
import tempfile
from chatlog_keeper import linux_key,wechat_db
from .vault import wrap,private_write

EXPECTED='2ca28ea56b1a400543d0128ebaf0b93f88172dd66dc0426d3d74fdb971eab959'

def main():
    assert os.geteuid()==1000
    resource.setrlimit(resource.RLIMIT_CORE,(0,0))
    assert hashlib.sha256(Path('/opt/wechat/wechat').read_bytes()).hexdigest()==EXPECTED
    if linux_key.daily_client_running('wechat'):
        raise RuntimeError('Unexpected client in bootstrap container')
    account=os.environ['READER_ACCOUNT']
    assert account and '/' not in account and '\\' not in account and account not in ('.','..')
    database=Path('/config/xwechat_files')/account/'db_storage/message/message_0.db'
    state=Path(tempfile.mkdtemp(prefix='reader-bootstrap-',dir='/dev/shm'))
    os.environ['CHATLOG_KEEPER_DATA_DIR']=str(state)
    key=None
    print(json.dumps({'phase':'waiting_for_visible_login','timeout_seconds':600}),flush=True)
    try:
        key=linux_key.extract_wechat_key_active(db_path=str(database),timeout=600)
        if not key or not wechat_db._verify_key_v4(key,wechat_db._read_stable_page1(database)):
            raise RuntimeError('No database-verified key')
        encrypted=wrap(key,account,'/bootstrap/vault-public.pem')
        private_write('/imports/encrypted-key.json',encrypted)
        print(json.dumps({'encrypted_key_ready':True,'database_hmac':True}),flush=True)
    finally:
        key=None
        shutil.rmtree(state,ignore_errors=True)

if __name__=='__main__':
    try:main()
    except Exception as exc:
        print(json.dumps({'error':type(exc).__name__}),file=sys.stderr,flush=True)
        raise SystemExit(1)
