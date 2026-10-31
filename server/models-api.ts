import type express from 'express';
import {z} from 'zod';
import {pool,transaction,audit} from './db.js';
import {digest,requireCondition} from './security.js';
import {baseUrl,sealKey} from './model-security.js';
import {createCredential,refreshCatalog,modelOverview,keyValue,modelId,defaultRoutes,validateSelection} from './models.js';

const credentialBody=z.object({name:z.string().trim().min(1).max(80),base_url:z.string().max(300),api_key:keyValue});
export function registerModelAdmin(app:express.Express){
  app.get('/api/models',async(_req,res)=>res.json(await modelOverview()));
  app.post('/api/model-credentials',async(req,res)=>{
    const body=credentialBody.parse(req.body);
    const id=await createCredential(body,req.admin!.username);res.status(201).json({id});
  });
  app.put('/api/model-credentials/:id',async(req,res)=>{
    const id=z.uuid().parse(req.params.id),body=credentialBody.omit({api_key:true}).extend({api_key:keyValue.optional(),revision:z.number().int().positive(),enabled:z.boolean()}).parse(req.body);
    const endpoint=baseUrl(body.base_url);
    await transaction(async db=>{
      const current=(await db.query('SELECT revision,base_url FROM model_credentials WHERE id=$1 FOR UPDATE',[id])).rows[0];
      requireCondition(current?.revision===body.revision,409,'API Key 已被其他操作更新，请重新载入');
      requireCondition(endpoint===current.base_url||body.api_key,400,'更换 API 地址时请重新输入密钥');
      await db.query('UPDATE model_credentials SET name=$1,base_url=$2,enabled=$3,revision=revision+1,catalog_error=NULL WHERE id=$4',[body.name,endpoint,body.enabled,id]);
      if(body.api_key)await db.query('UPDATE model_credentials SET key_ciphertext=$1,key_hint=$2,key_digest=$3,catalog_synced_at=NULL WHERE id=$4',[sealKey(body.api_key),'••••'+body.api_key.slice(-4),digest(body.api_key),id]);
      if(endpoint!==current.base_url||body.api_key)await db.query('UPDATE credential_models SET listed=false WHERE credential_id=$1',[id]);
      await db.query(`UPDATE groups g SET revision=revision+1 WHERE EXISTS(SELECT 1 FROM jsonb_each(g.model_routes) r WHERE (r.value->>'mode'='custom' AND r.value->>'credential_id'=$1) OR (r.value->>'mode'='inherit' AND (SELECT routes->r.key->>'credential_id' FROM model_settings WHERE singleton=true)=$1))`,[id]);
      await audit(req.admin!.username,'model.credential_updated',id,{rotated:!!body.api_key,enabled:body.enabled},db);
    });res.json({ok:true});
  });
  app.post('/api/model-credentials/:id/refresh',async(req,res)=>res.json(await refreshCatalog(z.uuid().parse(req.params.id),req.admin!.username)));
  app.post('/api/model-credentials/:id/models',async(req,res)=>{
    const id=z.uuid().parse(req.params.id),body=z.object({model_id:modelId,capability:z.enum(['text','image'])}).parse(req.body);
    await transaction(async db=>{
      requireCondition((await db.query('SELECT 1 FROM model_credentials WHERE id=$1 FOR UPDATE',[id])).rowCount,404,'API Key 不存在');
      const existing=(await db.query('SELECT capability FROM credential_models WHERE credential_id=$1 AND model_id=$2',[id,body.model_id])).rows[0];
      requireCondition(!existing||existing.capability===body.capability||['unknown','other'].includes(existing.capability),400,'已分类的模型请使用匹配的功能类型');
      await db.query("INSERT INTO credential_models(credential_id,model_id,display_name,capability,source) VALUES($1,$2,$2,$3,'manual') ON CONFLICT(credential_id,model_id) DO UPDATE SET capability=excluded.capability,source='manual'",[id,body.model_id,body.capability]);
      await audit(req.admin!.username,'model.manually_registered',id,{model_id:body.model_id,capability:body.capability},db);
    });res.status(201).json({ok:true});
  });
  app.put('/api/model-defaults',async(req,res)=>{
    const body=z.object({revision:z.number().int().positive(),routes:defaultRoutes}).parse(req.body);
    await transaction(async db=>{
      const old=(await db.query('SELECT revision,routes FROM model_settings WHERE singleton=true FOR UPDATE')).rows[0];
      requireCondition(old.revision===body.revision,409,'默认模型已被更新，请重新载入');
      for(const kind of ['text','image'] as const)await validateSelection(body.routes[kind],kind,db);
      await db.query('UPDATE model_settings SET routes=$1,revision=revision+1 WHERE singleton=true',[body.routes]);
      const changed=(['text','image'] as const).filter(kind=>JSON.stringify(old.routes[kind])!==JSON.stringify(body.routes[kind]));
      if(changed.length)await db.query("UPDATE groups SET revision=revision+1 WHERE EXISTS(SELECT 1 FROM unnest($1::text[]) kind WHERE model_routes->kind->>'mode'='inherit')",[changed]);
      await audit(req.admin!.username,'model.defaults_updated',null,{functions:changed},db);
    });res.json({ok:true});
  });
}
