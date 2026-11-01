"""Install only checked bridge hooks in an isolated copy; reject unknown baselines."""
from pathlib import Path
import ast,hashlib,sys
path=Path(sys.argv[1]);source=path.read_text()
edits=[
 ('import groupdesk_runtime as gd','import groupdesk_runtime as gd\nfrom interactions_runtime import init as init_interactions, consider as consider_interaction, run as run_interactions'),
 ('        self.ledger = Ledger(self.state_dir / \'delivery.sqlite3\')','        self.ledger = Ledger(self.state_dir / \'delivery.sqlite3\')\n        init_interactions(self.ledger)'),
 ('                        timestamp = source_timestamp(message)\n                        self.policy.ingest(','''                        timestamp = source_timestamp(message)
                        if consider_interaction(self,message,timestamp):
                            self.ledger.mark(message.seq)
                            await asyncio.to_thread(self.agent.ack,delivery)
                            self.health['last_inbound_seq']=message.seq
                            continue
                        self.policy.ingest('''),
 ('await asyncio.gather(self.router.run(), self.receive_loop(), self.dispatch_loop(), self.groupdesk_loop())','await asyncio.gather(self.router.run(), self.receive_loop(), self.dispatch_loop(), self.groupdesk_loop(), run_interactions(self))')
]
already=all(after in source for _,after in edits)
if not already and len(sys.argv)>2 and hashlib.sha256(source.encode()).hexdigest()!=sys.argv[2]:raise ValueError('Bridge source digest mismatch')
for before,after in edits:
    if after in source:continue
    if source.count(before)!=1:raise ValueError('Unexpected bridge baseline')
    source=source.replace(before,after,1)
ast.parse(source);path.write_text(source)
