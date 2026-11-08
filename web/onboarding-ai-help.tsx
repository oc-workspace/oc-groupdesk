import {useEffect,useRef,useState} from 'react';
import {ArrowLeft,KeyRound,Settings2} from 'lucide-react';
import {KeyVault} from './key-vault';
import {Models,type ModelData} from './model-editors';
import {LoadingButton,LoadingStatus} from './loading';
import {usePermission} from './session';
import './onboarding-ai-help.css';

type Api=(path:string,method?:string,body?:unknown)=>Promise<any>;
export type ModelSetupView='mine'|'site'|'models';
export function AIUseBadge({kind='none'}:{kind?:'none'|'setup'|'call'}){
 return <span className={'onboarding-ai-badge '+kind}>{kind==='call'?'调用 AI':kind==='setup'?'仅配置 · 不调用 AI':'不调用 AI'}</span>;
}
export function ModelSetupGuide({purpose,onOpen,disabled=false}:{purpose:'bot'|'group';onOpen:(view:ModelSetupView)=>void;disabled?:boolean}){
 const allowed=usePermission('models.manage');
 return <div className="onboarding-model-guide"><strong>{purpose==='bot'?'启用前，准备 Key 和默认文字模型':'使用 AI 配置建议前，准备 Key 和助手模型'}</strong><ol><li>添加自己的 Key；或在「站点公用 Key」申请，等待管理员授权。</li><li>查询模型目录或手动登记模型，然后选择 Key 和具体模型并保存。</li><li>{purpose==='bot'?'设置本机器人的默认文字模型，供启用后的群回复使用。':'设置「新群接入配置助手」，或在下方选择本次助手模型。群回复使用本群的文字/阶段配置。'}</li></ol><p>新增 Key 或获批授权不会自动选中模型，也不会自动使用管理员的私有 Key。{purpose==='group'?'只授权「群回复」不等于授权「新群接入助手」。':'模型配置与接入检查本身不试调用模型；启用后的聊天回复等才会消耗所选 Key 的额度。'}</p><div className="model-key-actions"><button type="button" className="button small" disabled={disabled||!allowed} onClick={()=>onOpen('mine')}><KeyRound size={14}/>添加自己的 Key</button><button type="button" className="button small" disabled={disabled||!allowed} onClick={()=>onOpen('site')}>申请公用 Key</button><button type="button" className="button small" disabled={disabled||!allowed} onClick={()=>onOpen('models')}><Settings2 size={14}/>配置当前机器人模型</button></div>{!allowed&&<p className="hint">当前账号没有模型与 Key 管理权限，请联系管理员开放权限或协助配置。</p>}</div>;
}
export function OnboardingModelSetup({botId,botName,purpose,initialView,api,onClose,notify}:{botId:string;botName:string;purpose:'bot'|'group';initialView:ModelSetupView;api:Api;onClose:(models:ModelData|null)=>Promise<void>;notify:(message:string,error?:boolean)=>void}){
 const [view,setView]=useState(initialView),[models,setModels]=useState<ModelData|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[dirty,setDirty]=useState(false);
 const anchor=useRef<HTMLElement>(null);
 const loadModels=async()=>{const value=await api('/models');setModels(value);return value as ModelData;};
 useEffect(()=>{if(view==='models'&&!models)void loadModels().catch(e=>setError(e.message));anchor.current?.scrollIntoView({block:'start'});},[view]);
 const discard=()=>!dirty||window.confirm('本页还有未保存的 Key、授权申请或模型设置，离开会丢弃这些修改。原接入配置仍会保留，继续吗？');
 async function finish(){if(busy||!discard())return;setBusy(true);setError('');let current=models;try{current=await loadModels();}catch(e){notify('模型状态暂未刷新：'+(e as Error).message,true);}try{await onClose(current);}finally{setBusy(false);}}
 return <section className="onboarding-model-setup" ref={anchor} aria-label="接入流程中的 Key 与模型设置"><div className="onboarding-setup-return"><div><strong>正在配置：{botName}</strong><p>原接入步骤和未提交的新群配置已保留。请先保存这里的设置，再返回继续。模型仅能使用机器人所有人的 Key 或已获授权的公用 Key。</p></div><LoadingButton type="button" className="button" loading={busy} onClick={()=>void finish()}><ArrowLeft size={15}/>返回接入流程</LoadingButton></div><div className="model-key-actions">{([['mine','自己的 Key'],['site','申请公用 Key'],['models','配置机器人模型']] as const).map(([id,label])=><button type="button" className={'button '+(view===id?'primary':'')} disabled={busy} key={id} onClick={()=>{if(id!==view&&discard()){setDirty(false);setView(id);setError('');}}}>{label}</button>)}</div>{error&&<p className="form-error" role="alert">{error}<button className="button small" onClick={()=>void loadModels().then(()=>setError('')).catch(e=>setError(e.message))}>重新读取模型配置</button></p>}{view==='site'&&<p className="onboarding-setup-tip">选择公用 Key 后点击「申请使用」，等待管理员批准。{purpose==='group'?'本次 AI 配置建议需要「新群接入助手」授权；如也用于聊天，请另外申请「群回复」。':'机器人启用与聊天需要「群回复」授权。'}若没有可申请的公用 Key，请联系管理员提供。获批后仍需选择 Key＋模型并保存。</p>}{view==='mine'&&<p className="onboarding-setup-tip">Key 保存后，请打开「模型目录 / 登记模型」，再到「配置机器人模型」选择 Key 和模型；仅添加 Key 不会自动开始调用。</p>}{view==='models'?models?<Models key="models" data={models} api={api} reload={async()=>{await loadModels();}} notify={notify} onDirty={setDirty}/>:!error&&<LoadingStatus label="正在读取当前机器人的模型配置…"/>:<KeyVault key={view} api={api} notify={notify} onChanged={async()=>{setModels(null);}} initialTab={view} startWithAdd={view==='mine'} requestBotId={botId} requestFeatures={purpose==='group'?['onboarding']:['chat']} onDirty={setDirty}/>}</section>;
}
