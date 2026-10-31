// Credential JSON arrives only on stdin of the existing app container.
import {readFile} from 'node:fs/promises';
import {importExistingCredential,refreshCatalog,modelId,keyValue} from '../server/models.js';
import {pool} from '../server/db.js';
import {z} from 'zod';
try{
  const body=z.object({name:z.string().min(1).max(80),base_url:z.string(),api_key:keyValue,model_id:modelId}).parse(JSON.parse(await readFile('/dev/stdin','utf8')));
  const id=await importExistingCredential(body);
  try{const result=await refreshCatalog(id,'operator');console.log('Existing credential imported; catalog models:',result.count);}catch{console.log('Existing credential imported; catalog refresh failed (existing model retained).');}
}finally{await pool.end();}
