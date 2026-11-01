"""Keep identities for overlapping rendered frames, including equal texts.

Qt bubble IDs are hashes of text/time/visible occurrence, not WeChat IDs.
Only a suffix anchored to the previous frame proves that a following row is
a new arrival. Persist that continuity so profile lookups and restarts reuse
the same IDs. Frames without an anchor retain the legacy reconciliation path.
"""
from dataclasses import replace
from difflib import SequenceMatcher
import hashlib,json,uuid

PREFIX='arrival:'
MAX_EDGES=4096

def signature(message):
    return hashlib.sha256(json.dumps([message.content,message.type.value,message.direction.value],ensure_ascii=True).encode()).hexdigest()

def compatible(left,right):
    return left['sig']==right['sig'] and (not left.get('time') or not right.get('time') or left['time']==right['time'])

def track_frame(store,messages,*,chat):
    if not messages:return messages
    incoming=[{'sig':signature(m),'time':m.timestamp.isoformat() if m.timestamp else None} for m in messages]
    with store._database() as db:
        db.execute('CREATE TABLE IF NOT EXISTS visible_identity_frames(chat TEXT PRIMARY KEY,payload TEXT NOT NULL)')
        row=db.execute('SELECT payload FROM visible_identity_frames WHERE chat=?',(str(chat),)).fetchone()
        previous=json.loads(row['payload']) if row else None
        old=previous['frame'] if previous else []
        edges=previous.get('edges',[]) if previous else []
        edge_keys={(e['before'],e['sig'],e.get('time'),e['id']) for e in edges}
        mapped={};tail_start=None
        # Prefer chronological overlap. A general LCS can mistake the new A
        # in [B,A] for an old A in [A,B], dropping exactly the new arrival.
        for size in range(min(len(old),len(incoming)),0,-1):
            positions=[start for start in range(len(incoming)-size+1) if all(compatible(a,b) for a,b in zip(old[-size:],incoming[start:start+size]))]
            if len(positions)==1:
                start=positions[0]
                mapped.update({start+i:old[len(old)-size+i]['id'] for i in range(size)})
                tail_start=start+size
                break
        if tail_start is None and old:
            matcher=SequenceMatcher(a=[x['sig'] for x in old],b=[x['sig'] for x in incoming],autojunk=False)
            for block in matcher.get_matching_blocks():
                for offset in range(block.size):
                    before,after=old[block.a+offset],incoming[block.b+offset]
                    if compatible(before,after):mapped[block.b+offset]=before['id']
        result=[];frame=[];used=set()
        for index,(message,item) in enumerate(zip(messages,incoming)):
            identifier=mapped.get(index);origin='repeat'
            if identifier is None:
                predecessor=frame[-1]['id'] if frame else None
                known=next((edge for edge in reversed(edges) if predecessor and edge['before']==predecessor and compatible(edge,item) and edge['id'] not in used),None)
                if known:identifier=known['id']
                elif tail_start is not None and index>=tail_start:
                    identifier=PREFIX+uuid.uuid4().hex;origin='tail'
                else:
                    identifier=message.id
                    origin='bootstrap' if previous is None else 'history' if mapped and index<min(mapped) else 'legacy'
            # A visible frame cannot represent two bubbles with one ID.
            if identifier in used:
                identifier=PREFIX+uuid.uuid4().hex;origin='tail' if tail_start is not None and index>=tail_start else 'history'
            used.add(identifier)
            entry={**item,'id':identifier};frame.append(entry)
            if len(frame)>1:
                edge={**entry,'before':frame[-2]['id']}
                key=(edge['before'],edge['sig'],edge.get('time'),edge['id'])
                if key not in edge_keys:edges.append(edge);edge_keys.add(key)
            result.append(replace(message,id=identifier,raw={**message.raw,'capture_origin':origin}))
        payload=json.dumps({'frame':frame,'edges':edges[-MAX_EDGES:]},separators=(',',':'))
        if not row or payload!=row['payload']:
            db.execute('INSERT INTO visible_identity_frames(chat,payload) VALUES(?,?) ON CONFLICT(chat) DO UPDATE SET payload=excluded.payload',(str(chat),payload))
    return result
