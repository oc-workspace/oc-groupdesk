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
    const endpoint=baseUrl(body.base_url);
    await transaction(async db=>{
      const current=(await db.query('SELECT revision,base_url,client_type FROM model_credentials WHERE id=$1 FOR UPDATE',[id])).rows[0];
      requireCondition(current?.revision===body.revision,409,'API Key 已被其他操作更新，请重新载入');
      requireCondition(endpoint===current.base_url||body.api_key,400,'更换 API 地址时请重新输入密钥');
      const protocol=body.client_type||current.client_type;
      await db.query('UPDATE model_credentials SET name=$1,base_url=$2,enabled=$3,revision=revision+1,catalog_error=NULL,client_type=$5 WHERE id=$4',[body.name,endpoint,body.enabled,id,protocol]);
      if(body.api_key)await db.query('UPDATE model_credentials SET key_ciphertext=$1,key_hint=$2,key_digest=$3,catalog_synced_at=NULL WHERE id=$4',[sealKey(body.api_key),'••••'+body.api_key.slice(-4),digest(body.api_key),id]);
      if(endpoint!==current.base_url||body.api_key||protocol!==current.client_type){await db.query('UPDATE credential_models SET listed=false WHERE credential_id=$1',[id]);await db.query('UPDATE model_credentials SET catalog_synced_at=NULL WHERE id=$1',[id]);}
      const defaults=(await db.query('SELECT routes FROM model_settings WHERE singleton=true')).rows[0].routes;
      const groups=(await db.query('SELECT id,model_routes FROM groups')).rows;
      const affected=groups.filter(g=>{const r=configuredModelRoutes(g.model_routes,defaults);return [r.text,r.image,...Object.values(r.stages)].some(v=>v.selection?.credential_id===id);}).map(g=>g.id);
      await db.query(`UPDATE groups g SET revision=revision+1 WHERE id=ANY($2::uuid[]) OR EXISTS(SELECT 1 FROM group_interactions b WHERE b.group_id=g.id AND (b.config->>'enabled')::boolean AND b.config->'model_route'->>'mode'='custom' AND b.config->'model_route'->>'credential_id'=$1) OR EXISTS(SELECT 1 FROM summary_settings s WHERE s.group_id=g.id AND s.config->'model_route'->>'mode'='custom' AND s.config->'model_route'->>'credential_id'=$1)`,[id,affected]);
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
