import {pool} from './db.js';
export function splitText(text:string,size=900,overlap=120){
  const clean=text.replace(/\r\n/g,'\n').replace(/\0/g,'').trim();
  const result:string[]=[];
  for(let start=0;start<clean.length;start+=size-overlap)result.push(clean.slice(start,start+size));
  return result;
}
export function searchTerms(query:string){
  const value=query.toLocaleLowerCase().trim();
  const latin=value.match(/[a-z0-9]{2,}/g)||[];
  const han=value.match(/[\p{Script=Han}]+/gu)||[];
  return [...new Set([...latin,...han.flatMap(word=>word.length<2?[word]:Array.from({length:word.length-1},(_,i)=>word.slice(i,i+2)))])].slice(0,32);
}
export async function searchKnowledge(kbIds:string[],query:string){
  const terms=searchTerms(query);
  if(!kbIds.length||!terms.length)return [];
  const sql=[
    'SELECT c.id,c.content,d.id document_id,d.title,d.kb_id,k.name kb_name,',
    '(SELECT count(*)::int FROM unnest($2::text[]) term WHERE strpos(lower(c.content),term)>0) score',
    'FROM chunks c JOIN documents d ON d.id=c.document_id JOIN knowledge_bases k ON k.id=d.kb_id',
    "WHERE d.kb_id=ANY($1::uuid[]) AND d.status='ready'",
    'AND EXISTS(SELECT 1 FROM unnest($2::text[]) term WHERE strpos(lower(c.content),term)>0)',
    'ORDER BY score DESC,c.id ASC LIMIT 6'
  ].join(' ');
  return (await pool.query(sql,[kbIds,terms])).rows;
}
