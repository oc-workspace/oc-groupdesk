"""Keep identities for overlapping rendered frames, including equal texts.

Qt bubble IDs are hashes of text/time/visible occurrence, not WeChat IDs.
A suffix anchored to the previous frame proves an appended row. Changed
isolated observations get separate identities too; an ephemeral avatar hint
separates equal short bubbles. Persist continuity through profile lookups and
restarts. Explicit older frames and initial history do not trigger actions.
"""
from dataclasses import replace
from difflib import SequenceMatcher
import hashlib,json,uuid

PREFIX='arrival:'
OBSERVATION_PREFIX='appearance:'
MAX_EDGES=4096

def signature(message):
    return hashlib.sha256(json.dumps([message.content,message.type.value,message.direction.value],ensure_ascii=True).encode()).hexdigest()

def compatible(left,right):
    return left['sig']==right['sig'] and (not left.get('time') or not right.get('time') or left['time']==right['time']) and (not left.get('avatar') or not right.get('avatar') or left['avatar']==right['avatar'])

def avatar_hint(messages,snapshot,clip):
    """An ephemeral cache discriminator, never an account/member identifier."""
    from .models import Direction,MessageType,Rect
    if not messages:return messages
    message=messages[-1];row=message.bounds
    if not row or message.type is not MessageType.TEXT or len(message.content)>32:return messages
    direction=message.direction if message.direction is not Direction.UNKNOWN else snapshot.classify(row)
    if direction not in {Direction.INCOMING,Direction.OUTGOING}:return messages
    offset=min(36,max(24,row.width//18))
    x=row.x+offset if direction is Direction.INCOMING else row.right-offset
    y=row.y+min(26,max(18,row.height//3));rect=Rect(x-10,y-10,20,20)
    if clip and not (clip.x<=rect.x and clip.y<=rect.y and rect.right<=clip.right and rect.bottom<=clip.bottom):return messages
    crop=snapshot.crop_logical(rect)
    if crop is None:return messages
    pixels=crop.convert('RGB').resize((8,8)).tobytes()
    hint=hashlib.sha256(bytes(value//16 for value in pixels)).hexdigest()
    return [*messages[:-1],replace(message,raw={**message.raw,'avatar_hint':hint})]

def track_frame(store,messages,*,chat):
    if not messages:return messages
    incoming=[{'sig':signature(m),'time':m.timestamp.isoformat() if m.timestamp else None,'avatar':m.raw.get('avatar_hint')} for m in messages]
    with store._database() as db:
        db.execute('CREATE TABLE IF NOT EXISTS visible_identity_frames(chat TEXT PRIMARY KEY,payload TEXT NOT NULL)')
        row=db.execute('SELECT payload FROM visible_identity_frames WHERE chat=?',(str(chat),)).fetchone()
        previous=json.loads(row['payload']) if row else None
        old=previous['frame'] if previous else []
        explicit=previous.get('explicit_frames',{}) if previous else {}
        explicit_key=hashlib.sha256(json.dumps(incoming,sort_keys=True).encode()).hexdigest() if any(x['time'] for x in incoming) else None
        old_times=[x['time'] for x in old if x.get('time')]
        new_times=[x['time'] for x in incoming if x.get('time')]
        backwards=bool(old_times and new_times and max(new_times)<max(old_times))
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
        if not mapped and explicit_key in explicit:
            known_frame=explicit[explicit_key]
            if len(known_frame)==len(incoming):mapped.update(enumerate(known_frame))
        isolated_transition=bool(previous and not mapped and not backwards)
        result=[];frame=[];used=set()
        for index,(message,item) in enumerate(zip(messages,incoming)):
            identifier=mapped.get(index);origin='repeat'
            if identifier is None:
                predecessor=frame[-1]['id'] if frame else None
                known=next((edge for edge in reversed(edges) if predecessor and edge['before']==predecessor and compatible(edge,item) and edge['id'] not in used),None)
                if known:identifier=known['id']
                elif tail_start is not None and index>=tail_start:
                    identifier=PREFIX+uuid.uuid4().hex;origin='tail'
                elif isolated_transition:
                    # A one-bubble viewport has no overlap when its text
                    # changes. Isolate this observation from older equal text;
                    # each changed observation gets its own cache identity.
                    identifier=OBSERVATION_PREFIX+uuid.uuid4().hex;origin='observation'
                else:
                    identifier=message.id
                    origin='bootstrap' if previous is None else 'history' if backwards or (mapped and index<min(mapped)) else 'legacy'
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
        if explicit_key:explicit[explicit_key]=[x['id'] for x in frame]
        explicit=dict(list(explicit.items())[-64:])
        payload=json.dumps({'frame':frame,'edges':edges[-MAX_EDGES:],'explicit_frames':explicit},separators=(',',':'))
        if not row or payload!=row['payload']:
            db.execute('INSERT INTO visible_identity_frames(chat,payload) VALUES(?,?) ON CONFLICT(chat) DO UPDATE SET payload=excluded.payload',(str(chat),payload))
    return result
