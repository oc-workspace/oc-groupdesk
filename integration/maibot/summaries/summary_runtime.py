"""GroupDesk summary tasks over existing scoped connections; no Mac or Hermes dependency."""
import asyncio,json,time
from datetime import datetime,timezone
import groupdesk_runtime as gd

def aware(value):
    if isinstance(value,str):value=datetime.fromisoformat(value.replace('Z','+00:00'))
    if not isinstance(value,datetime) or value.tzinfo is None:raise ValueError('Missing aware source time')
    return value.astimezone(timezone.utc)

def records(messages,chat_id,start,end):
    result=[];seen=set()
    for m in messages:
        if int(m.chat_id)!=int(chat_id):raise ValueError('Cross-group source')
        if str(getattr(m,'client_id','') or '').startswith('groupdesk-summary-'):continue
        if m.direction=='outgoing' and getattr(m,'delivery_status',None)!='sent':continue
        original=getattr(m,'timestamp',None)
        try:at=aware(original);kind='original'
        except (ValueError,TypeError):at=aware(m.observed_at);kind='capture'
        if not start<=at<end or m.seq in seen:continue
        seen.add(m.seq);text=str(m.content or '')
        if len(text)>20000:raise OverflowError('Source message too large')
        result.append({'seq':int(m.seq),'sender':str(m.sender)[:500] if m.sender else None,'text':text,'at':at.isoformat(),'time_kind':kind})
    result.sort(key=lambda m:(m['at'],m['seq']))
    if len(result)>5000 or len(json.dumps(result,ensure_ascii=False,separators=(',',':')))>110000:raise OverflowError('Source window too large')
    return result

async def source(bridge,chat,job):
    path='/summaries/jobs/'+job['id']+'/source'
    try:
        start,end=aware(job['start']),aware(job['end'])
        if not 0<(end-start).total_seconds()<=31*86400:raise ValueError('Invalid window')
        messages=await asyncio.to_thread(bridge.agent.get_history,chat,duration_seconds=(end-start).total_seconds(),until=end)
        data=records(messages,chat.id,start,end)
        payload={'token':job['token'],**({'messages':data} if data else {'error':'no_messages'})}
    except OverflowError:payload={'token':job['token'],'error':'too_large'}
    except Exception:payload={'token':job['token'],'error':'source_unavailable'}
    try:await asyncio.to_thread(gd.api,path,payload)
    except Exception as exc:bridge.health['summary_error']=type(exc).__name__

async def deliver(bridge,chat,job):
    async with bridge.send_lock:
        for part in job['parts']:
            ordinal=part['ordinal'];identifier='summary-'+job['id']+'-'+str(ordinal);path='/summaries/jobs/'+job['id']+'/part'
            p=gd.profile(bridge.policy.cfg,str(chat.id))
            if not bridge.control()['enabled'] or not bridge.control()['send_enabled'] or not gd.available(p,time.time()):return
            if p['external_id']!=job['external_id'] or p['revision']!=job['group_revision'] or not await asyncio.to_thread(gd.check_remote_revision,p):return
            if not isinstance(part['body'],str) or not 1<=len(part['body'])<=2000 or not gd.language_allowed(p,part['body']):return
            reserved=await asyncio.to_thread(gd.api,path,{'token':job['token'],'ordinal':ordinal,'action':'reserve'})
            if not reserved.get('send'):return
            state='uncertain'
            try:
                if not bridge.ledger.reserve(identifier):raise ValueError('Already reserved or uncertain')
                queued=await asyncio.to_thread(bridge.agent.send_text,chat.id,reserved['text'],client_id='groupdesk-'+identifier)
                receipt=await asyncio.to_thread(bridge.agent.wait_delivery,queued,timeout=60)
                state=receipt.delivery_status if receipt.delivery_status in ['sent','failed'] else 'uncertain'
                bridge.ledger.finish(identifier,state,getattr(receipt,'seq',None))
                if state=='sent':bridge.health['verified_sends']+=1
            finally:
                # ACK may be retried; the actual send is never replayed.
                for attempt in range(3):
                    try:
                        await asyncio.to_thread(gd.api,path,{'token':job['token'],'ordinal':ordinal,'action':state});break
                    except Exception:
                        if attempt==2:raise
                        await asyncio.sleep(1)
            if state!='sent':return

async def step(bridge):
    if not bridge.control()['enabled']:return
    for chat_id,chat in list(bridge.chats.items()):
        p=gd.profile(bridge.policy.cfg,str(chat_id))
        if not gd.available(p,time.time()):continue
        result=await asyncio.to_thread(gd.api,'/summaries/claim',{'external_id':p['external_id'],'kind':'source'})
        if result.get('job'):await source(bridge,chat,result['job'])
        if bridge.control()['send_enabled']:
            result=await asyncio.to_thread(gd.api,'/summaries/claim',{'external_id':p['external_id'],'kind':'delivery'})
            if result.get('job'):await deliver(bridge,chat,result['job'])

async def run(bridge):
    while True:
        try:await step(bridge)
        except Exception as exc:bridge.health['summary_error']=type(exc).__name__
        await asyncio.sleep(5)
