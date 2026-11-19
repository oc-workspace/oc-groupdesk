"""Install an explicit Mac GUI source into an existing private GroupDesk policy bridge.

No process is started, no source is switched and no credentials are copied.
"""
import argparse
import ast
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile
import uuid


def sha(data):
    return hashlib.sha256(data).hexdigest()


def install(package, runtime, expected_sha, confirmed=False, check=False):
    package, runtime = Path(package), Path(runtime)
    bridge = runtime / 'bridge/app.py'
    if runtime.is_symlink() or bridge.is_symlink() or not bridge.is_file():
        raise ValueError('Private bridge/app.py is required')
    before = bridge.read_bytes()
    if sha(before) != expected_sha:
        raise ValueError('Bridge source changed; review the current bridge before installation')
    text = before.decode()
    marker = 'from mac_gui_stream import attach_mac_gui'
    if marker in text:
        raise ValueError('Mac GUI integration already present; inspect the prior installation manifest')
    original = "self.agent = attach_reader(AgentClient('maibot-gt', base_url=os.environ.get('BOWXT_BASE_URL', 'http://wechat:8787')),self.state_dir)"
    replacement = '''if os.environ.get('MAC_GUI_CONFIG'):
            if os.environ.get('CHATLOG_READER_URL'):
                raise ValueError('Select exactly one inbound source')
            from mac_gui_stream import Archive, check_config, json_file
            from mac_gui_sender import MacSender
            config = check_config(json_file(os.environ['MAC_GUI_CONFIG']))
            archive = Archive(os.environ['MAC_GUI_STATE'], config)
            sender = MacSender(archive, os.environ.get('MAC_GUI_SENDER'), os.environ.get('MAC_GUI_CAPTURE'))
            self.agent = attach_mac_gui(sender, os.environ['MAC_GUI_CONFIG'], os.environ['MAC_GUI_STATE'])
        else:
            ''' + original + '\n'
    if text.count(original) != 1:
        raise ValueError('Unsupported policy bridge entry point; local AI must review the installed bridge version')
    text = text.replace(original, replacement, 1)
    original_health = "self.health['data_source']='chatlog-keeper' if getattr(self.agent,'source_kind',None)=='wechat_database' else 'bowxt-ui'"
    if text.count(original_health) != 1:
        raise ValueError('Unsupported policy bridge health entry point')
    text = text.replace(original_health, "self.health['data_source']='macos-gui' if getattr(self.agent,'source_kind',None)=='wechat_gui' else 'chatlog-keeper' if getattr(self.agent,'source_kind',None)=='wechat_database' else 'bowxt-ui'", 1)
    text = text.replace("if self.health['data_source']=='chatlog-keeper':self.health['reader']=dict(self.agent.source_status)",
                        "if self.health['data_source'] in {'chatlog-keeper','macos-gui'}:self.health['reader']=dict(self.agent.source_status)")
    text = marker + '\n' + text
    ast.parse(text)
    files = {bridge: text.encode(), runtime/'limits/mac_gui_stream.py': (package/'stream.py').read_bytes(),
             runtime/'limits/mac_gui_sender.py': (package/'sender.py').read_bytes()}
    for path, data in files.items():
        ast.parse(data, filename=str(path))
        if path != bridge and path.exists():
            raise ValueError('A target adapter module exists; review it before replacing')
        if not path.parent.is_dir() or path.parent.is_symlink():
            raise ValueError('Expected existing private runtime layout')
    manifest = {str(path.relative_to(runtime)): sha(data) for path, data in files.items()}
    if check:
        return {'check': True, 'files': manifest, 'started': False}
    if not confirmed:
        raise ValueError('Review the bridge and confirm this installation with --confirm-install')
    backup = runtime/'backups'/('mac-gui-'+uuid.uuid4().hex)
    backup.mkdir(mode=0o700, parents=True)
    (backup/'app.py').write_bytes(before)
    written = []
    try:
        for path, data in files.items():
            fd, temporary = tempfile.mkstemp(prefix='.mac-gui-', dir=path.parent)
            try:
                with os.fdopen(fd, 'wb') as out:
                    out.write(data)
                os.replace(temporary, path)
                written.append(path)
            finally:
                Path(temporary).unlink(missing_ok=True)
    except Exception:
        bridge.write_bytes(before)
        for path in written:
            if path != bridge:
                path.unlink(missing_ok=True)
        raise
    (backup/'manifest.json').write_text(json.dumps({'files':manifest,'before_sha256':expected_sha,'started':False}))
    return {'installed':True,'files':manifest,'started':False}


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime',required=True)
    parser.add_argument('--expected-sha256',required=True)
    parser.add_argument('--check',action='store_true')
    parser.add_argument('--confirm-install',action='store_true')
    args=parser.parse_args()
    print(json.dumps(install(Path(__file__).parent,args.runtime,args.expected_sha256,args.confirm_install,args.check)))
