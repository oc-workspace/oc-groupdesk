"""Per-instance literal mention aliases; legacy names only without an override."""
import json,re,inspect
from contextvars import ContextVar
from functools import wraps
from pathlib import Path
import groupdesk_runtime as gd

_scoped=ContextVar('group_bot_mention_names',default=None)

LEGACY=re.compile(r'(?:g\s*t\s*小\s*跟\s*班|小\s*g\s*t(?![A-Za-z0-9_])|小\s*t(?![A-Za-z0-9_]))',re.I)

def compile_names(names):
    if not isinstance(names,list) or not 0<=len(names)<=12 or any(not isinstance(n,str) or not n.strip() or len(n)>80 for n in names):raise ValueError('Invalid bot mention names')
    if not names:return re.compile(r'(?!)')
    terms=[]
    for n in names:
        n=n.strip();terms.append((r'(?<![A-Za-z0-9_])' if n[0].isascii() and n[0].isalnum() else '')+re.escape(n)+(r'(?![A-Za-z0-9_])' if n[-1].isascii() and n[-1].isalnum() else ''))
    return re.compile('|'.join(sorted(terms,key=len,reverse=True)),re.I)

class Names:
    def pattern(self):
        scoped=_scoped.get()
        if scoped is not None:return compile_names(scoped)
        path=gd.CONNECTION.with_name('mention-names.json')
        try:value=json.loads(path.read_text())
        except FileNotFoundError:
            # New robot instances must opt into their own names, never inherit GT.
            try:bot=json.loads(gd.CONNECTION.read_text()).get('bot_id')
            except FileNotFoundError:bot=None
            if bot and bot!='00000000-0000-4000-8000-000000000001':return re.compile(r'(?!)')
            return LEGACY
        return compile_names(value)
    def search(self,text):return self.pattern().search(text)
    def sub(self,repl,text,*args,**kwargs):return self.pattern().sub(repl,text,*args,**kwargs)
NAME=Names()


def group_names(config,chat):
    profile=gd.profile(config,chat)
    if profile and profile.get('bot_identity_contract_version')==1:
        from bot_identity import validate_bundle
        return validate_bundle(profile)['mention_names']
    return None

def addressed(config,chat,text):
    names=group_names(config,chat)
    return bool((compile_names(names) if names is not None else NAME.pattern()).search(str(text)))

def scoped_names(function):
    """Scope all classification helpers in one real Policy.ingest call, reset even on error."""
    signature=inspect.signature(function)
    @wraps(function)
    def wrapped(self,*args,**kwargs):
        arguments=signature.bind(self,*args,**kwargs);arguments.apply_defaults()
        token=_scoped.set(group_names(self.cfg,arguments.arguments.get('chat_id','')))
        try:return function(self,*args,**kwargs)
        finally:_scoped.reset(token)
    return wrapped
