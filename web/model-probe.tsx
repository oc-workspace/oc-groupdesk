import React,{useState} from 'react';
import {LoadingButton} from './loading';

type Target={key_id:string;model_id:string};
type Result=Target&{reachable:boolean;latency_ms:number;error?:string};
const identity=(t:Target)=>t.key_id+'\0'+t.model_id;

export function ModelProbe({keys,api}:{keys:any[];api:(path:string,method?:string,body?:unknown)=>Promise<any>}){
 const [selected,setSelected]=useState<Target[]>([]),[results,setResults]=useState<Result[]>([]),[checkedAt,setCheckedAt]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const eligible=keys.filter(k=>k.is_owner&&k.enabled&&!k.archived&&!k.secret_purged_at).map(k=>({...k,textModels:k.models.filter((m:any)=>m.capability==='text')})).filter(k=>k.textModels.length);
 const available=new Set(eligible.flatMap(k=>k.textModels.map((m:any)=>identity({key_id:k.id,model_id:m.model_id}))));
 const chosen=selected.filter(t=>available.has(identity(t)));
 const toggle=(target:Target)=>{setResults([]);setCheckedAt('');setError('');setSelected(current=>current.some(t=>identity(t)===identity(target))?current.filter(t=>identity(t)!==identity(target)):[...current,target]);};
 const check=async()=>{setBusy(true);setError('');setResults([]);try{const response=await api('/keys/probe','POST',{targets:chosen});setResults(response.results);setCheckedAt(response.checked_at);}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
 const ownKeys=keys.filter(k=>k.is_owner),activeKeys=ownKeys.filter(k=>k.enabled&&!k.archived&&!k.secret_purged_at);
 return <section id="model-probe" className="panel persona-panel model-probe" aria-label="模型可达性检测"><h2>模型可达性检测</h2><p className="hint">勾选自己的 Key 下要检测的文字模型，可跨多个 API。每个模型会发送一次短请求，计入站内用量和额度，服务商可能收费；成功表示实际返回了文字内容。检测前需先创建自己的机器人。</p>
  {!eligible.length&&<p role="status">{!ownKeys.length?'请先添加自己的 API Key。':!activeKeys.length?'请先启用自己的 API Key。':'请先在下方 Key 的「模型目录 / 登记模型」中查询或登记文字模型。'}</p>}
  {eligible.map(k=><div className="model-probe-group" key={k.id}><strong>{k.name} <small>· {k.client_type} · {k.base_url}</small></strong><div className="model-probe-choices">{k.textModels.map((m:any)=>{const target={key_id:k.id,model_id:m.model_id},id=identity(target),result=results.find(r=>identity(r)===id);return <label className="check-row" key={id}><input type="checkbox" checked={chosen.some(t=>identity(t)===id)} disabled={busy} onChange={()=>toggle(target)}/><span>{m.display_name||m.model_id}{m.display_name&&m.display_name!==m.model_id&&<small>（{m.model_id}）</small>}</span>{result&&<span className={result.reachable?'model-probe-ok':'model-probe-failed'}>{result.reachable?'可达':'失败'} · {result.latency_ms} ms{result.error&&' · '+result.error}</span>}</label>;})}</div></div>)}
  <div className="model-key-actions"><LoadingButton className="button primary" loading={busy} disabled={!chosen.length||chosen.length>20} onClick={()=>void check()}>检测已选 {chosen.length} 个模型</LoadingButton>{chosen.length>20&&<span role="alert">每次最多检测 20 个模型</span>}{checkedAt&&<span role="status">检测时间：{new Date(checkedAt).toLocaleString('zh-CN')}</span>}</div>{error&&<p className="form-error" role="alert">{error}</p>}
 </section>;
}
