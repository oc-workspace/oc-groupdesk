import {useEffect,useState} from 'react';
import {CheckCircle2,Clock3,RefreshCw} from 'lucide-react';
import {LoadingButton} from './loading';

export type RegistrationStatus='pending'|'approved'|'disabled'|'unavailable'|'unverified'|'loading'|'error';
export function useRegistrationStatus(){
 const [status,setStatus]=useState<RegistrationStatus>('loading'),[known,setKnown]=useState(false),[revision,setRevision]=useState(0);
 useEffect(()=>{
  const controller=new AbortController();
  void fetch('/api/auth/registration-status',{credentials:'same-origin',cache:'no-store',signal:controller.signal})
   .then(async r=>{if(!r.ok)throw Error('Unavailable');const d=await r.json();if(!['pending','approved','disabled','unavailable','unverified'].includes(d.status))throw Error('Invalid status');if(!controller.signal.aborted){setStatus(d.status);if(d.status!=='unverified')setKnown(true);}})
   .catch(()=>{if(!controller.signal.aborted)setStatus('error');});
  return()=>controller.abort();
 },[revision]);
 return {status,known,refresh:()=>{setStatus('loading');setRevision(v=>v+1);}};
}
const copy:Record<RegistrationStatus,{title:string;badge:string;body:string;next:string;hint:string}>={
 pending:{title:'等待管理员审核',badge:'待审核',body:'你的注册申请已提交，正在等待管理员审核。',next:'管理员处理后，点击「刷新审核状态」查看结果。',hint:'现在无需填写管理员账号和密码。'},
 approved:{title:'审核已通过',badge:'已通过',body:'管理员已通过你的注册申请。',next:'点击下方「使用 GitHub 登录，进入工作区」继续。',hint:'请继续使用提交申请时的 GitHub 账号登录。'},
 disabled:{title:'账号暂不可用',badge:'暂不可用',body:'当前账号已被停用或拒绝访问。',next:'请联系管理员确认准入状态。',hint:'管理员调整后，可手动刷新审核状态。'},
 unavailable:{title:'注册信息已失效',badge:'需重新确认',body:'原注册账号已删除或已不存在。',next:'请再次使用 GitHub 登录，按当前规则重新注册。',hint:'旧账号的权限和资料不会自动转给新账号。'},
 unverified:{title:'请重新确认审核状态',badge:'需确认',body:'此页面没有可核验的注册身份，无法确认最新审核结果。',next:'点击下方「使用 GitHub 确认审核结果」，重新验证身份。',hint:'管理员已通过时，完成 GitHub 登录即可进入工作区。'},
 loading:{title:'正在确认审核结果',badge:'查询中',body:'正在读取管理员最新的审核结果。',next:'请稍候，结果将在这里显示。',hint:'无需填写管理员账号和密码。'},
 error:{title:'暂时无法读取审核结果',badge:'查询未完成',body:'目前无法连接审核状态服务。',next:'请点击「刷新审核状态」重试，或使用 GitHub 登录确认。',hint:'本次查询失败不代表账号仍在等待审核。'},
};
export function RegistrationStatusNotice({status,onRefresh}:{status:RegistrationStatus;onRefresh:()=>void}){
 const c=copy[status],approved=status==='approved',Icon=approved?CheckCircle2:Clock3;
 return <section className={'login-review-notice'+(approved?' login-review-approved':'')} role="status" aria-live="polite" aria-atomic="true" aria-labelledby="login-review-title"><div className="login-review-icon" aria-hidden="true"><Icon size={26}/></div><div><span className="login-review-badge">{c.badge}</span><h3 id="login-review-title">{c.title}</h3><p>{c.body}</p><div className="login-review-next"><strong>下一步</strong><p>{c.next}</p></div><p className="login-review-hint">{c.hint}</p><LoadingButton type="button" className="button small login-review-refresh" loading={status==='loading'} onClick={onRefresh}><RefreshCw size={14}/>刷新审核状态</LoadingButton></div></section>;
}
