import {keyForAlias,updateKeyAliases} from './key-vault.js';
import {controlTransaction} from './db.js';
import {sealControlSecret} from './bot-secrets.js';
import type express from 'express';
import {z} from 'zod';
import {pool,transaction,audit} from './db.js';
import {digest,requireCondition} from './security.js';
import {baseUrl,sealKey} from './model-security.js';
import {createCredential,refreshCatalog,modelOverview,keyValue,modelId,clientType,defaultRoutes,validateSelection,configuredModelRoutes} from './models.js';

const credentialBody=z.object({name:z.string().trim().min(1).max(80),base_url:z.string().max(300),api_key:keyValue,client_type:clientType.default('openai')});
export function registerModelAdmin(app:express.Express){
  app.get('/api/models',async(_req,res)=>res.json(await modelOverview()));
  app.post('/api/model-credentials',async(req,res)=>{
    const body=credentialBody.parse(req.body);
    const id=await createCredential(body,req.admin!.username);res.status(201).json({id});
  });
  app.put('/api/model-credentials/:id',async(req,res)=>{
    const id=z.uuid().parse(req.params.id),body=credentialBody.omit({api_key:true,client_type:true}).extend({client_type:clientType.optional(),api_key:keyValue.optional(),revision:z.number().int().positive(),enabled:z.boolean()}).parse(req.body);
    const endpoint=baseUrl(body.base_url),k=await keyForAlias(id);
    requireCondition(k.owner_user_id===req.admin!.id,403,'只能更换自己的 Key；管理员维护其他 Key 请到 Key 管理');
    requireCondition(k.revision===body.revision,409,'Key 已更新，请刷新');requireCondition(endpoint===k.base_url||body.api_key,400,'更换地址时请重新填写 Key');
    const updated=await controlTransaction(async db=>{const lock=(await db.query('SELECT revision FROM managed_model_keys WHERE id=$1 FOR UPDATE',[k.id])).rows[0];requireCondition(lock.revision===body.revision,409,'Key 已更新');return (await db.query('UPDATE managed_model_keys SET name=$2,base_url=$3,client_type=$4,enabled=$5,secret_ciphertext=COALESCE($6,secret_ciphertext),key_hint=COALESCE($7,key_hint),key_digest=COALESCE($8,key_digest),revision=revision+1 WHERE id=$1 RETURNING *',[k.id,body.name,endpoint,body.client_type||k.client_type,body.enabled,body.api_key?sealControlSecret(body.api_key):null,body.api_key?'••••••'+body.api_key.slice(-6):null,body.api_key?digest(body.api_key):null])).rows[0];});await updateKeyAliases(updated);res.json({ok:true});
  });
  app.post('/api/model-credentials/:id/refresh',async(req,res)=>res.json(await refreshCatalog(z.uuid().parse(req.params.id),req.admin!.username)));
  app.post('/api/model-credentials/:id/models',async(req,res)=>{
    const id=z.uuid().parse(req.params.id),body=z.object({model_id:modelId,capability:z.enum(['text','image'])}).parse(req.body);
    const k=await keyForAlias(id);requireCondition(k.owner_user_id===req.admin!.id||req.admin!.role==='super_admin',403,'无权维护此 Key');
    await controlTransaction(async db=>{const current=(await db.query('SELECT * FROM managed_model_keys WHERE id=$1 FOR UPDATE',[k.id])).rows[0];const models=current.models.filter((m:any)=>m.model_id!==body.model_id);models.push({...body,display_name:body.model_id,source:'manual',listed:false});await db.query('UPDATE managed_model_keys SET models=$2 WHERE id=$1',[k.id,JSON.stringify(models)]);});await (await import('./key-vault.js')).syncAliases();res.status(201).json({ok:true});
  });
  app.put('/api/model-defaults',async(req,res)=>{
    const body=z.object({revision:z.number().int().positive(),routes:defaultRoutes}).parse(req.body);
    await transaction(async db=>{
      const old=(await db.query('SELECT revision,routes FROM model_settings WHERE singleton=true FOR UPDATE')).rows[0];
      requireCondition(old.revision===body.revision,409,'默认模型已被更新，请重新载入');
      if(body.routes.onboarding===undefined)body.routes.onboarding=old.routes.onboarding;
      await validateSelection(body.routes.onboarding||null,'text',db);
      if(body.routes.stages===undefined&&old.routes.stages!==undefined)body.routes.stages=old.routes.stages;
      for(const kind of ['text','image'] as const)await validateSelection(body.routes[kind],kind,db);
      for(const route of Object.values(body.routes.stages||{}))await validateSelection(route||null,'text',db);
      await db.query('UPDATE model_settings SET routes=$1,revision=revision+1 WHERE singleton=true',[body.routes]);
      const changed=(['text','image'] as const).filter(kind=>JSON.stringify(old.routes[kind])!==JSON.stringify(body.routes[kind]));
      const groups=(await db.query('SELECT id,model_routes FROM groups')).rows;
      const affected=groups.filter(g=>JSON.stringify(configuredModelRoutes(g.model_routes,old.routes))!==JSON.stringify(configuredModelRoutes(g.model_routes,body.routes))).map(g=>g.id);
      if(affected.length)await db.query('UPDATE groups SET revision=revision+1 WHERE id=ANY($1::uuid[])',[affected]);
      if(JSON.stringify(old.routes.stages||{})!==JSON.stringify(body.routes.stages||{}))changed.push('stages' as any);
      await audit(req.admin!.username,'model.defaults_updated',null,{functions:changed},db);
    });res.json({ok:true});
  });
}
