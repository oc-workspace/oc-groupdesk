import {randomUUID} from 'node:crypto';
import type pg from 'pg';
import {requireCondition} from './security.js';
import {textMatchesAny} from '../shared/conversation.js';

type Database=Pick<pg.PoolClient,'query'>;
type Dataset={id:string;collection_id:string;sender_ids:string[];since:string|number|null;until_time:string|number|null;contains_any:string[]};
// Exactly the whitespace removed by JavaScript String.trim(), without NUL.
const trimCharacters='\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
const filters=`SELECT * FROM jsonb_to_recordset($1::jsonb) d(collection_id uuid,sender_ids text[],since bigint,until_time bigint)`;
const matches=`d.collection_id=m.collection_id AND (cardinality(d.sender_ids)=0 OR m.sender_id=ANY(d.sender_ids)) AND (d.since IS NULL OR m.timestamp>=d.since) AND (d.until_time IS NULL OR m.timestamp<=d.until_time)`;

export function collectionQuotas(counts:{collection_id:string;eligible_records:number}[],maximum=500){
 const quotas=counts.map(c=>({...c,take:0}));let left=maximum;
 while(left>0){
  const active=quotas.filter(c=>c.take<c.eligible_records);if(!active.length)break;
  const share=Math.max(1,Math.floor(left/active.length));
  for(const c of active){const n=Math.min(left,share,c.eligible_records-c.take);c.take+=n;left-=n;}
 }
 return quotas.filter(c=>c.take>0);
}

export function packPersonaSamples(rows:any[],characters=100000){
 const references=rows.filter(r=>r.kind==='document').length,regular=rows.length-references;
 const referenceBudget=references?(regular?Math.floor(characters*.4):characters):0;
 const regularBudget=characters-referenceBudget;
 let used=0;
 const selected=rows.map(r=>{
  const count=r.kind==='document'?references:regular,budget=r.kind==='document'?referenceBudget:regularBudget;
  const text=r.text.slice(0,Math.min(4000,Math.floor(budget/Math.max(1,count))));used+=text.length;
  return {collection_id:r.collection_id,id:r.source_id,sender_id:r.sender_id,timestamp:r.timestamp,kind:r.kind,
   content_hash:r.content_hash,text,truncated:r.prefix_truncated||text.length<r.text.length};
 });
 return {selected,characters:used};
}

/** Freeze a small sample inside the caller's repeatable-read transaction.
 * Counts, ranking, de-duplication and body slicing stay in PostgreSQL. No source
 * XML, media metadata, quotation or unselected body is loaded into the app.
 */
export async function samplePersonaDatasets(ids:string[],db:Database,maximum=500,characters=100000){
 const found=(await db.query('SELECT d.*,c.source_group_id FROM persona_datasets d JOIN persona_collections c ON c.id=d.collection_id WHERE d.id=ANY($1::uuid[])',[ids])).rows;
 const datasets:Dataset[]=[...new Set(ids)].map(id=>{const d=found.find(d=>d.id===id);requireCondition(d,404,'数据集不存在');return d;});
 const plain=datasets.filter(d=>!d.contains_any?.length),keyword=datasets.filter(d=>d.contains_any?.length);
 // Retain the existing NFKC/alias/word-boundary semantics for keyword filters.
 // Their matching IDs go into a temporary DB table; only a bounded page of
 // bodies is read at once. Most archives have no keywords and skip this path.
 const table='persona_terms_'+randomUUID().replaceAll('-','');
 if(keyword.length){
  await db.query(`CREATE TEMP TABLE ${table}(collection_id uuid,source_id text,PRIMARY KEY(collection_id,source_id)) ON COMMIT DROP`);
  for(const collectionId of new Set(keyword.map(d=>d.collection_id))){
   let cursor:any=null;
   while(true){
    const page=(await db.query(`WITH filters AS (${filters}) SELECT m.collection_id,m.source_id,m.sender_id,m.timestamp,m.authored_text
     FROM persona_materials m WHERE m.collection_id=$2 AND NOT m.excluded
     AND EXISTS(SELECT 1 FROM filters d WHERE ${matches})
     AND ($3::bigint IS NULL OR (m.timestamp,m.source_id)>($3,$4::text)) ORDER BY m.timestamp,m.source_id LIMIT 128`,
     [JSON.stringify(keyword),collectionId,cursor?.timestamp??null,cursor?.source_id??null])).rows;
    if(!page.length)break;
    const accepted=page.filter(r=>keyword.some(d=>d.collection_id===r.collection_id&&(!d.sender_ids.length||d.sender_ids.includes(r.sender_id))
     &&(d.since===null||Number(r.timestamp)>=Number(d.since))&&(d.until_time===null||Number(r.timestamp)<=Number(d.until_time))
     &&textMatchesAny(r.authored_text||'',d.contains_any)));
    if(accepted.length)await db.query(`INSERT INTO ${table} SELECT collection_id,source_id FROM jsonb_to_recordset($1::jsonb) x(collection_id uuid,source_id text) ON CONFLICT DO NOTHING`,
     [JSON.stringify(accepted.map(r=>({collection_id:r.collection_id,source_id:r.source_id})))]);
    cursor=page.at(-1);
   }
  }
 }
 const match=`NOT m.excluded AND (EXISTS(SELECT 1 FROM filters d WHERE ${matches})${keyword.length?` OR EXISTS(SELECT 1 FROM ${table} k WHERE k.collection_id=m.collection_id AND k.source_id=m.source_id)`:''})`;
 const parameters=[JSON.stringify(plain),trimCharacters];
 const counts=(await db.query(`WITH filters AS (${filters})
  SELECT m.collection_id,count(*)::int total_records,count(*) FILTER(WHERE btrim(COALESCE(m.authored_text,''),$2)<>'')::int eligible_records,
  array_agg(DISTINCT m.import_id) source_import_ids FROM persona_materials m WHERE ${match} GROUP BY m.collection_id ORDER BY m.collection_id`,parameters)).rows;
 const quotas=collectionQuotas(counts,maximum);
 let selected:any[]=[];
 if(quotas.length){
  selected=(await db.query(`WITH filters AS (${filters}),
   quotas AS (SELECT * FROM jsonb_to_recordset($3::jsonb) q(collection_id uuid,eligible_records integer,take integer)),
   ranked AS (SELECT m.collection_id,m.source_id,row_number() OVER(PARTITION BY m.collection_id ORDER BY m.timestamp,m.source_id) rn
    FROM persona_materials m WHERE ${match} AND btrim(COALESCE(m.authored_text,''),$2)<>''),
   positions AS (SELECT q.collection_id,CASE WHEN q.take=1 THEN 1 ELSE floor(i::numeric*(q.eligible_records-1)/(q.take-1))::bigint+1 END rn
    FROM quotas q CROSS JOIN LATERAL generate_series(0,q.take-1) i)
   SELECT m.collection_id,m.source_id,m.sender_id,m.timestamp,m.kind,m.content_hash,left(m.authored_text,4000) text,
    char_length(m.authored_text)>4000 prefix_truncated FROM ranked r JOIN positions p USING(collection_id,rn)
    JOIN persona_materials m ON m.collection_id=r.collection_id AND m.source_id=r.source_id
    ORDER BY m.timestamp,m.source_id,m.collection_id`,[...parameters,JSON.stringify(quotas)])).rows;
 }
 const packed=packPersonaSamples(selected,characters);
 return {datasets,...packed,total_records:counts.reduce((n,c)=>n+c.total_records,0),eligible:counts.reduce((n,c)=>n+c.eligible_records,0),
  source_import_ids:[...new Set(counts.flatMap(c=>c.source_import_ids))],
  collections:counts.map(c=>({collection_id:c.collection_id,total_records:c.total_records,eligible_records:c.eligible_records,sampled_records:quotas.find(q=>q.collection_id===c.collection_id)?.take||0}))};
}
