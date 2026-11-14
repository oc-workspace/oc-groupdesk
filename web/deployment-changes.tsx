import React,{useEffect,useState} from 'react';
import type {Bot} from './bots';

type Change={id:string;source_host_id:string|null;target_host_id:string;kind:string;state:string;reason:string;created_at:string;verification:Record<string,boolean>};
type Request=(path:string,method?:string,body?:unknown)=>Promise<any>;
const checkNames={source_stopped:'源端微信已停止',data_verified:'数据和密钥已核验',target_ready:'目标容器与路由就绪',identity_verified:'微信账号身份已确认',reader_verified:'Reader 与 MaiBot 已验证',reply_still_paused:'发送仍保持暂停'} as const;
const stageNames:Record<string,string>={requested:'待管理员审批',approved:'现场核验',verifying:'待完成登记',completed:'已完成',cancelled:'已取消',failed:'失败'};

export function DeploymentChanges({bot,request,reload,notify,onClose,isSuper}:{bot:Bot;request:Request;reload:()=>Promise<void>;notify:(message:string,error?:boolean)=>void;onClose:()=>void;isSuper:boolean}){
 const [changes,setChanges]=useState<Change[]>([]),[hosts,setHosts]=useState<{id:string;name:string}[]>([]);
 const [currentHost,setCurrentHost]=useState(bot.host_label||''),[target,setTarget]=useState('rpi-groupdesk-01'),[kind,setKind]=useState<'host_move'|'same_host_upgrade'|'connection_config'>('host_move'),[reason,setReason]=useState(''),[busy,setBusy]=useState(false);
 const [checked,setChecked]=useState<Record<string,boolean>>({});
 async function load(){const [c,h]=await Promise.all([request('/bots/'+bot.id+'/deployment-changes'),request('/bot-deployment-hosts')]);setChanges(c.changes);setCurrentHost(c.current_host_id||'');setHosts(h.hosts);}
 useEffect(()=>{void load().catch(e=>notify((e as Error).message,true));},[bot.id]);
 const active=changes.find(c=>['requested','approved','verifying'].includes(c.state));
 async function act(path:string,body:unknown={}){setBusy(true);try{await request('/bots/'+bot.id+'/deployment-changes'+path,'POST',body);await load();await reload();notify('部署变更已更新；机器人仍保持暂停');}catch(e){notify((e as Error).message,true);}finally{setBusy(false);}}
 return <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-label="运行环境变更" style={{maxHeight:'85vh',overflow:'auto'}}>
  <h2>{bot.name} · 运行环境变更</h2><p className="hint">变更流程只登记和核验部署，不会自动登录微信或启用群回复。手机确认在目标设备上完成。</p>
  <p>当前登记位置：<code>{currentHost||'未登记'}</code> · 机器人：{botState(bot.state)}</p>
  {!active&&bot.state==='paused'&&<fieldset disabled={busy}><legend>发起变更</legend><label>变更类型<select value={kind} onChange={e=>{const next=e.target.value as typeof kind;setKind(next);setTarget(next==='host_move'?'rpi-groupdesk-01':currentHost);}}><option value="host_move">迁移运行主机</option><option value="same_host_upgrade">同机升级</option><option value="connection_config">连接配置调整</option></select></label><label>目标主机<select value={target} onChange={e=>setTarget(e.target.value)}>{hosts.map(h=><option key={h.id} value={h.id}>{h.name}（{h.id}）</option>)}</select></label><label>原因与影响<textarea value={reason} maxLength={1000} onChange={e=>setReason(e.target.value)}/></label><button className="button primary" disabled={reason.trim().length<10||(kind==='host_move'?target===currentHost:target!==currentHost)} onClick={()=>void act('',{kind,target_host_id:target,reason,revision:bot.revision})}>提交变更申请</button></fieldset>}
  {active&&<section className="panel"><h3>{stageNames[active.state]}</h3><p>{active.source_host_id||'未登记'} → {active.target_host_id}</p><p>{active.reason}</p>
   {active.state==='requested'&&isSuper&&<button className="button primary" disabled={busy} onClick={()=>void act('/'+active.id+'/approve')}>批准变更</button>}
   {active.state==='approved'&&isSuper&&<fieldset disabled={busy}><legend>现场核验</legend>{Object.entries(checkNames).map(([key,label])=><label key={key} className="check-row"><input type="checkbox" checked={!!checked[key]} onChange={e=>setChecked(v=>({...v,[key]:e.target.checked}))}/>{label}</label>)}<button className="button primary" disabled={!Object.keys(checkNames).every(k=>checked[k])} onClick={()=>void act('/'+active.id+'/verify',Object.fromEntries(Object.keys(checkNames).map(k=>[k,!!checked[k]])))}>保存核验结果</button></fieldset>}
   {active.state==='verifying'&&isSuper&&<button className="button primary" disabled={busy} onClick={()=>void act('/'+active.id+'/complete')}>完成主机登记</button>}
   {isSuper&&<><p className="hint">取消只撤销平台登记；现场容器和数据须按回退方案核对。</p><button className="button" disabled={busy} onClick={()=>void act('/'+active.id+'/cancel')}>取消变更</button></>}
  </section>}
  <h3>历史记录</h3>{changes.length===0?<p className="hint">暂无变更记录。</p>:<ul>{changes.map(c=><li key={c.id}>{new Date(c.created_at).toLocaleString('zh-CN',{timeZone:'Asia/Singapore'})} · {stageNames[c.state]||c.state} · {c.source_host_id||'未登记'} → {c.target_host_id}</li>)}</ul>}
  <div className="modal-actions"><button className="button" onClick={onClose}>关闭</button></div>
 </section></div>;
}
function botState(state:string){return state==='paused'?'已暂停':state==='active'?'运行中':state;}
