import {useEffect,useState} from 'react';
import {deletionReasons} from '../shared/deletion';
import {DeleteRegistration} from './delete-registration';
import {LoadingButton,LoadingStatus} from './loading';
type Api=(p:string,m?:string,b?:unknown)=>Promise<any>;
const status:Record<string,string>={queued:'等待后台清理',processing:'正在清理',completed:'清理完成',partial:'完成，部分项目保留',failed:'未完成，可核对后重试'};
const actions:Record<string,string>={'user.account_deleted':'删除站点账号','bot.registration_deleted':'删除微信号登记','group.configuration_deleted':'删除群配置','cleanup.retained_group_deletion':'留存群删除记录','user.cleanup_requested':'提交彻底清理','user.cleanup_finished':'清理结束'};
const why=(v:string|null)=>v?(deletionReasons as Record<string,string>)[v]||v:'历史未填写';
export function DeletionHistory({api,notify,refresh}:{api:Api;notify:(s:string,error?:boolean)=>void;refresh:number}){
 const [data,setData]=useState<any>(null),[logs,setLogs]=useState<any[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState(''),[cleaning,setCleaning]=useState<string|null>(null);
 async function load(){setBusy(true);setError('');try{const [d,h]=await Promise.all([api('/users/deleted'),api('/users/deletion-history')]);setData(d);setLogs(h.logs);}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 useEffect(()=>{void load();},[refresh]);
 return <section className="panel persona-panel"><div className="page-head"><div><h2>已删除账号与数据清理</h2><p className="hint">先删除账号，再预览其独占数据并确认彻底清理。结果需手动刷新；账目与共享资源保留。</p></div><LoadingButton className="button" loading={busy} onClick={()=>void load()}>刷新删除与清理记录</LoadingButton></div>
 {error&&<p className="form-error" role="alert">{error}</p>}{!data&&!error&&<LoadingStatus label="正在读取删除和清理记录…"/>}
 {data&&<><p className="hint">显示最近 {data.limit} 个已删除账号；历史未填写的原因不会自动补成“测试号”。</p>{!data.users.length&&<p>暂无已删除账号。</p>}{data.users.map((u:any)=><div className="deletion-record" key={u.id}><strong>{u.display_name||u.github_login||u.username}</strong><small>{u.github_login?'GitHub: '+u.github_login:'本地账号: '+u.username} · {new Date(u.deleted_at).toLocaleString()} · 操作者 {u.deleted_by}</small><small>删除原因：{why(u.deletion_reason)}{u.deletion_note?' · '+u.deletion_note:''}</small><small>清理状态：{u.cleanup_status?status[u.cleanup_status]:'尚未提交清理'}</small>{u.cleanup_error&&<p className="form-error">{u.cleanup_error}</p>}{u.cleanup_items?.map((i:any)=><small key={i.kind+i.target_id}>{i.name} · {({pending:'等待',done:'已清理',skipped:'保留',failed:'未完成'} as Record<string,string>)[i.state]}：{i.message}</small>)}<button className="button danger-text" disabled={busy||['queued','processing'].includes(u.cleanup_status)} onClick={()=>setCleaning(u.id)}>预览独占数据清理</button></div>)}</>}
 <details><summary>删除与清理审计（最近150条）</summary>{logs.map(l=><div className="deletion-record" key={l.id}><strong>{actions[l.action]||l.action} · {l.details.target_name||l.target}</strong><small>{new Date(l.created_at).toLocaleString()} · {l.actor} · {l.details.reason_label||why(l.details.reason)}{l.details.status?' · '+(status[l.details.status]||l.details.status):''}</small>{l.details.reason_note&&<small className="deletion-history-note">{l.details.reason_note}</small>}</div>)}</details>
 {cleaning&&<DeleteRegistration endpoint={'/users/'+cleaning+'/cleanup'} mode="cleanup" request={api} onClose={()=>setCleaning(null)} onDeleted={async()=>{setCleaning(null);await load();notify('清理任务已排队，后台将再次核验并执行；请手动刷新查看结果与保留原因');}}/>}
 </section>;
}
