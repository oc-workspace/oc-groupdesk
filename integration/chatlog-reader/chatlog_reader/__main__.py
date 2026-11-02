import json
import os
from pathlib import Path
import resource
import sys
from .engine import Engine,config
from .vault import initialize,private_write,unwrap

def main():
    resource.setrlimit(resource.RLIMIT_CORE,(0,0))
    action=sys.argv[1] if len(sys.argv)>1 else 'serve'
    secrets=Path(os.environ.get('READER_SECRETS','/secrets'))
    client=Path(os.environ.get('READER_CLIENT','/client'))
    if action=='init':
        initialize(secrets,client)
        print(json.dumps({'vault_initialized':True}));return
    if action=='health':
        import urllib.request
        with urllib.request.urlopen('http://127.0.0.1:5030/healthz',timeout=5) as response:
            assert json.load(response)['ok'] is True
        return
    settings=config(os.environ.get('READER_CONFIG','/config/reader.json'))
    if action=='import-key':
        source=Path('/imports/encrypted-key.json')
        data=source.read_bytes()
        if len(data)>2048:
            raise ValueError('Invalid envelope size')
        key=unwrap(data,settings['account'],secrets/'vault-private.pem')
        from chatlog_keeper import wechat_db
        database=Path('/wechat')/settings['account']/'db_storage/message/message_0.db'
        if not wechat_db._verify_key_v4(key,wechat_db._read_stable_page1(database)):
            raise ValueError('Key authentication failed')
        private_write(secrets/'wechat-key.enc',data)
        key=None
        print(json.dumps({'encrypted_key_imported':True,'database_hmac':True}));return
    if action!='serve':
        raise ValueError('Unknown command')
    from .server import serve
    engine=Engine(settings)
    token=(client/'api-token').read_text().strip()
    if len(token)!=64:
        raise ValueError('Invalid token file')
    serve(engine,token)

if __name__=='__main__':
    try:
        main()
    except Exception as exc:
        print(json.dumps({'error':type(exc).__name__}),file=sys.stderr)
        raise SystemExit(1)
