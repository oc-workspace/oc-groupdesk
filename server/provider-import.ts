import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {transaction,audit} from './db.js';
import {digest,requireCondition} from './security.js';
import {sealKey,baseUrl} from './model-security.js';
import {clientType,keyValue,modelId,inferCapability} from './models.js';
export const providerBatch=z.object({
  rename:z.object({id:z.uuid(),revision:z.number().int().positive(),name:z.string().trim().min(1).max(80)}).optional(),
  credentials:z.array(z.object({name:z.string().trim().min(1).max(80),base_url:z.string().max(300),client_type:clientType,api_key:keyValue,configured_model:modelId.optional()})).min(1).max(20)
});
export async function importProviderBatch(value:unknown){
  const input=providerBatch.parse(value);
  return transaction(async db=>{
    await db.query('SELECT pg_advisory_xact_lock(78511944)');
    if(input.rename){
      const r=input.rename,current=(await db.query('SELECT name,revision FROM model_credentials WHERE id=$1 FOR UPDATE',[r.id])).rows[0];
      requireCondition(current,404,'待重命名的 Key 不存在');
      if(current.name!==r.name){
        requireCondition(current.revision===r.revision,409,'现有 Key 已更新，请重新核对后导入');
        await db.query('UPDATE model_credentials SET name=$1,revision=revision+1 WHERE id=$2',[r.name,r.id]);
        await db.query(`UPDATE groups g SET revision=revision+1 WHERE EXISTS(SELECT 1 FROM jsonb_each(g.model_routes) r WHERE (r.value->>'mode'='custom' AND r.value->>'credential_id'=$1) OR (r.value->>'mode'='inherit' AND (SELECT routes->r.key->>'credential_id' FROM model_settings WHERE singleton=true)=$1))`,[r.id]);
        await audit('operator','model.credential_renamed',r.id,{},db);
      }
    }
    const result=[];
    for(const item of input.credentials){
      const endpoint=baseUrl(item.base_url),hash=digest(item.api_key);
      const existing=(await db.query('SELECT id,name,base_url,key_digest,client_type FROM model_credentials WHERE name=$1 OR (base_url=$2 AND key_digest=$3) FOR UPDATE',[item.name,endpoint,hash])).rows;
      requireCondition(existing.length<=1,409,'Key 名称或密钥与现有配置冲突');
      let id=existing[0]?.id;
      if(id)requireCondition(existing[0].name===item.name&&existing[0].base_url===endpoint&&existing[0].key_digest===hash&&existing[0].client_type===item.client_type,409,'同名 Key 的连接信息已存在差异，导入不会覆盖');
      else{
        id=randomUUID();
        await db.query('INSERT INTO model_credentials(id,name,base_url,client_type,key_ciphertext,key_hint,key_digest) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,item.name,endpoint,item.client_type,sealKey(item.api_key),'••••'+item.api_key.slice(-4),hash]);
        await audit('operator','model.credential_imported',id,{client_type:item.client_type},db);
      }
      if(item.configured_model)await db.query("INSERT INTO credential_models(credential_id,model_id,display_name,capability,source) VALUES($1,$2,$2,$3,'configured') ON CONFLICT(credential_id,model_id) DO NOTHING",[id,item.configured_model,inferCapability(item.configured_model)]);
      result.push({id,name:item.name});
    }
    return result;
  });
}
