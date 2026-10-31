// Run in the existing app container; JSON containing the credential arrives only on stdin.
import {readFile} from 'node:fs/promises';
import {createCredential,refreshCatalog,modelId} from '../server/models.js';
import {pool,transaction,audit} from '../server/db.js';
import {z} from 'zod';
const body=z.object({name:z.string().min(1).max(80),base_url:z.string(),api_key:z.string(),model_id:modelId}).parse(JSON.parse(await readFile('/dev/stdin','utf8')));
try{
  const id=await createCredential(body,'operator');
  await transaction(async db=>{
    await db.query("INSERT INTO credential_models(credential_id,model_id,display_name,capability,source) VALUES($1,$2,$2,'text','configured')",[id,body.model_id]);
    await db.query("UPDATE model_settings SET routes=jsonb_set(routes,'{text}',$1::jsonb),revision=revision+1 WHERE singleton=true",[JSON.stringify({credential_id:id,model_id:body.model_id})]);
    await db.query("UPDATE groups SET revision=revision+1 WHERE model_routes->'text'->>'mode'='inherit'");
    await audit('operator','model.existing_credential_imported',id,{},db);
  });
  try{const result=await refreshCatalog(id,'operator');console.log('Imported existing credential; catalog models:',result.count);}catch{console.log('Imported existing credential; catalog refresh failed (existing model retained).');}
}finally{await pool.end();}
