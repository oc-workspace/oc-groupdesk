import {randomUUID} from 'node:crypto';
import type express from 'express';
import {z} from 'zod';
import {controlPool,audit,pool} from './db.js';
import {accessibleBot} from './user-access.js';
import {botRecord,withBot} from './bot-workspaces.js';
import {requireCondition} from './security.js';

const id=z.uuid();
type Db={query:(sql:string,args?:unknown[])=>Promise<{rows:any[];rowCount:number|null}>};

async function pendingMove(botId:string,db:Db=controlPool as Db){
 return (await db.query(`SELECT d.id,d.created_at,d.completed_at FROM managed_bot_deployment_changes d
  WHERE d.bot_id=$1 AND d.kind='host_move' AND d.state='completed'
  AND NOT EXISTS(SELECT 1 FROM managed_bot_migration_launches l WHERE l.change_id=d.id)
  ORDER BY d.completed_at DESC LIMIT 1`,[botId])).rows[0]||null;
}

export async function activationOptions(botId:string){
 const bot=await botRecord(botId);requireCondition(bot,404,'机器人不存在');
 const move=await pendingMove(botId);
 const groups=move?await withBot(botId,async()=>
  (await pool.query(`SELECT id,name,external_id FROM groups
   WHERE deleted_at IS NULL AND enabled AND external_id IS NOT NULL ORDER BY name,id`)).rows):[];
 const adapters=move?(await controlPool.query('SELECT group_external_ids FROM managed_bot_adapters WHERE bot_id=$1',[botId])).rows:[];
 const allowed=new Set(adapters.flatMap(a=>Array.isArray(a.group_external_ids)?a.group_external_ids:[]));
 return {migration_launch:!!move,change_id:move?.id||null,
  groups:groups.filter(g=>allowed.has(g.external_id)).map(g=>({id:g.id,name:g.name}))};
}

export async function checkedGreetingGroups(botId:string,ids?:string[]){
 const options=await activationOptions(botId);
 if(options.migration_launch)requireCondition(ids!==undefined,400,'请先选择迁移后寒暄群，再确认启用');
 ids??=[];
 requireCondition(new Set(ids).size===ids.length,400,'寒暄群不能重复');
 if(!options.migration_launch){requireCondition(ids.length===0,409,'当前没有待首次启用的迁移');return {changeId:null,externalIds:[]};}
 const valid=new Set(options.groups.map(g=>g.id));
 requireCondition(ids.every(v=>valid.has(v)),409,'寒暄群已变化，请刷新并重新选择');
 const rows=ids.length?await withBot(botId,async()=>
  (await pool.query('SELECT id,external_id FROM groups WHERE id=ANY($1::uuid[])',[ids])).rows):[];
 const mapping=new Map(rows.map(g=>[g.id,g.external_id]));
 return {changeId:options.change_id,externalIds:ids.map(v=>mapping.get(v))};
}

export async function createMigrationLaunch(db:Db,bot:any,selection:{changeId:string|null;externalIds:(string|undefined)[]},actor:string){
 const move=await pendingMove(bot.id,db);
 requireCondition(move?.id===selection.changeId,409,'迁移记录已变化，请刷新');
 if(!move)return;
 requireCondition(selection.externalIds.every(v=>typeof v==='string'&&v.length>0),409,'寒暄群绑定已变化');
 await db.query(`INSERT INTO managed_bot_migration_launches
  (id,change_id,bot_id,greeting_groups,catchup_from,catchup_through)
  VALUES($1,$2,$3,$4,COALESCE($5::timestamptz,$6::timestamptz),now())`,
  [randomUUID(),move.id,bot.id,JSON.stringify(selection.externalIds),bot.pause_requested_at,move.created_at]);
 await audit(actor,'bot.migration_launch_prepared',bot.id,{change_id:move.id,greeting_groups:selection.externalIds.length},db as any);
}

export function registerMigrationLaunch(app:express.Express){
 app.get('/api/bots/:id/activation-options',async(req,res)=>{
  const botId=id.parse(req.params.id);await accessibleBot(req.admin!,botId);
  res.json(await activationOptions(botId));
 });
}
