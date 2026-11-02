"""RSA-wrapped database keys; clear keys never enter files or command lines."""
import base64
import hashlib
import json
import os
from pathlib import Path
from Crypto.Cipher import PKCS1_OAEP
from Crypto.Hash import SHA256
from Crypto.PublicKey import RSA

FORMAT = 'groupdesk-chatlog-key-v1'
LABEL = b'groupdesk-chatlog-reader-key-v1'

def private_write(path, data):
    path = Path(path)
    temporary = path.with_name(path.name + '.tmp')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'wb') as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())
    temporary.chmod(0o600)
    temporary.replace(path)

def initialize(secrets, client):
    secrets, client = Path(secrets), Path(client)
    for folder in (secrets, client):
        folder.mkdir(mode=0o700, parents=True, exist_ok=True)
        folder.chmod(0o700)
    private = secrets / 'vault-private.pem'
    public = secrets / 'vault-public.pem'
    if not private.exists():
        if public.exists():
            raise ValueError('Incomplete vault; refusing to replace public key')
        key = RSA.generate(3072)
        private_write(private, key.export_key())
    key = RSA.import_key(private.read_bytes())
    assert key.has_private() and key.size_in_bits() >= 3072
    expected = key.public_key().export_key()
    if public.exists() and public.read_bytes() != expected:
        raise ValueError('Vault public key mismatch')
    private_write(public, expected)
    token = client / 'api-token'
    if not token.exists():
        import secrets as random
        private_write(token, random.token_hex(32).encode())
    if len(token.read_text().strip()) != 64:
        raise ValueError('Invalid client token')

def wrap(key, account, public):
    if len(key) != 32 or not account:
        raise ValueError('Invalid key envelope')
    rsa = RSA.import_key(Path(public).read_bytes())
    payload = b'CKR1' + hashlib.sha256(account.encode()).digest() + bytes(key)
    encrypted = PKCS1_OAEP.new(rsa.public_key(), hashAlgo=SHA256, label=LABEL).encrypt(payload)
    return json.dumps({'format': FORMAT, 'account': account,
        'ciphertext': base64.b64encode(encrypted).decode(),
        'public_sha256': hashlib.sha256(rsa.public_key().export_key()).hexdigest()},
        sort_keys=True).encode()

def unwrap(envelope, account, private):
    value = json.loads(envelope)
    if value.get('format') != FORMAT or value.get('account') != account:
        raise ValueError('Key account mismatch')
    rsa = RSA.import_key(Path(private).read_bytes())
    expected = hashlib.sha256(rsa.public_key().export_key()).hexdigest()
    if value.get('public_sha256') != expected:
        raise ValueError('Key vault mismatch')
    payload = PKCS1_OAEP.new(rsa, hashAlgo=SHA256, label=LABEL).decrypt(base64.b64decode(value['ciphertext'], validate=True))
    if len(payload) != 68 or payload[:4] != b'CKR1' or payload[4:36] != hashlib.sha256(account.encode()).digest():
        raise ValueError('Invalid wrapped key')
    return payload[36:]
