import {LoadingStatus,LoadingButton} from './loading';
import React from 'react';
import {ModelChoice,type ModelData} from './model-editors';
import {isInitialPersonaDraft} from '../shared/persona-editor';

type Props={persona:any;busy:boolean;dirty:boolean;model:any;models:ModelData;onModelChange:(m:any)=>void;
 onGenerate:()=>void;onRefresh:()=>void;onAdopt:(skill:string)=>void};
const statuses:Record<string,string>={pending:'等待制作',processing:'正在制作',ready:'完整草稿已生成',failed:'制作失败',conflict:'制作结果待合并'};
export function PersonaGeneration({persona:p,busy,dirty,model,models,onModelChange,onGenerate,onRefresh,onAdopt}:Props){
 const active=p.jobs.some((j:any)=>['pending','processing'].includes(j.status)),latest=p.jobs[0];
 const placeholder=isInitialPersonaDraft(p.draft_skill);
 return <div className="persona-generation">
  <h3>从素材制作完整草稿</h3>
  <p className="hint">先选素材并填写目标，再选择模型制作，最后在下方校对完整 SKILL.md。保存设置只保存当前内容，不会自动生成。</p>
  {placeholder&&<p className="persona-template-note" role="status">当前编辑框是初始化模板。选中素材后，点击下方「制作完整草稿」才会生成完整内容。</p>}
  <ModelChoice feature="persona" kind="text" value={model} onChange={onModelChange} data={models} prefix="制作 Persona"/>
  <p className="hint">点击制作会保存当前设置，并把抽样正文和已有草稿发送给所选模型服务，可能产生费用。按素材库分层选取最多500条、共10万字符，参考资料保留独立篇幅；同库重叠筛选会合并。完整资料仍保留。单次模型请求最多4分钟，这是 Skill 归纳，不是模型微调。</p>
  <div className="model-key-actions">
   <LoadingButton type="button" className="button primary" loading={active} disabled={busy||active||p.archived||!model?.credential_id||!model?.model_id||!p.dataset_ids.length} onClick={onGenerate}>{busy?'正在处理…':active?'完整草稿制作中':dirty?'保存设置并制作完整草稿':'制作完整草稿'}</LoadingButton>
   <button type="button" className="button" disabled={busy} onClick={onRefresh}>查看制作进度 / 载入结果</button>
  </div>
  {active&&<LoadingStatus label={latest?.status==='pending'?'Persona 制作已排队…':'AI 正在制作完整 Persona 草稿…'} detail="这是最近一次查看的任务状态。后台继续处理，请手动查看制作进度；无需重复提交。"/>}
  {latest&&<div className="persona-job-status" role="status" aria-live="polite">
   <strong>{statuses[latest.status]||latest.status}</strong>
   {['pending','processing'].includes(latest.status)&&<p>任务已提交。稍后点击「查看制作进度 / 载入结果」，无需重复制作。</p>}
   {latest.status==='ready'&&<p>{p.draft_skill===latest.output_skill?'下方 SKILL.md 编辑框已显示制作结果，可以继续修改。':'完整结果已保存在服务器。点击「查看制作进度 / 载入结果」载入；未保存的人工编辑会保留。'}</p>}
   {latest.error&&<p>{latest.error}</p>}
  </div>}
  {p.jobs.map((j:any,i:number)=><details key={j.id} className="persona-job" open={i===0&&!!(j.output_skill||j.error)}>
   <summary>{statuses[j.status]||j.status} · {j.model_id} · {new Date(j.created_at).toLocaleString('zh-CN',{timeZone:'Asia/Singapore'})}</summary>
   {j.error&&<p>{j.error}</p>}<p className="hint">合并后匹配 {j.provenance.total_records} 条 · 可读正文 {j.provenance.eligible_records} 条 · 使用 {j.provenance.sampled_records} 条 / {j.provenance.sampled_characters} 字符</p>
   {j.output_skill&&<><label>完整制作结果<textarea readOnly rows={12} value={j.output_skill}/></label><button type="button" className="button" disabled={busy||dirty||p.archived} onClick={()=>onAdopt(j.output_skill)}>将此结果放入编辑框</button>{dirty&&<p className="hint">当前有未保存编辑，请先保留或保存，再采用此结果。</p>}</>}
  </details>)}
 </div>;
}
