import React,{useEffect,useRef,useState} from 'react';
import {ModelChoice,type ModelData,type Selection} from './model-editors';
import type {TopicDraft} from '../server/topic-drafting';
import type {TopicPolicy} from '../server/policies';
import './topic-ai-style.css';
type FormDraft={name?:string;description?:string;instructions?:string;color?:string;policy?:TopicPolicy};
type Props={value:FormDraft;models:ModelData;disabled:boolean;onApply:(draft:TopicDraft)=>void;onBusyChange:(busy:boolean)=>void;onInspect:(section:'rules'|'policy')=>void;
 api:(path:string,method?:string,body?:unknown,signal?:AbortSignal)=>Promise<any>};
export function TopicAIAssist({value,models,disabled,onApply,onBusyChange,onInspect,api}:Props){
 const [prompt,setPrompt]=useState(''),[selection,setSelection]=useState<Selection|null>(models.defaults.routes.text),[generating,setGenerating]=useState(false),[error,setError]=useState('');
 const [feedback,setFeedback]=useState<{name:string;terms:number;combinations:number;depth:string}|null>(null),[notice,setNotice]=useState('');
 const request=useRef<AbortController|null>(null),sequence=useRef(0),mounted=useRef(true),feedbackAnchor=useRef<HTMLDivElement|null>(null);
 const selectedKey=models.credentials.find(c=>c.id===selection?.credential_id),available=!!selectedKey?.enabled&&selectedKey.models.some(m=>m.model_id===selection?.model_id&&m.capability==='text');
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;sequence.current++;request.current?.abort();onBusyChange(false);};},[]);
 useEffect(()=>{if(feedback||error||notice)feedbackAnchor.current?.scrollIntoView({behavior:'smooth',block:'nearest'});},[feedback,error,notice]);
 function stop(){sequence.current++;request.current?.abort();setGenerating(false);onBusyChange(false);setNotice('已停止等待，原草稿保留。模型服务可能已开始处理。');}
 async function generate(){
  if(generating||disabled||!available||!selection?.model_id||prompt.trim().length<2)return;
  const current=++sequence.current,controller=new AbortController();request.current=controller;
  setGenerating(true);onBusyChange(true);setError('');setFeedback(null);setNotice('');
  const timeout=setTimeout(()=>controller.abort(),110000);
  try{
   const result=await api('/topics/draft','POST',{prompt:prompt.trim(),...selection,current_draft:{name:value.name||'',description:value.description||'',instructions:value.instructions||'',color:value.color||'violet',policy:value.policy||{}}},controller.signal);
   if(!mounted.current||sequence.current!==current)return;
   onApply(result.draft);setFeedback({name:result.draft.name,terms:result.summary.lexicon_terms,combinations:result.summary.combinations,depth:result.summary.reply_depth});
  }catch(e){if(mounted.current&&sequence.current===current)setError(controller.signal.aborted?'等待超时，原草稿已保留；请重试或选择其他模型。':(e as Error).message+' 原草稿保留，可继续人工填写。');}
  finally{clearTimeout(timeout);if(mounted.current&&sequence.current===current){setGenerating(false);onBusyChange(false);}}
 }
 return <section className="topic-ai-assist" aria-labelledby="topic-ai-title"><h3 id="topic-ai-title">一句话生成话题</h3><p className="hint">写下想聊什么，AI 会补齐名称、说明、回复规则和识别策略；也可以在现有草稿上继续完善。</p>
 <fieldset disabled={disabled||generating}><label>制作话题的 Prompt<textarea autoFocus rows={3} maxLength={6000} value={prompt} placeholder="例如：我想增加一个关于美食的话题" onChange={e=>setPrompt(e.target.value)}/></label>
 <ModelChoice kind="text" value={selection} onChange={setSelection} data={models} prefix="话题助填"/>
 <p className="hint">仅发送本次 Prompt 和当前话题草稿，会调用所选模型并可能产生费用。结果先填入下方表单，检查、编辑后再保存。</p><button type="button" className="button primary" disabled={prompt.trim().length<2||!available} onClick={()=>void generate()}>{generating?'AI 正在补齐…':'AI 帮我补齐话题'}</button></fieldset>
 {generating&&<div className="topic-ai-progress" role="status"><span>正在生成，完成后会自动填入表单…</span><button type="button" className="button small" onClick={stop}>停止等待</button></div>}
 <div ref={feedbackAnchor}>{error&&<p className="form-error" role="alert">{error}</p>}{notice&&<p className="hint" role="status">{notice}</p>}
 {feedback&&<div className="topic-ai-result" role="status"><strong>已填好「{feedback.name}」的草稿，尚未保存</strong><p>名称、说明和回复规则已填在下方；识别策略含 {feedback.terms} 个词条、{feedback.combinations} 条组合，讨论深度为{feedback.depth==='detailed'?'允许具体展开':'简短接话'}。</p><p>可以继续编辑；最后记得点击「保存话题」，保存后可在「话题库」查看详情。</p><div className="topic-ai-links"><button type="button" className="button small" onClick={()=>onInspect('rules')}>查看回复规则</button><button type="button" className="button small" onClick={()=>onInspect('policy')}>查看识别策略</button></div></div>}
 </div></section>;
}
