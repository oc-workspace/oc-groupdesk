import {randomUUID} from 'node:crypto';
import type {Db} from './core.js';
import {sourceStats} from './source-stats.js';

export const SOURCE_CACHE_DAYS=7;
export const READER_ORIGIN='wechat-database-chatlog-keeper';
type CacheMessage={seq:number;sender:string|null;text:string;at:string;time_kind:'original'|'capture'};
type CacheJob={group_id:string;external_id:string;window_start:string|Date;window_end:string|Date;id?:string};

export function sliceCachedMessages(messages:CacheMessage[],start:string|Date,end:string|Date){
 const from=new Date(start).getTime(),until=new Date(end).getTime();
 return messages.filter(m=>{const at=Date.parse(m.at);return at>=from&&at<until;});
}

export async function readCachedSource(db:Db,job:CacheJob,now=Date.now()){
 const result=await db.query(
  'SELECT id,window_start,window_end,messages,fetched_at FROM summary_source_cache '+
  'WHERE group_id=$1 AND external_id=$2 AND origin=$3 '+
  'AND window_start<=$4 AND window_end>=$5 AND expires_at>$6 '+
  'ORDER BY window_end-window_start ASC,fetched_at DESC LIMIT 1',
  [job.group_id,job.external_id,READER_ORIGIN,job.window_start,job.window_end,new Date(now)]
 );
 const row=result.rows[0];
 if(!row||!Array.isArray(row.messages))return null;
 const messages=sliceCachedMessages(row.messages,job.window_start,job.window_end);
 return {
  source:{messages,stats:sourceStats(messages),origin:READER_ORIGIN,fetched_at:new Date(row.fetched_at).toISOString()},
  progress:{cache_hit:true,cache_id:row.id,cache_fetched_at:new Date(row.fetched_at).toISOString(),
   cache_window_start:new Date(row.window_start).toISOString(),cache_window_end:new Date(row.window_end).toISOString(),
   source_origin:READER_ORIGIN,read_count:messages.length,phase:messages.length?'queued':'completed'}
 };
}

export async function queueCachedSource(db:Db,id:string,cached:NonNullable<Awaited<ReturnType<typeof readCachedSource>>>){
 const hasMessages=cached.source.messages.length>0;
 await db.query(
  'UPDATE summary_jobs SET status=$2,source=$3,progress=progress||$4::jsonb,'+
  "error=$5,finished_at=CASE WHEN $2='failed' THEN now() ELSE NULL END "+
  "WHERE id=$1 AND status='waiting_source'",
  [id,hasMessages?'queued':'failed',hasMessages?JSON.stringify(cached.source):null,
   JSON.stringify(cached.progress),hasMessages?null:'该时段在已缓存的完整数据中没有群消息']
 );
}

export async function saveReaderSource(db:Db,job:CacheJob,messages:CacheMessage[],fetchedAt:string,plan?:{epoch?:string;through?:number}){
 const serialized=JSON.stringify(messages);
 if(!messages.length||Buffer.byteLength(serialized)>16_000_000)return false;
 await db.query(
  'INSERT INTO summary_source_cache '+
  '(id,group_id,external_id,window_start,window_end,origin,messages,source_epoch,source_through,fetched_at,expires_at) '+
  "VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10::timestamptz+$11::int*interval '1 day') "+
  'ON CONFLICT(group_id,external_id,window_start,window_end,origin) '+
  'DO UPDATE SET messages=EXCLUDED.messages,source_epoch=EXCLUDED.source_epoch,'+
  'source_through=EXCLUDED.source_through,fetched_at=EXCLUDED.fetched_at,expires_at=EXCLUDED.expires_at '+
  'WHERE summary_source_cache.fetched_at<=EXCLUDED.fetched_at',
  [randomUUID(),job.group_id,job.external_id,job.window_start,job.window_end,
   READER_ORIGIN,serialized,plan?.epoch||null,plan?.through??null,fetchedAt,SOURCE_CACHE_DAYS]
 );
 return true;
}
