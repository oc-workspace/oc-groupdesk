import React,{useEffect,useState} from 'react';
import {replyFrequencyDefaults,type ReplyFrequencyPolicy} from '../shared/reply-frequency';
export function ReplyFrequencySettings({request}:{request:(path:string,method?:string,body?:unknown)=>Promise<any>}){
 const [saved,setSaved]=useState<any>(null),[policy,setPolicy]=useState<ReplyFrequencyPolicy>(structuredClone(replyFrequencyDefaults)),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
 async function load(){const v=await request('/reply-frequency');setSaved(v);setPolicy(structuredClone(v.policy));}
 useEffect(()=>{void load().catch(()=>setMessage('回复频率读取失败，请刷新'));},[]);
 async function save(e:React.FormEvent){e.preventDefault();setBusy(true);setMessage('');try{await request('/reply-frequency','PUT',{revision:saved.revision,policy});await load();setMessage('已保存，等待机器人同步确认。');}catch(e){setMessage(e instanceof Error?e.message:'保存失败');}finally{setBusy(false);}}
 const pending=saved?.groups?.filter((g:any)=>g.enabled&&g.applied_revision!==saved.revision)||[];
 return <section className="panel" aria-label="全局回复频率与限流补答"><div className="panel-head"><h2>全局回复频率与限流补答</h2></div><form className="advanced-fields" onSubmit={save}>
 <p>同一机器人执行端的所有群共享下列滚动窗口，须同时满足每一项。窗口随时间逐条释放额度，不是在整点统一清零。正常互动、主动插话和恢复补答都计入额度。入场按处理任务计数，模型最终选择沉默也占一次；发送端另行限制实际发言次数。每日上限和 token 预算另行生效。</p>
 {policy.windows.map((w,i)=><fieldset key={i}><legend>频率窗口 {i+1}</legend><label>窗口 {i+1}：分钟<input type="number" min={1} max={1440} required value={w.minutes} onChange={e=>setPolicy({...policy,windows:policy.windows.map((v,n)=>n===i?{...v,minutes:Number(e.target.value)}:v)})}/></label><label>窗口 {i+1}：最多次数<input type="number" min={1} max={1000} required value={w.max_replies} onChange={e=>setPolicy({...policy,windows:policy.windows.map((v,n)=>n===i?{...v,max_replies:Number(e.target.value)}:v)})}/></label><button type="button" className="button" disabled={policy.windows.length===1} onClick={()=>setPolicy({...policy,windows:policy.windows.filter((_,n)=>n!==i)})}>删除窗口 {i+1}</button></fieldset>)}
 <button type="button" className="button" disabled={policy.windows.length>=4} onClick={()=>setPolicy({...policy,windows:[...policy.windows,{minutes:120,max_replies:72}]})}>添加频率窗口</button>
 <label className="inline-check"><input type="checkbox" checked={policy.catch_up.enabled} onChange={e=>setPolicy({...policy,catch_up:{...policy.catch_up,enabled:e.target.checked}})}/>允许限流后补答点名和连续跟进</label>
 <label>限流补答有效期（分钟）<input type="number" min={1} max={60} required disabled={!policy.catch_up.enabled} value={policy.catch_up.within_minutes} onChange={e=>setPolicy({...policy,catch_up:{...policy.catch_up,within_minutes:Number(e.target.value)}})}/></label>
 <p className="hint">有效期从原消息首次收到时计算，等待、生成和提交发送共用；重复催促不会重新计时。仅因上述滚动频率受限的点名和连续跟进可以等待，主动插话不补。额度允许后仍须通过群权限、人设版本、成员间隔、每日总量和 token 预算检查；到期或关闭补答即取消等待，不保证每条都能在时限内回答。连续回复轮数限制仍在各群设置。原有每日上限、模型并发和预算继续有效。</p>
 <p role="status">{saved?`频率配置 v${saved.revision} · ${pending.length?`等待 ${pending.map((g:any)=>g.name).join('、')} 确认`:'机器人已确认'}`:'正在读取配置…'}</p>
 <button className="button primary" disabled={busy||!saved}>保存回复频率</button><button type="button" className="button" disabled={busy} onClick={()=>void load().catch(()=>setMessage('刷新失败'))}>刷新频率确认状态</button>{message&&<p role="status">{message}</p>}
 </form></section>;
}
