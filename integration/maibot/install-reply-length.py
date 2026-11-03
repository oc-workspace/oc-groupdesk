"""Apply length enforcement to checked copies of the currently deployed files."""
from pathlib import Path
import ast
import sys

root=Path(sys.argv[1])
def edit(name,before,after):
    path=root/name;text=path.read_text()
    if after in text:return
    if text.count(before)!=1:raise ValueError('Unknown reply length baseline: '+name)
    text=text.replace(before,after);ast.parse(text);path.write_text(text)

edit('limits/group_guard.py',
     "            latency.bind(p,request,turn['id'],task)\n",
     "            latency.bind(p,request,turn['id'],task)\n            import reply_length\n            reply_length.bind(p,request,turn,task)\n")
edit('bridge/app.py',
     "                limit = 2000 if article else self.policy.cfg['output_chars']\n                if len(text) > limit:\n                    text = text[:limit - 1].rstrip() + '…'\n",
     "                from reply_length import prepare as prepare_reply_length\n                text,reply_limit=prepare_reply_length(self.policy,turn_id,text)\n")
edit('limits/latency.py',
     "    limit=2000 if turn['article'] else p.cfg['output_chars']\n    available=limit-len(prefix)-2\n    if len(text)>available:text=text[:max(0,available-1)].rstrip()+'…'\n",
     "    from reply_length import for_turn,shorten\n    limit,_=for_turn(p.cfg,turn)\n    if len(prefix)>limit-40:\n        prefix={'zh':'抱歉久等了。','ja':'お待たせしました。','ko':'기다리게 해서 미안해요.'}.get(language(text,managed),'Sorry for the wait.')\n    available=limit-len(prefix)-2\n    text=shorten(text,max(0,available))\n")
