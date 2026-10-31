import {z} from 'zod';
import {requireCondition} from './security.js';
import type {ClientType} from './model-security.js';
const identifier=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/+\-]{0,199}$/);
export function inferCapability(id:string):'text'|'image'|'other'|'unknown'{
  if(/video|embedding|whisper|tts|audio|rerank/i.test(id))return 'other';
  if(/image|banana|dall-e|flux|stable-diffusion|sdxl/i.test(id))return 'image';
  if(/imagine/i.test(id))return 'unknown';
  return 'text';
}
export function parseCatalog(value:unknown,protocol:ClientType='openai'){
  const outer=z.object({data:z.array(z.unknown()).max(5000).optional(),models:z.array(z.unknown()).max(5000).optional()}).safeParse(value);
  requireCondition(outer.success,502,'服务返回的模型目录格式无效，已保留原目录');
  const input=protocol==='gemini'?outer.data.models:outer.data.data??(protocol==='openai_responses'?outer.data.models:undefined);
  requireCondition(input,502,'服务返回的模型目录格式无效，已保留原目录');
  const rows=input.map(v=>{
    const parsed=z.object({id:z.string().optional(),slug:z.string().optional(),name:z.string().optional(),display_name:z.string().max(200).nullable().optional(),displayName:z.string().max(200).nullable().optional(),type:z.string().optional(),output_modalities:z.array(z.string()).optional(),supportedGenerationMethods:z.array(z.string()).optional()}).safeParse(v);
    requireCondition(parsed.success,502,'服务返回的模型目录格式无效，已保留原目录');
    const row=parsed.data,raw=protocol==='gemini'?row.name:row.id??row.slug;
    const valid=identifier.safeParse(protocol==='gemini'?raw?.replace(/^models\//,''):raw);
    requireCondition(valid.success,502,'服务返回的模型 ID 格式无效，已保留原目录');
    let capability=inferCapability(valid.data);
    if(row.type==='image'||row.output_modalities?.some(m=>m.toLowerCase()==='image'))capability='image';
    else if(row.supportedGenerationMethods?.length&&row.supportedGenerationMethods.every(m=>/embed/i.test(m)))capability='other';
    return {id:valid.data,name:row.display_name||row.displayName||valid.data,capability};
  });
  return [...new Map(rows.map(r=>[r.id,r])).values()];
}
