"""Patch only the reviewed Policy.ingest name scope. Caller must supply expected source hash."""
import ast,hashlib,sys
from pathlib import Path

def patched(source):
    if 'from bot_names import NAME, scoped_names' in source and '    @scoped_names\n    def ingest(' in source:return source
    tree=ast.parse(source);classes=[n for n in tree.body if isinstance(n,ast.ClassDef) and n.name=='Policy']
    if len(classes)!=1:raise ValueError('Missing policy class')
    ingests=[n for n in classes[0].body if isinstance(n,ast.FunctionDef) and n.name=='ingest']
    if len(ingests)!=1 or [n.arg for n in ingests[0].args.args]!=['self','seq','sender','text','timestamp','at_me','chat_id'] or ingests[0].decorator_list:raise ValueError('Unknown ingest signature')
    # Legacy paused instance used one inline NAME assignment. Its entire source
    # hash is still pinned by the operator before accepting this exact AST form.
    if 'from bot_names import NAME\n' not in source:
        assignments=[n for n in tree.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='NAME' for t in n.targets)]
        if len(assignments)!=1 or assignments[0].lineno!=assignments[0].end_lineno:raise ValueError('Unknown legacy name assignment')
        n=assignments[0]
        if not isinstance(n.value,ast.Call) or not isinstance(n.value.func,ast.Attribute) or not isinstance(n.value.func.value,ast.Name) or n.value.func.value.id!='re' or n.value.func.attr!='compile':raise ValueError('Unknown legacy name expression')
        lines=source.splitlines(keepends=True);lines[n.lineno-1]='from bot_names import NAME\n';source=''.join(lines)
    if source.count('from bot_names import NAME\n')!=1 or source.count('    def ingest(')!=1:raise ValueError('Unknown policy import')
    result=source.replace('from bot_names import NAME\n','from bot_names import NAME, scoped_names\n').replace('    def ingest(','    @scoped_names\n    def ingest(')
    ast.parse(result);return result

if __name__=='__main__':
    path=Path(sys.argv[1]);source=path.read_text()
    if hashlib.sha256(source.encode()).hexdigest()!=sys.argv[2]:raise SystemExit('Policy source changed; review required')
    result=patched(source);temp=path.with_suffix('.identity.tmp');temp.write_text(result);temp.chmod(path.stat().st_mode);temp.replace(path)
    print(hashlib.sha256(result.encode()).hexdigest())
