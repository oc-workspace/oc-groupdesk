import {useEffect,useRef,useState} from 'react';
import {AlertTriangle,Trash2} from 'lucide-react';
import {deletionReasons} from '../shared/deletion';
import {LoadingButton,LoadingStatus} from './loading';
import './delete-registration.css';
type Request=(path:string,method?:string,body?:unknown)=>Promise<any>;
type Preview={kind:'bot'|'group'|'user';id:string;name:string;revision:number;confirmation:string;can_delete:boolean;reasons:string[];counts:Record<string,number>;effects:string[];scope?:string;plan_hash?:string;items?:{kind:string;id:string;name:string;eligible:boolean;message:string}[]};
export function DeleteRegistration({endpoint,request,onClose,onDeleted,mode='delete'}:{endpoint:string;mode?:'delete'|'cleanup';request:Request;onClose:()=>void;onDeleted:(id:string)=>Promise<void>}){
 const [preview,setPreview]=useState<Preview|null>(null),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[confirmation,setConfirmation]=useState('');
 const lock=useRef(false);const [reason,setReason]=useState(''),[note,setNote]=useState('');const reasonValid=Object.hasOwn(deletionReasons,reason)&&(reason!=='other'||note.trim().length>0);
 const previewPath=endpoint+(mode==='cleanup'?'/preview':'/deletion');
 async function load(){setLoading(true);setError('');setConfirmation('');try{setPreview(await request(previewPath));}catch(e){setError((e as Error).message);}finally{setLoading(false);}}
 useEffect(()=>{let current=true;void request(previewPath).then(p=>{if(current)setPreview(p);}).catch(e=>{if(current)setError(e.message);}).finally(()=>{if(current)setLoading(false);});return()=>{current=false;};},[previewPath,request]);
 async function remove(){if(!preview||!preview.can_delete||confirmation!==preview.confirmation||!reasonValid||lock.current)return;lock.current=true;setBusy(true);setError('');try{await request(endpoint,mode==='cleanup'?'POST':'DELETE',{revision:preview.revision,confirmation,reason,reason_note:note,...(mode==='cleanup'?{plan_hash:preview.plan_hash}:{})});await onDeleted(preview.id);}catch(e){setError((e as Error).message);}finally{lock.current=false;setBusy(false);}}
 const title=mode==='cleanup'?'彻底清理独占数据':endpoint.startsWith('/users/')?'删除站点账号':endpoint.startsWith('/groups/')?'删除群聊配置':'删除微信号登记';
 const labels:Record<string,string>={groups:'所属群',topics:'话题',personas:'人设',knowledge_bases:'知识库',schedules:'总结计划',members:'有效成员授权',owned_bots:'名下机器人',active_keys:'未归档Key',retained_keys:'保留Key账本',sessions:'登录会话',grants:'将撤销的授权',cleanup_bots:'可清理业务空间',cleanup_keys:'可清除私有Key密文',retained:'保留项目'};
 return <div className="modal-backdrop"><section className="modal registration-delete" role="dialog" aria-modal="true" aria-label={title}>
  <h2><AlertTriangle size={22}/>{title}</h2>
  {loading&&<LoadingStatus label="正在检查删除影响与运行状态…"/>}
  {error&&<p className="form-error" role="alert">{error}</p>}
  {preview&&!loading&&<><p className="delete-target"><strong>{preview.name}</strong>{preview.scope&&<small>{preview.scope}</small>}</p><ul className="delete-effects">{preview.effects.map(effect=><li key={effect}>{effect}</li>)}</ul>
   {Object.keys(preview.counts).length>0&&<div className="delete-counts">{Object.entries(preview.counts).map(([key,n])=><span key={key}>{labels[key]||key}：{n}</span>)}</div>}
   {preview.items&&<div className="cleanup-preview-items">{preview.items.map(i=><div key={i.kind+i.id}><strong>{i.name}</strong><small>{i.eligible?'将清理':'保留'}：{i.message}</small></div>)}</div>}
   {preview.can_delete&&<><label>删除 / 清理原因（必选）<select aria-label="删除原因" value={reason} disabled={busy} onChange={e=>setReason(e.target.value)}><option value="">请选择原因</option>{Object.entries(deletionReasons).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label><label>补充说明{reason==='other'?'（必填）':'（可选）'}<textarea aria-label="删除原因补充说明" maxLength={500} value={note} disabled={busy} onChange={e=>setNote(e.target.value)} placeholder="用于日后查看删除日志，请勿填写密码或 Key"/></label></>}
   {!preview.can_delete?<div className="delete-blockers" role="status"><strong>当前还不能删除</strong><ul>{preview.reasons.map(reason=><li key={reason}>{reason}</li>)}</ul></div>:<label>请完整输入{preview.kind==='user'?'账号':preview.kind==='bot'?'微信号':'群名'}确认：<strong>{preview.confirmation}</strong><input autoFocus value={confirmation} maxLength={120} autoComplete="off" spellCheck={false} disabled={busy} onChange={e=>setConfirmation(e.target.value)}/></label>}
  </>}
  <div className="modal-actions"><button className="button" disabled={busy} onClick={onClose}>取消</button><LoadingButton className="button" loading={loading} disabled={busy||loading} onClick={()=>void load()}>重新检查</LoadingButton><LoadingButton className="button delete-confirm" loading={busy} disabled={loading||busy||!preview?.can_delete||confirmation!==preview?.confirmation||!reasonValid} onClick={()=>void remove()}><Trash2 size={16}/>{mode==='cleanup'?'确认彻底清理':'确认删除'}</LoadingButton></div>
 </section></div>;
}
