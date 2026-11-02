"""Conservative avatar-gutter evidence and persistent, bounded identity repair."""
import time
from collections import Counter
from .models import Rect,Direction


def avatar_direction(snapshot,row,clip):
    # Qt virtual rows may span a wide paragraph. Only inspect two complete
    # avatar slots, outside the bubble body, inside the current viewport.
    if not row or not clip or row.width<180 or row.height<44:return Direction.UNKNOWN
    if abs(row.x-clip.x)>3 or abs(row.width-clip.width)>6:return Direction.UNKNOWN
    left=Rect(row.x+18,row.y+8,36,36);right=Rect(row.right-54,row.y+8,36,36)
    window=snapshot.logical_window
    for r in (left,right):
        if not (clip.x<=r.x and clip.y<=r.y and r.right<=clip.right and r.bottom<=clip.bottom
                and window.x<=r.x and window.y<=r.y and r.right<=window.right and r.bottom<=window.bottom):return Direction.UNKNOWN
    # Background comes from the outside gutters, not white/green bubble fill.
    bands=[snapshot.crop_logical(Rect(row.x,row.y+8,3,36)),snapshot.crop_logical(Rect(row.right-3,row.y+8,3,36))]
    if any(b is None for b in bands):return Direction.UNKNOWN
    values=[tuple(c//8 for c in pixel) for b in bands for pixel in b.convert('RGB').getdata()]
    bg=tuple(c*8+4 for c in Counter(values).most_common(1)[0][0])
    ratios=[]
    for r in (left,right):
        crop=snapshot.crop_logical(r)
        if crop is None:return Direction.UNKNOWN
        pixels=list(crop.convert('RGB').getdata())
        ratios.append(sum(sum((p[c]-bg[c])**2 for c in range(3))>28**2 for p in pixels)/len(pixels))
    if ratios[0]>=.08 and ratios[1]<.025:return Direction.INCOMING
    if ratios[1]>=.08 and ratios[0]<.025:return Direction.OUTGOING
    return Direction.UNKNOWN


def init(store):
    with store._database() as db:
        db.execute('CREATE TABLE IF NOT EXISTS identity_resolution(seq INTEGER PRIMARY KEY,chat_id INTEGER,message_id TEXT,phase TEXT,attempts INTEGER NOT NULL DEFAULT 0,state TEXT,reason TEXT,updated REAL)')


def observe(store,stored):
    phase='unknown_direction' if stored.direction=='unknown' else 'missing_sender'
    resolved=bool(stored.direction=='outgoing' or (stored.direction=='incoming' and stored.sender))
    with store._database() as db:
        old=db.execute('SELECT phase,attempts,state FROM identity_resolution WHERE seq=?',(stored.seq,)).fetchone()
        if resolved:
            if old:db.execute('UPDATE identity_resolution SET state="resolved",reason="verified_identity",updated=? WHERE seq=?',(time.time(),stored.seq))
            return
        # Independent pixel confirmation can restart nickname repair once;
        # plain re-polls and process restarts cannot reset its retry allowance.
        reset=bool(old and old['phase']=='unknown_direction' and phase=='missing_sender')
        if not old:db.execute('INSERT INTO identity_resolution VALUES(?,?,?,?,0,"pending","awaiting_identity",?)',(stored.seq,stored.chat_id,stored.message_id,phase,time.time()))
        elif reset:db.execute('UPDATE identity_resolution SET phase=?,attempts=0,state="pending",reason="direction_confirmed",updated=? WHERE seq=?',(phase,time.time(),stored.seq))
        db.execute('DELETE FROM identity_resolution WHERE seq NOT IN (SELECT seq FROM identity_resolution ORDER BY seq DESC LIMIT 512)')


    return reset if old else False


def ready(store,chat_id,message_id):
    with store._database() as db:
        row=db.execute('SELECT attempts,state FROM identity_resolution WHERE chat_id=? AND message_id=?',(chat_id,message_id)).fetchone()
    return not row or (row['attempts']<3 and row['state']!='resolved')


def attempt(store,chat_id,message_id,reason):
    with store._database() as db:
        db.execute('UPDATE identity_resolution SET attempts=attempts+1,state=CASE WHEN attempts+1>=3 THEN "unresolved" ELSE "pending" END,reason=?,updated=? WHERE chat_id=? AND message_id=?',(reason,time.time(),chat_id,message_id))


def reason(store,chat_id,message_id,value):
    with store._database() as db:db.execute('UPDATE identity_resolution SET reason=?,updated=? WHERE chat_id=? AND message_id=?',(value,time.time(),chat_id,message_id))


def stats(store):
    with store._database() as db:
        rows=db.execute('SELECT state,count(*) n FROM identity_resolution GROUP BY state').fetchall()
    return {r['state']:r['n'] for r in rows}
