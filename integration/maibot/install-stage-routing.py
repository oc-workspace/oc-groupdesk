"""Install the dispatch guard in a checked copy of the current Policy module."""
import ast
from pathlib import Path
import sys

path=Path(sys.argv[1])
text=path.read_text()
anchor="                db.execute('INSERT INTO turns"
addition="""                from model_routing import shortcut_allowed
                if not shortcut_allowed(gd.profile(self.cfg,row['chat_id'])):
                    row=dict(row,fast=0,greeting=0)
"""
if addition not in text:
    if text.count(anchor)!=1:raise ValueError('Unknown Policy dispatch baseline')
    text=text.replace(anchor,addition+anchor)
ast.parse(text)
path.write_text(text)
