"""Apply narrow, digest-checked hooks; safe to repeat on a staged SDK tree."""
from pathlib import Path
import ast,hashlib,json,shutil,sys
root=Path(sys.argv[1]);manifest=json.loads(Path(sys.argv[2]).read_text())
patches={
 'client.py':[(
  '            messages = self.parser.parse_list(message_list, chat=active_chat, chat_type=active_type)',
  '            messages = self.parser.parse_list(message_list, chat=active_chat, chat_type=active_type)\n            tracker=getattr(self,"visible_identity_tracker",None)\n            if tracker is not None:messages=tracker(messages,chat=active_chat)')],
 'service.py':[(
  '                        client = self._client_factory()\n                        client.connect()',
  '                        client = self._client_factory()\n                        from .frame_identity import track_frame\n                        client.visible_identity_tracker=lambda messages,**kwargs:track_frame(self.store,messages,**kwargs)\n                        client.connect()')],
 'store.py':[
  ("WHERE chat_id = ? AND message_id LIKE 'local:%'\n                      AND direction = 'outgoing' AND content = ? AND observed_at >= ?", "WHERE chat_id = ? AND (message_id LIKE 'local:%' OR (client_id IS NOT NULL AND message_id NOT LIKE 'arrival:%'))\n                      AND direction = 'outgoing' AND content = ? AND observed_at >= ?"),
  ('            if existing is None:\n                # Sender enrichment', '            if existing is None and not message.id.startswith("arrival:"):\n                # Sender enrichment'),
  ('            if existing is None:\n                # Qt can virtualize', '            if existing is None and not message.id.startswith("arrival:"):\n                # Qt can virtualize'),
  ('            message_at = timestamp or (observed_at if created else None)', '            if created and message.raw.get("capture_origin") in {"bootstrap","history"} and message.direction is Direction.INCOMING:\n                db.execute("UPDATE messages SET delivery_status=\'historical\' WHERE seq=?",(seq,))\n            message_at = timestamp or (observed_at if created else None)'),
  ('            message.direction is not Direction.INCOMING\n            or message.timestamp is not None', '            message.direction is not Direction.INCOMING\n            or message.id.startswith("arrival:")\n            or message.timestamp is not None')]
}
for name,edits in patches.items():
 p=root/'src/bowxt'/name;text=p.read_text()
 if not all(after in text for _,after in edits):
  if hashlib.sha256(p.read_bytes()).hexdigest()!=manifest[name]:raise ValueError('SDK baseline differs: '+name)
 for before,after in edits:
  if after in text:continue
  if text.count(before)!=1:raise ValueError('Unexpected SDK anchor: '+name)
  text=text.replace(before,after,1)
 ast.parse(text);p.write_text(text)
shutil.copy2(Path(__file__).with_name('frame_identity.py'),root/'src/bowxt/frame_identity.py')
