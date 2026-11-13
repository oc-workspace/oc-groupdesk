"""GroupDesk summary tasks over existing scoped connections; no Mac or Hermes dependency."""
import asyncio,json,time,re,urllib.error
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
    if len(result)>20000 or len(json.dumps(result,ensure_ascii=False,separators=(',',':')))>8000000:raise OverflowError('Source window too large')
    return result

def upload_batches(messages, budget=150000):
    batch=[];size=2
    for message in messages:
        n=len(json.dumps(message,ensure_ascii=False,separators=(',',':')).encode())+1
        if batch and (size+n>budget or len(batch)>=200):
            yield batch;batch=[];size=2
        batch.append(message);size+=n
    if batch:yield batch

async def source_api(path,payload):
    for attempt in range(3):
        try:return await asyncio.to_thread(gd.api,path,payload)
        except OSError as exc:
            if getattr(exc,'code',0) in range(400,500) or attempt==2:raise
            await asyncio.sleep(.5*(attempt+1))

async def source(bridge,chat,job):
    path='/summaries/jobs/'+job['id']+'/source'
    kind='wechat_database' if getattr(bridge.agent,'source_kind',None)=='wechat_database' else 'ui_archive'
    try:
        start,end=aware(job['start']),aware(job['end'])
        if not 0<(end-start).total_seconds()<=31*86400:raise ValueError('Invalid window')
        if kind=='wechat_database' and callable(getattr(bridge.agent,'summary_plan',None)):
            plan=await asyncio.to_thread(bridge.agent.summary_plan,chat,duration_seconds=(end-start).total_seconds(),until=end)
            error=('no_messages' if not plan['count'] else 'too_many_messages' if plan['count']>20000 else
                'too_much_text' if plan['text_chars']>2000000 else 'message_too_long' if plan['max_text_chars']>20000 else None)
            await source_api(path+'-plan',{'token':job['token'],'source_kind':kind,
                'plan':{k:plan[k] for k in ('epoch','through','count','text_chars','max_text_chars','page_limit','planned_batches')}})
            if error:
                await asyncio.to_thread(gd.api,path,{'token':job['token'],'error':error});return
            pages=bridge.agent.summary_pages(chat,plan);ordinal=read_batches=0
            while True:
                page=await asyncio.to_thread(next,pages,None)
                if page is None:break
                read_batches+=1
                for batch in upload_batches(records(page,chat.id,start,end)):
                    await source_api(path+'-batch',{'token':job['token'],'ordinal':ordinal,'read_batches':read_batches,'messages':batch})
                    ordinal+=1
            await source_api(path+'-complete',{'token':job['token'],'batches':ordinal,'read_batches':read_batches})
            bridge.health.pop('summary_error',None)
            return
        messages=await asyncio.to_thread(bridge.agent.get_history,chat,duration_seconds=(end-start).total_seconds(),until=end)
        data=records(messages,chat.id,start,end)
        payload={'token':job['token'],'source_kind':'wechat_database' if getattr(bridge.agent,'source_kind',None)=='wechat_database' else 'ui_archive',**({'messages':data} if data else {'error':'no_messages'})}
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
            state='uncertain';proof=None
            try:
                if not bridge.ledger.reserve(identifier):raise ValueError('Already reserved or uncertain')
                queued=await asyncio.to_thread(bridge.agent.send_text,chat.id,reserved['text'],client_id='groupdesk-'+identifier)
                receipt=await asyncio.to_thread(bridge.agent.wait_delivery,queued,timeout=60)
                state=receipt.delivery_status if receipt.delivery_status in ['sent','failed'] else 'uncertain'
                if state=='sent':
                    reference=getattr(bridge.agent,'confirmed_send_reference',None)
                    try:proof=await asyncio.to_thread(reference,receipt) if callable(reference) else None
                    except Exception:proof=None
                    state='sent' if proof else 'uncertain'
                bridge.ledger.finish(identifier,state,getattr(receipt,'seq',None))
                if state=='sent':bridge.health['verified_sends']+=1
            finally:
                # ACK may be retried; the actual send is never replayed.
                for attempt in range(3):
                    try:
                        await asyncio.to_thread(gd.api,path,{'token':job['token'],'ordinal':ordinal,'action':state,**({'proof':proof} if state=='sent' else {})});break
                    except Exception:
                        if attempt==2:raise
                        await asyncio.sleep(1)
            if state!='sent':return

async def commands(bridge,chat,profile):
    page=getattr(bridge.agent,'summary_command_page',None)
    ack=getattr(bridge.agent,'ack_summary_command',None)
    if not callable(page) or not callable(ack):return
    epoch,rows=await asyncio.to_thread(page,chat.id)
    if not epoch:return
    for row in rows:
        seq=row['seq'];content=row.get('content')
        valid=(row.get('is_self')==0 and row.get('msg_type')==1
            and content in ('/generate-summary','/generate-summary 截止目前')
            and isinstance(row.get('sender_id'),str) and bool(row['sender_id'])
            and re.fullmatch(r'[1-9]\d{0,20}',str(row.get('server_id') or '')))
        if not valid:
            await asyncio.to_thread(ack,chat.id,epoch,seq);continue
        at=float(row.get('source_at') or 0)
        observed=float(row.get('observed_at') or 0)
        # Reader arrival uses this host's clock; WeChat's native timestamp may
        # be ahead of it. Keep the native time for the summary window.
        if not 0<=time.time()-observed<=600 or not 0<=at or abs(at-observed)>180:
            await asyncio.to_thread(ack,chat.id,epoch,seq);continue
        payload={'external_id':profile['external_id'],'epoch':epoch,'seq':seq,
            'server_id':str(row['server_id']),'sender_id':row['sender_id'],
            'sender_name':row.get('sender'),'source_at':datetime.fromtimestamp(at,timezone.utc).isoformat(),
            'text':content}
        try:result=await asyncio.to_thread(gd.api,'/summaries/command',payload)
        except urllib.error.HTTPError as exc:
            if 400<=exc.code<500:
                await asyncio.to_thread(ack,chat.id,epoch,seq);continue
            raise
        if result.get('state')=='already_sent':
            sender=getattr(bridge.agent,'send_native_quote',None)
            verifier=getattr(bridge.agent,'confirmed_native_quote',None)
            if not callable(sender) or not callable(verifier):raise RuntimeError('Native quote sender unavailable')
            identifier='summary-command-quote-'+epoch+'-'+str(seq)
            text='这段时间的群总结已经发过，点开引用可查看第一段。'
            async with bridge.send_lock:
                if not bridge.ledger.reserve(identifier):
                    await asyncio.to_thread(ack,chat.id,epoch,seq);continue
                state='uncertain';receipt=None
                try:
                    queued=await asyncio.to_thread(sender,chat.id,result['server_id'],result['anchor_text'],text,client_id='groupdesk-'+identifier)
                    receipt=await asyncio.to_thread(bridge.agent.wait_delivery,queued,timeout=60)
                    proof=await asyncio.to_thread(verifier,receipt,result['server_id'])
                    if proof:state='sent'
                finally:bridge.ledger.finish(identifier,state,getattr(receipt,'seq',None))
        await asyncio.to_thread(ack,chat.id,epoch,seq)

async def step(bridge):
    if not bridge.control()['enabled']:return
    for chat_id,chat in list(bridge.chats.items()):
        p=gd.profile(bridge.policy.cfg,str(chat_id))
        if not gd.available(p,time.time()):continue
        if bridge.control()['send_enabled']:
            try:await commands(bridge,chat,p)
            except Exception as exc:bridge.health['summary_command_error']=type(exc).__name__
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
