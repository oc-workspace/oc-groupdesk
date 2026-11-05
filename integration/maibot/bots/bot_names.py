"""Per-instance literal mention aliases; legacy names only without an override."""
import json,re
from pathlib import Path
import groupdesk_runtime as gd

LEGACY=re.compile(r'(?:g\s*t\s*小\s*跟\s*班|小\s*g\s*t(?![A-Za-z0-9_])|小\s*t(?![A-Za-z0-9_]))',re.I)

def compile_names(names):
    if not isinstance(names,list) or not 1<=len(names)<=12 or any(not isinstance(n,str) or not n.strip() or len(n)>80 for n in names):raise ValueError('Invalid bot mention names')
    terms=[]
    for n in names:
        n=n.strip();terms.append((r'(?<![A-Za-z0-9_])' if n[0].isascii() and n[0].isalnum() else '')+re.escape(n)+(r'(?![A-Za-z0-9_])' if n[-1].isascii() and n[-1].isalnum() else ''))
    return re.compile('|'.join(sorted(terms,key=len,reverse=True)),re.I)

class Names:
    def pattern(self):
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
