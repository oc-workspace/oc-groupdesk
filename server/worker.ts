import {tick} from './summaries/core.js';
import {processSummary} from './summaries/generation.js';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {processPersonaJob} from './persona-generation.js';
import {processConversationJob} from './conversation-insights.js';
import {pool,transaction} from './db.js';
import {splitText} from './search.js';

export async function processNext(){
  const doc=await transaction(async db=>{
    await db.query("UPDATE documents SET status=CASE WHEN attempts>=3 THEN 'failed' ELSE 'pending' END,error=CASE WHEN attempts>=3 THEN '资料处理超时，请检查文件后重试' ELSE NULL END WHERE status='processing' AND started_at<now()-interval '3 minutes'");
    const row=(await db.query("SELECT * FROM documents WHERE status='pending' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1")).rows[0];
    if(!row)return null;
    await db.query("UPDATE documents SET status='processing',started_at=now(),attempts=attempts+1 WHERE id=$1",[row.id]);
    return row;
  });
  if(!doc)return false;
  try{
    let content=doc.source_text||'';
    if(doc.filename){
      const buffer=await readFile(resolve(process.env.DATA_DIR||'data','uploads',doc.filename));
      if(doc.kind==='pdf'){
        const {PDFParse}=await import('pdf-parse');
        const parser=new PDFParse({data:buffer});
        try{content=(await parser.getText()).text;}finally{await parser.destroy();}
      }else{
        content=new TextDecoder('utf-8',{fatal:true}).decode(buffer);
      }
    }
    if(content.length>500000)throw new Error('资料文字超过 50 万字，请拆分后上传');
    const chunks=splitText(content);
    if(!chunks.length)throw new Error('未提取到文字；扫描型 PDF 需要先进行 OCR');
    await transaction(async db=>{
      const found=await db.query('SELECT id FROM documents WHERE id=$1 FOR UPDATE',[doc.id]);
      if(!found.rowCount)return;
      await db.query('DELETE FROM chunks WHERE document_id=$1',[doc.id]);
      for(let i=0;i<chunks.length;i++)await db.query('INSERT INTO chunks(document_id,ordinal,content) VALUES($1,$2,$3)',[doc.id,i,chunks[i]]);
      await db.query("UPDATE documents SET status='ready',chunks=$1,error=NULL WHERE id=$2",[chunks.length,doc.id]);
      await db.query('UPDATE groups SET revision=revision+1 WHERE id IN(SELECT group_id FROM group_knowledge WHERE kb_id=$1)',[doc.kb_id]);
    });
  }catch(error){
    const message=error instanceof TypeError?'资料不是有效的 UTF-8 文字文件':error instanceof Error&&['资料文字超过 50 万字，请拆分后上传','未提取到文字；扫描型 PDF 需要先进行 OCR'].includes(error.message)?error.message:'文件解析失败，请确认文件未损坏且 PDF 未加密';
    await pool.query("UPDATE documents SET status='failed',error=$1 WHERE id=$2",[message,doc.id]);
    console.error('document_processing_failed',doc.id);
  }
  return true;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  let running=true;const summaryAbort=new AbortController();
  const summaryTasks=[(async()=>{while(running){try{await tick();}catch{console.error('summary_schedule_retry');}await new Promise(r=>setTimeout(r,2000));}})(),(async()=>{while(running){try{if(!await processSummary(undefined,summaryAbort.signal))await new Promise(r=>setTimeout(r,2000));}catch{await new Promise(r=>setTimeout(r,3000));}}})()];
  process.on('SIGTERM',()=>{running=false;summaryAbort.abort();});process.on('SIGINT',()=>{running=false;summaryAbort.abort();});
  console.log('GroupDesk worker ready');
  while(running){
    try{if(!await processNext()&&!await processPersonaJob()&&!await processConversationJob())await new Promise(r=>setTimeout(r,2000));}
    catch{console.error('worker_retry');await new Promise(r=>setTimeout(r,3000));}
  }
  await Promise.allSettled(summaryTasks);await pool.end();
}
