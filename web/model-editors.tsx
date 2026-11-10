import {SettingsSection} from './settings-section';
import React,{useEffect,useState,type FormEvent} from 'react';
import {modelStages,type ModelStage} from '../shared/model-stages';
export type Protocol='openai'|'openai_responses'|'gemini';
const protocolNames={openai:'OpenAI Chat Completions',openai_responses:'OpenAI Responses',gemini:'Gemini 原生'};
export type Model={model_id:string;display_name:string;capability:'text'|'image'|'other'|'unknown';source:string;listed:boolean};
export type Credential={allowed_features?:string[];client_type:Protocol;id:string;name:string;base_url:string;key_hint:string;enabled:boolean;revision:number;catalog_synced_at:string|null;catalog_error:string|null;models:Model[]};
export type Selection={credential_id:string;model_id:string};
export type Route={mode:'inherit'|'disabled'}|({mode:'custom'}&Selection);
export type StageRoute={mode:'inherit'}|({mode:'custom'}&Selection);
export type GroupRoutes={text:Route;image:Route;stages?:Partial<Record<ModelStage,StageRoute>>};
export type ModelData={credentials:Credential[];defaults:{revision:number;routes:{onboarding?:Selection|null;text:Selection|null;image:Selection|null;stages?:Partial<Record<ModelStage,Selection|null>>}}};
type Api=(path:string,method?:string,body?:unknown)=>Promise<any>;
const names={text:'文字',image:'生图'};
const emptyRoutes:GroupRoutes={text:{mode:'inherit'},image:{mode:'inherit'}};
function Choice({kind,value,onChange,data,prefix,feature}:{kind:'text'|'image';value:Selection|null;onChange:(v:Selection|null)=>void;data:ModelData;prefix:string;feature?:string}){
  const credential=data.credentials.find(c=>c.id===value?.credential_id);
  const models=credential?.models.filter(m=>m.capability===kind)||[];
  return <div className="policy-grid"><label>{prefix} API Key<select value={value?.credential_id||''} onChange={e=>onChange(e.target.value?{credential_id:e.target.value,model_id:''}:null)}><option value="">请选择 API Key</option>{data.credentials.filter(c=>!feature||!c.allowed_features||c.allowed_features.includes(feature)).map(c=><option key={c.id} value={c.id} disabled={!c.enabled}>{c.name} · {c.key_hint}{!c.enabled?'（已停用）':''}</option>)}</select></label><label>{prefix}模型<select value={value?.model_id||''} disabled={!credential?.enabled} onChange={e=>value&&onChange({...value,model_id:e.target.value})}><option value="">{credential?models.length?'请选择模型':'暂无对应模型，请先查询目录或手动登记':'先选择 API Key'}</option>{models.map(m=><option key={m.model_id} value={m.model_id}>{m.model_id}{!m.listed?(m.source==='catalog'?'（历史目录，本次未列出）':'（已登记，目录未列出）'):m.source==='catalog'?'（目录 · 功能按名称推测）':''}</option>)}</select></label></div>;
}
function routeLabel(data:ModelData,value:Selection|null|undefined,fallback:string){
  return value?`${data.credentials.find(c=>c.id===value.credential_id)?.name||'未找到 Key'} / ${value.model_id||'尚未选模型'}`:fallback;
}
function GroupStageEditor({value,onChange,data}:{value:GroupRoutes;onChange:(v:GroupRoutes)=>void;data:ModelData}){
  return <SettingsSection title="各处理阶段" issue={Object.entries(value.stages||{}).filter(([id])=>id!=='summary').map(([,route])=>route).some(route=>route.mode==='custom'&&(!route.credential_id||!route.model_id))?'有处理阶段尚未选择 API Key 或模型':''} description={Object.entries(value.stages||{}).filter(([id])=>id!=='summary').map(([,route])=>route).filter(route=>route.mode==='custom').length+' 个阶段单独设置，其余沿用继承设置'}><div className="model-stages"><p className="hint">阶段继承全局阶段设置；全局未指定时使用本群文字模型。微信取数、基础消息类型识别和发送由程序处理，不额外调用模型。不同阶段选择不同模型时，最终回答会交给回答模型。</p>{modelStages.map(stage=>{
    const route=value.stages?.[stage.id]||{mode:'inherit'},global=data.defaults.routes.stages?.[stage.id];
    const base=value.text.mode==='custom'?value.text:value.text.mode==='inherit'?data.defaults.routes.text:null;
    return <div className="model-route" key={stage.id}><h4>{stage.name}</h4><p className="hint">{stage.description}</p><label>{stage.name}配置<select value={route.mode} onChange={e=>onChange({...value,stages:{...value.stages,[stage.id]:e.target.value==='custom'?{mode:'custom',credential_id:'',model_id:''}:{mode:'inherit'}}})}><option value="inherit">继承 · {routeLabel(data,global||base,value.text.mode==='disabled'?'本群文字已停用':'未配置，停止调用')}</option><option value="custom">本群单独选择</option></select></label>{route.mode==='custom'&&<Choice kind="text" feature={stage.id==='summary'?'summary':'chat'} prefix={stage.name} data={data} value={route.credential_id?route:null} onChange={v=>onChange({...value,stages:{...value.stages,[stage.id]:{mode:'custom',credential_id:v?.credential_id||'',model_id:v?.model_id||''}}})}/>}</div>;
  })}{value.text.mode==='disabled'&&<p className="form-error">本群文字已停用，各文字处理阶段也将停止。</p>}</div></SettingsSection>;
}
export function GroupModelEditor({value=emptyRoutes,onChange,data}:{value?:GroupRoutes;onChange:(v:GroupRoutes)=>void;data:ModelData}){
  const describe=(kind:'text'|'image')=>{
    const route=value[kind];
    if(route.mode==='disabled')return names[kind]+'：已停用';
    const selected=route.mode==='custom'?route:data.defaults.routes[kind];
    return names[kind]+'：'+(route.mode==='inherit'?'继承默认':'本群单独设置')+' · '+(selected?.model_id||'未配置');
  };
  const customRoutes=[value.text,value.image,...Object.entries(value.stages||{}).filter(([id])=>id!=='summary').map(([,route])=>route)];
  const issue=customRoutes.some(route=>route.mode==='custom'&&(!route.credential_id||!route.model_id))?'有单独配置尚未选择 API Key 或模型':'';
  return <SettingsSection title="本群模型与 API Key" className="model-group-settings" description={describe('text')+'；'+describe('image')} issue={issue}><p className="hint">文字作为各阶段的基础模型；下方可分别指定模型和 API Key。生图配置不等于图片内容识别。</p>{(['text','image'] as const).map(kind=>{
    const route=value[kind],def=data.defaults.routes[kind],defaultKey=data.credentials.find(c=>c.id===def?.credential_id);
    const defaultLabel=def?`${defaultKey?.name||'未找到 Key'} / ${def.model_id}`:kind==='text'?'未配置，停止调用':'未配置';
    return <div className="model-route" key={kind}><label>{names[kind]}配置<select value={route.mode} onChange={e=>onChange({...value,[kind]:e.target.value==='custom'?{mode:'custom',credential_id:'',model_id:''}:{mode:e.target.value}})}><option value="inherit">继承默认 · {defaultLabel}</option><option value="custom">本群单独选择</option><option value="disabled">停用{names[kind]}</option></select></label>{route.mode==='custom'&&<Choice kind={kind} feature={kind==='image'?'image':'chat'} prefix={'本群'+names[kind]} data={data} value={route.credential_id?route:null} onChange={v=>onChange({...value,[kind]:{mode:'custom',credential_id:v?.credential_id||'',model_id:v?.model_id||''}})}/>}</div>;
  })}<GroupStageEditor value={value} onChange={onChange} data={data}/></SettingsSection>;
}
export function Models({data,api,reload,notify,onDirty}:{data:ModelData;api:Api;reload:()=>Promise<void>;notify:(s:string,error?:boolean)=>void;onDirty?:(dirty:boolean)=>void}){
  const [defaults,setDefaults]=useState(data.defaults.routes),[busy,setBusy]=useState(false),[form,setForm]=useState<{client_type:Protocol;id?:string;name:string;base_url:string;api_key:string;revision?:number;enabled:boolean}|null>(null);
  const [manual,setManual]=useState<{id:string;model_id:string;capability:'text'|'image'}|null>(null);
  useEffect(()=>setDefaults(data.defaults.routes),[data.defaults.revision]);
  async function run(work:()=>Promise<void>){setBusy(true);try{await work();}catch(e){notify((e as Error).message,true);}finally{setBusy(false);}}
  async function saveCredential(e:FormEvent){e.preventDefault();if(!form)return;await run(async()=>{
    const body={...form,...(!form.api_key?{api_key:undefined}:{})};
    await api('/model-credentials'+(form.id?'/'+form.id:''),form.id?'PUT':'POST',body);setForm(null);await reload();notify('API Key 已保存；密钥不会回显');
  });}
  const valid=[defaults.onboarding,defaults.text,defaults.image,...Object.entries(defaults.stages||{}).filter(([id])=>id!=='summary').map(([,route])=>route)].every(v=>!v||!!v.credential_id&&!!v.model_id);
  const dirty=JSON.stringify(defaults)!==JSON.stringify(data.defaults.routes);
  useEffect(()=>{onDirty?.(dirty||!!form||!!manual);return()=>onDirty?.(false);},[dirty,!!form,!!manual,onDirty]);
  return <><div className="page-head"><div><span className="eyebrow">MODEL CONNECTIONS</span><h1>为每种对话，选择合适的模型</h1><p>管理 API Key 和模型目录，为内容分析、回答、辅助任务和群总结分别选择服务。</p></div><span className="hint">Key 在「API Key 管理」维护</span></div>
    <section className="panel model-defaults"><h2>默认模型</h2><p className="hint">各群可以继承默认值，也可以在「群管理」单独选择。切换默认模型会更新继承它的群配置版本。</p>{(['text','image'] as const).map(kind=><div className="model-route" key={kind}><div className="model-function-head"><h3>{names[kind]}</h3><label className="inline-check"><input type="checkbox" checked={defaults[kind]!==null} onChange={e=>setDefaults({...defaults,[kind]:e.target.checked?{credential_id:'',model_id:''}:null})}/>{kind==='text'?'指定默认文字模型':'指定默认生图模型'}</label></div>{defaults[kind]&&<Choice kind={kind} feature={kind==='image'?'image':'chat'} prefix={'默认'+names[kind]} data={data} value={defaults[kind]} onChange={v=>setDefaults({...defaults,[kind]:v||{credential_id:'',model_id:''}})}/>}{!defaults[kind]&&<p className="hint">{kind==='text'?'当前沿用未配置，停止调用。':'尚未设置默认生图服务。'}</p>}</div>)}<div className="model-stages"><h3>默认处理阶段模型</h3><p className="hint">未单独指定的阶段沿用默认文字模型；各群可再覆盖。仅改变对应任务的模型，不增加每条消息的必经调用次数。</p>{modelStages.map(stage=>{const selected=defaults.stages?.[stage.id];return <div className="model-route" key={stage.id}><div className="model-function-head"><h4>{stage.name}</h4><label className="inline-check"><input type="checkbox" checked={!!selected} onChange={e=>setDefaults({...defaults,stages:{...defaults.stages,[stage.id]:e.target.checked?{credential_id:'',model_id:''}:null}})}/>单独指定{stage.name}模型</label></div><p className="hint">{stage.description}</p>{selected?<Choice kind="text" feature={stage.id==='summary'?'summary':'chat'} prefix={'默认'+stage.name} data={data} value={selected} onChange={v=>setDefaults({...defaults,stages:{...defaults.stages,[stage.id]:v}})}/>:<p className="hint">沿用：{routeLabel(data,defaults.text,'未配置，停止调用')}</p>}</div>;})}</div><div className="model-route"><h3>新群接入配置助手</h3><p className="hint">只用于站点内根据需求推荐话题、人设、语言与参与设置，不负责服务器授权，不改变群聊天模型。使用当前机器人的已保存设置，不自动继承管理员的 Key 或模型；未配置时仍可手工接入。</p><Choice kind="text" feature="onboarding" prefix="新群接入助手" data={data} value={defaults.onboarding||null} onChange={onboarding=>setDefaults({...defaults,onboarding})}/></div><p className="hint">生图配置本次仅保存 Key 和模型，暂不启用群内生图或发图。</p>{dirty&&<p className="hint" role="status">有未保存的默认模型更改</p>}<button className="button primary" disabled={busy||!dirty||!valid} onClick={()=>void run(async()=>{await api('/model-defaults','PUT',{revision:data.defaults.revision,routes:defaults});await reload();notify('默认模型已保存；仅接入助手的变更不影响群聊天配置');})}>保存默认模型</button></section>
    <p className="hint">Key 的归属、完整密钥眼睛开关、公用申请与额度请在「API Key 管理」维护。</p>
  </>;
}
export {Choice as ModelChoice};
