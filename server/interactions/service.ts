import {randomInt,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {transaction,audit} from '../db.js';
import {digest,requireCondition} from '../security.js';
import {interactionCommand,normalizeInteractionText} from '../../shared/interactions.js';
import {groupForInteraction,interactionSettings,interactionBindings,interactionPrizes,interactionDay,interactionLocale,type Db} from './config.js';
import {interactionTemplate} from './templates.js';
import {baseTemplate,renderInteraction,type Outcome} from './copy.js';

export const interactionEventSchema=z.object({external_id:z.string().min(1).max(200),revision:z.number().int().positive(),binding_id:z.uuid(),source_id:z.string().regex(/^[A-Za-z0-9:_\-.]{1,200}$/),actor:z.object({id:z.string().min(1).max(200),name:z.string().trim().min(1).max(80),kind:z.enum(['group_nickname','stable'])}).strict(),text:z.string().min(1).max(500),source_at:z.number().finite().positive(),mentioned:z.boolean()}).strict();
export type InteractionEventInput=z.infer<typeof interactionEventSchema>;
export type RuntimeAccess={adapterHash:string;groups?:string[]};
function allowed(access:RuntimeAccess,external:string){requireCondition(!access.groups||access.groups.includes(external),403,'适配器未授权此群');}
async function existingEvent(id:string,access:RuntimeAccess,db:Db,lock=false){
 const row=(await db.query('SELECT e.*,g.external_id,g.enabled,g.revision current_revision FROM interaction_events e JOIN groups g ON g.id=e.group_id WHERE e.id=$1'+(lock?' FOR UPDATE OF e,g':''),[id])).rows[0];
 requireCondition(row,404,'互动记录不存在');allowed(access,row.external_id);requireCondition(row.adapter_hash===access.adapterHash,403,'互动记录不属于此适配器');return row;
}
export async function executeInteraction(input:InteractionEventInput,access:RuntimeAccess,now=Date.now(),random=(min:number,max:number)=>randomInt(min,max)){
 const body=interactionEventSchema.parse(input);allowed(access,body.external_id);
 return transaction(async db=>{
  const found=(await db.query('SELECT id FROM groups WHERE external_id=$1',[body.external_id])).rows[0];requireCondition(found,404,'群未绑定');
  const group=await groupForInteraction(found.id,db,true),settings=await interactionSettings(group.id,db);
  const actorKey=digest(group.id+'|'+body.actor.kind+'|'+body.actor.id),requestHash=digest(JSON.stringify([actorKey,body.binding_id,normalizeInteractionText(body.text)]));
  const previous=(await db.query('SELECT * FROM interaction_events WHERE group_id=$1 AND source_id=$2',[group.id,body.source_id])).rows[0];
  if(previous){requireCondition(previous.adapter_hash===access.adapterHash&&previous.request_hash===requestHash,409,'同一消息标识的内容或发送者不一致');return {handled:true,event_id:previous.id,outcome:previous.outcome,duplicate:true};}
  requireCondition(group.enabled&&group.revision===body.revision,409,'群配置已变化，请重新同步');
  requireCondition(body.source_at*1000<=now+15000&&body.source_at*1000>=now-90000,400,'只处理新采集的群消息');
  const binding=(await interactionBindings(group.id,db)).find(b=>b.id===body.binding_id&&b.config.enabled&&!b.archived);requireCondition(binding,409,'互动已停用或配置已变化');
  const command=interactionCommand(body.text,binding.commands,settings.bot_aliases,body.mentioned,binding.config.require_mention);if(!command)return {handled:false};
  const day=interactionDay(body.source_at*1000,settings.timezone),usageDay=interactionDay(now,settings.timezone);
  const recent=(await db.query("SELECT 1 FROM interaction_events WHERE group_id=$1 AND actor_key=$2 AND created_at>to_timestamp($3)-$4*interval '1 second'",[group.id,actorKey,now/1000,settings.member_cooldown_seconds])).rowCount;
  const burst=(await db.query("SELECT count(*)::int count FROM interaction_events WHERE group_id=$1 AND created_at>to_timestamp($2)-interval '1 minute'",[group.id,now/1000])).rows[0].count;
  if(recent||burst>=settings.minute_reply_limit)return {handled:true,suppressed:'cooldown'};
  await db.query('INSERT INTO interaction_daily_usage(group_id,day_key) VALUES($1,$2) ON CONFLICT DO NOTHING',[group.id,usageDay]);
  const quota=await db.query('UPDATE interaction_daily_usage SET replies=replies+1 WHERE group_id=$1 AND day_key=$2 AND replies<$3 RETURNING replies',[group.id,usageDay,settings.daily_reply_limit]);
  if(!quota.rowCount)return {handled:true,suppressed:'daily_limit'};
  await db.query('INSERT INTO interaction_wallets(group_id,actor_key,display_name,identity_kind) VALUES($1,$2,$3,$4) ON CONFLICT(group_id,actor_key) DO UPDATE SET display_name=excluded.display_name,updated_at=now()',[group.id,actorKey,body.actor.name,body.actor.kind]);
  let wallet=(await db.query('SELECT * FROM interaction_wallets WHERE group_id=$1 AND actor_key=$2 FOR UPDATE',[group.id,actorKey])).rows[0];
  const id=randomUUID(),locale=interactionLocale(group,command.locale,binding.config.language_mode),expires=body.source_at+group.policy.timeouts.direct_ttl_seconds;
  await db.query("INSERT INTO interaction_events(id,group_id,binding_id,source_id,request_hash,adapter_hash,actor_key,source_at,group_revision,locale,outcome,data,response,expires_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,to_timestamp($8),$9,$10,'pending','{}','',to_timestamp($11),to_timestamp($12))",[id,group.id,binding.id,body.source_id,requestHash,access.adapterHash,actorKey,body.source_at,group.revision,locale,expires,now/1000]);
  let outcome:Outcome='custom_reply',values:Record<string,string|number>={};
  const set=binding.commands[command.locale],catalogCommand=set.catalog[0]||'prizes',redeemCommand=set.redeem[0]||'redeem';
  if(binding.kind==='daily_checkin'){
   if(command.action==='checkin'){
    await db.query('INSERT INTO interaction_daily_checkins(group_id,actor_key,day_key) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[group.id,actorKey,day]);
    const claim=await db.query('UPDATE interaction_daily_checkins SET count=count+1 WHERE group_id=$1 AND actor_key=$2 AND day_key=$3 AND count<$4 RETURNING count',[group.id,actorKey,day,settings.daily_checkin_limit]);
    if(claim.rowCount){
     const amount=random(binding.config.reward_min,binding.config.reward_max+1);requireCondition(Number.isInteger(amount)&&amount>=binding.config.reward_min&&amount<=binding.config.reward_max,500,'随机奖励生成失败');
     requireCondition(wallet.balance+amount<=1000000000,409,'积分余额已达上限，请联系管理员');
     wallet=(await db.query('UPDATE interaction_wallets SET balance=balance+$3,updated_at=now() WHERE group_id=$1 AND actor_key=$2 RETURNING *',[group.id,actorKey,amount])).rows[0];
     await db.query("INSERT INTO interaction_ledger(group_id,actor_key,event_id,delta,reason,actor) VALUES($1,$2,$3,$4,'checkin','bot')",[group.id,actorKey,id,amount]);outcome='checked_in';values={amount,balance:wallet.balance};
    }else{outcome='already_today';values={balance:wallet.balance};}
   }else if(command.action==='balance'){outcome='balance';values={balance:wallet.balance,available:wallet.balance-wallet.reserved};}
   else if(command.action==='catalog'){
    const prizes=(await interactionPrizes(group.id,db)).filter(p=>p.enabled);
    if(!prizes.length)outcome='catalog_empty';
    else{outcome='catalog';values={list:prizes.map((p,i)=>`${i+1}. ${p.name} · ${p.cost} token · ${p.code}${p.stock===0?' ⛔':''}`).join('\n'),command:redeemCommand+' '+prizes[0].code};}
   }else{
    const prize=(await db.query('SELECT * FROM interaction_prizes WHERE group_id=$1 AND code=$2 AND enabled=true FOR UPDATE',[group.id,command.prize_code])).rows[0];
    if(!prize){
     const any=(await db.query('SELECT 1 FROM interaction_prizes WHERE group_id=$1 AND enabled=true LIMIT 1',[group.id])).rowCount;
     outcome=any?'prize_missing':'catalog_empty';values=any?{catalog_command:catalogCommand}:{};
    }
    else if(prize.stock!==null&&prize.stock<1){outcome='out_of_stock';values={catalog_command:catalogCommand};}
    else if(wallet.balance-wallet.reserved<prize.cost){outcome='insufficient';values={cost:prize.cost,available:wallet.balance-wallet.reserved};}
    else{
     const orderId=randomUUID(),code='RX-'+orderId.replace(/-/g,'').toUpperCase().slice(0,16);
     await db.query('UPDATE interaction_wallets SET reserved=reserved+$3,updated_at=now() WHERE group_id=$1 AND actor_key=$2',[group.id,actorKey,prize.cost]);
     if(prize.stock!==null)await db.query('UPDATE interaction_prizes SET stock=stock-1 WHERE id=$1',[prize.id]);
     await db.query('INSERT INTO interaction_redemptions(id,event_id,group_id,actor_key,prize_id,prize_name,prize_code,cost,stock_reserved,request_code) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[orderId,id,group.id,actorKey,prize.id,prize.name,prize.code,prize.cost,prize.stock!==null,code]);
     await db.query("INSERT INTO interaction_ledger(group_id,actor_key,event_id,redemption_id,delta,reason,actor) VALUES($1,$2,$3,$4,0,'redemption_hold','bot')",[group.id,actorKey,id,orderId]);
     outcome='redemption_pending';values={prize:prize.name,cost:prize.cost,request_code:code,available:wallet.balance-wallet.reserved-prize.cost};
    }
   }
  }
  const template=await interactionTemplate(group,binding,locale,outcome,db),response=renderInteraction(template,values);
  requireCondition(response.length<=1800,400,'互动回复过长，请减少奖品或缩短名称');
  await db.query('UPDATE interaction_events SET outcome=$2,data=$3,response=$4 WHERE id=$1',[id,outcome,values,response]);
  return {handled:true,event_id:id,outcome,duplicate:false};
 });
}
export async function reserveInteraction(id:string,revision:number,access:RuntimeAccess,now=Date.now()){
 return transaction(async db=>{
  const row=await existingEvent(id,access,db,true);
  requireCondition(row.enabled&&row.current_revision===revision&&row.group_revision===revision,409,'群配置已变化，停止发送旧回复');
  if(row.delivery_status!=='waiting')return {send:false,status:row.delivery_status};
  requireCondition(new Date(row.expires_at).getTime()>now,409,'互动回复已过期');
  const group=await groupForInteraction(row.group_id,db);
  let text=row.response;
  if(now-new Date(row.source_at).getTime()>group.policy.timeouts.wait_apology_seconds*1000)text=baseTemplate(row.locale,'waiting_apology')+'\n\n'+text;
  requireCondition(text.length<=2000,409,'互动回复过长');
  await db.query("UPDATE interaction_events SET delivery_status='reserved' WHERE id=$1",[id]);return {send:true,text,event_id:id};
 });
}
export async function reportInteractionDelivery(id:string,status:'sent'|'uncertain'|'failed',access:RuntimeAccess){
 return transaction(async db=>{
  const row=await existingEvent(id,access,db,true);
  requireCondition(row.delivery_status==='reserved'||row.delivery_status===status||(row.delivery_status==='waiting'&&status!=='sent'),409,'互动尚未预留发送或状态不一致');
  await db.query('UPDATE interaction_events SET delivery_status=$2,delivered_at=coalesce(delivered_at,now()) WHERE id=$1',[id,status]);return {ok:true};
 });
}
export async function reviewRedemption(id:string,action:'approve'|'fulfill'|'reject'|'cancel',note:string,actor:string){
 return transaction(async db=>{
  const found=(await db.query('SELECT group_id FROM interaction_redemptions WHERE id=$1',[id])).rows[0];requireCondition(found,404,'兑换申请不存在');
  await groupForInteraction(found.group_id,db,true);
  const order=(await db.query('SELECT * FROM interaction_redemptions WHERE id=$1 FOR UPDATE',[id])).rows[0];
  const target={approve:'approved',fulfill:'fulfilled',reject:'rejected',cancel:'cancelled'}[action];if(order.status===target)return {ok:true,status:target,unchanged:true};
  requireCondition(action==='approve'?order.status==='pending':action==='fulfill'?order.status==='approved':action==='reject'?order.status==='pending':['pending','approved'].includes(order.status),409,'当前兑换状态不能执行此操作');
  const prize=(await db.query('SELECT * FROM interaction_prizes WHERE id=$1 FOR UPDATE',[order.prize_id])).rows[0];
  const wallet=(await db.query('SELECT * FROM interaction_wallets WHERE group_id=$1 AND actor_key=$2 FOR UPDATE',[order.group_id,order.actor_key])).rows[0];
  let delta=0,reason='redemption_fulfilled';
  if(action==='approve'){
   requireCondition(wallet.reserved>=order.cost&&wallet.balance>=order.cost,409,'预留积分不足');delta=-order.cost;reason='redemption_debit';
   await db.query('UPDATE interaction_wallets SET balance=balance-$3,reserved=reserved-$3,updated_at=now() WHERE group_id=$1 AND actor_key=$2',[order.group_id,order.actor_key,order.cost]);
  }else if(action==='reject'||action==='cancel'){
   if(order.status==='pending'){requireCondition(wallet.reserved>=order.cost,409,'预留积分不足');await db.query('UPDATE interaction_wallets SET reserved=reserved-$3,updated_at=now() WHERE group_id=$1 AND actor_key=$2',[order.group_id,order.actor_key,order.cost]);}
   else{requireCondition(wallet.balance+order.cost<=1000000000,409,'退款会超出积分上限，请先调整余额');delta=order.cost;await db.query('UPDATE interaction_wallets SET balance=balance+$3,updated_at=now() WHERE group_id=$1 AND actor_key=$2',[order.group_id,order.actor_key,order.cost]);}
   if(order.stock_reserved&&prize.stock!==null)await db.query('UPDATE interaction_prizes SET stock=stock+1 WHERE id=$1',[prize.id]);reason=delta?'redemption_refund':'redemption_release';
  }
  await db.query('INSERT INTO interaction_ledger(group_id,actor_key,redemption_id,delta,reason,actor,idempotency_key) VALUES($1,$2,$3,$4,$5,$6,$7)',[order.group_id,order.actor_key,id,delta,reason,actor,'redemption:'+id+':'+action]);
  await db.query('UPDATE interaction_redemptions SET status=$2,review_note=$3,updated_at=now() WHERE id=$1',[id,target,note]);
  await audit(actor,'interaction.redemption_reviewed',id,{action,cost:order.cost},db);return {ok:true,status:target};
 });
}
