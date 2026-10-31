import {readFile} from 'node:fs/promises';
import {z} from 'zod';
import {pool} from '../server/db.js';
import {importMaterial} from '../server/persona-materials.js';
import {HttpError} from '../server/security.js';
const arg=(name:string)=>process.argv[process.argv.indexOf(name)+1];
try{
 const collection=z.uuid().parse(arg('--collection')),name=z.string().min(1).max(180).parse(arg('--name'));
 const format=name.split('.').pop()?.toLowerCase()||'';
 if(!['jsonl','txt','md','pdf'].includes(format))throw new Error('unsupported');
 const buffer=await readFile('/dev/stdin');if(buffer.length>100*1024*1024)throw new Error('size');
 const r=await importMaterial(collection,buffer,name,format);
 console.log(JSON.stringify({id:r.id,added:r.added,updated:r.updated,unchanged:r.unchanged,reused:!!r.reused,sha256:r.sha256}));
}catch(e){console.error(e instanceof HttpError?e.message:'素材导入失败，请检查文件、参数和服务日志');process.exitCode=1;}
finally{await pool.end();}
