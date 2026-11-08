import {useEffect,useRef,useState} from 'react';
import {AlertTriangle,Trash2} from 'lucide-react';
import {LoadingButton,LoadingStatus} from './loading';
import './delete-registration.css';
type Request=(path:string,method?:string,body?:unknown)=>Promise<any>;
type Preview={kind:'bot'|'group'|'user';id:string;name:string;revision:number;confirmation:string;can_delete:boolean;reasons:string[];counts:Record<string,number>;effects:string[];scope?:string};
export function DeleteRegistration({endpoint,request,onClose,onDeleted}:{endpoint:string;request:Request;onClose:()=>void;onDeleted:(id:string)=>Promise<void>}){
 const [preview,setPreview]=useState<Preview|null>(null),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[confirmation,setConfirmation]=useState('');
 const lock=useRef(false);
 async function load(){setLoading(true);setError('');setConfirmation('');try{setPreview(await request(endpoint+'/deletion'));}catch(e){setError((e as Error).message);}finally{setLoading(false);}}
 useEffect(()=>{let current=true;void request(endpoint+'/deletion').then(p=>{if(current)setPreview(p);}).catch(e=>{if(current)setError(e.message);}).finally(()=>{if(current)setLoading(false);});return()=>{current=false;};},[endpoint,request]);
 async function remove(){if(!preview||!preview.can_delete||confirmation!==preview.confirmation||lock.current)return;lock.current=true;setBusy(true);setError('');try{await request(endpoint,'DELETE',{revision:preview.revision,confirmation});await onDeleted(preview.id);}catch(e){setError((e as Error).message);}finally{lock.current=false;setBusy(false);}}
 const title=endpoint.startsWith('/users/')?'删除站点账号':endpoint.startsWith('/groups/')?'删除群聊配置':'删除微信号登记';
 const labels:Record<string,string>={groups:'所属群',topics:'话题',personas:'人设',knowledge_bases:'知识库',schedules:'总结计划',members:'有效成员授权',owned_bots:'名下机器人',active_keys:'未归档Key',retained_keys:'保留Key账本',sessions:'登录会话',grants:'将撤销的授权'};
 return <div className="modal-backdrop"><section className="modal registration-delete" role="dialog" aria-modal="true" aria-label={title}>
  <h2><AlertTriangle size={22}/>{title}</h2>
  {loading&&<LoadingStatus label="正在检查删除影响与运行状态…"/>}
  {error&&<p className="form-error" role="alert">{error}</p>}
  {preview&&!loading&&<><p className="delete-target"><strong>{preview.name}</strong>{preview.scope&&<small>{preview.scope}</small>}</p><ul className="delete-effects">{preview.effects.map(effect=><li key={effect}>{effect}</li>)}</ul>
   {Object.keys(preview.counts).length>0&&<div className="delete-counts">{Object.entries(preview.counts).map(([key,n])=><span key={key}>{labels[key]||key}：{n}</span>)}</div>}
   {!preview.can_delete?<div className="delete-blockers" role="status"><strong>当前还不能删除</strong><ul>{preview.reasons.map(reason=><li key={reason}>{reason}</li>)}</ul></div>:<label>请完整输入{preview.kind==='user'?'账号':preview.kind==='bot'?'微信号':'群名'}确认：<strong>{preview.confirmation}</strong><input autoFocus value={confirmation} maxLength={120} autoComplete="off" spellCheck={false} disabled={busy} onChange={e=>setConfirmation(e.target.value)}/></label>}
  </>}
  <div className="modal-actions"><button className="button" disabled={busy} onClick={onClose}>取消</button><LoadingButton className="button" loading={loading} disabled={busy||loading} onClick={()=>void load()}>重新检查</LoadingButton><LoadingButton className="button delete-confirm" loading={busy} disabled={loading||busy||!preview?.can_delete||confirmation!==preview?.confirmation} onClick={()=>void remove()}><Trash2 size={16}/>确认删除</LoadingButton></div>
 </section></div>;
}
