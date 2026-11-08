import {LoadingStatus,LoadingButton} from './loading';
import React from 'react';
import {onboardingSteps} from '../shared/group-onboarding';
const statusName:Record<string,string>={queued:'排队中',working:'处理中',succeeded:'已完成',failed:'需处理',cancelled:'已取消'};
export function OnboardingFlow({flow,activeJob,busy,action,onRefresh,onVerify,onGreeting,onViewTask,onOpenGroup,onRetry,onCancel}:{flow:any;activeJob:any;busy:boolean;action?:string;onRefresh:()=>void;onVerify:()=>void;onGreeting:()=>void;onViewTask:(id:string)=>void;onOpenGroup:()=>void;onRetry:()=>void;onCancel:()=>void}){
 const follow=(kind:string)=>flow.followups?.[kind]||(activeJob?.parent_id===flow.id&&activeJob.kind===kind?activeJob:null);
 const verify=follow('verify'),greeting=follow('greeting');
 const verified=verify?.status==='succeeded'&&verify.result?.wechat&&verify.result?.reader&&verify.result?.sender;
 const done=flow.ready;const waiting=['queued','working'].includes(flow.status)||(flow.status==='succeeded'&&!done);
 return <section className={'panel onboarding-panel onboarding-flow '+(done?'flow-complete':'')} aria-label="完整群接入流程">
  <div className="onboarding-flow-heading"><div><span className="eyebrow">当前接入流程 · 刷新后可继续</span><h2>3. 接入进度与后续操作</h2><p className="onboarding-flow-name">{flow.group?.name||'当前群'}</p></div><span className={'flow-status '+(done?'complete':'')}>{done?'必做步骤已完成':flow.error?'接入需处理':'接入进行中'}</span></div>
  <ol className="onboarding-required" aria-label="必须按顺序完成的步骤">
   <li className="done"><span className="flow-number">1</span><div><strong>选择已加入的微信群</strong><small>必做 · 已完成 · 不调用 AI</small></div></li>
   <li className="done"><span className="flow-number">2</span><div><strong>确认配置并提交接入</strong><small>必做 · 已完成 · 不调用 AI</small></div></li>
   <li className={done?'done':'current'} aria-current={done?undefined:'step'}><span className="flow-number">3</span><div><strong>等待绑定与机器人确认</strong><small>必做 · {done?'已完成':flow.error?'查看下方原因后继续':'系统执行中'} · 不调用 AI</small></div></li>
  </ol>
  {flow.group&&<p>本群{flow.group.enabled?'已启用':'保持停用'} · 已保存 v{flow.group.revision} / 机器人已应用 v{flow.group.applied_revision}</p>}
  {done?<p className="onboarding-success" role="status">接入必做流程已完成。下方 4、5、6 均为可选操作，无需全部点击。{!flow.group?.enabled?'本群当前保持停用，可在群管理按需启用。':''}</p>:<p role="status">{flow.status==='succeeded'?'读取与发送范围已绑定，等待机器人确认当前配置。':'系统会依次检查账号、绑定真实群、配置读取与发送范围。'}后台任务会继续执行；刷新页面可回到本流程。</p>}
  {flow.error&&<p className="form-error" role="alert">{flow.error}</p>}
  <div className="model-key-actions"><button className="button" disabled={busy} onClick={onRefresh}>刷新接入进度</button>{['failed','cancelled'].includes(flow.status)&&<button className="button primary" disabled={busy} onClick={onRetry}>继续 / 重试接入</button>}{flow.status==='queued'&&<button className="button" disabled={busy} onClick={onCancel}>取消接入排队</button>}</div>
  {waiting&&<LoadingStatus label={flow.status==='succeeded'?'等待机器人确认配置…':'正在检查并接入群…'} detail="后台任务进行中，当前显示最近一次读取的状态。"/>}
  {waiting&&<p className="hint">仅在任务进行中自动更新，完成后停止。关闭页面不会终止已提交任务。</p>}
  <details className="onboarding-execution"><summary>查看运行端自动执行细节</summary><ol className="onboarding-steps">{onboardingSteps.map(([id,name],i)=>{const index=onboardingSteps.findIndex(([s])=>s===(done?'ready':flow.stage));return <li key={id} className={i<=index?'done':''}>{name}</li>;})}</ol></details>
  <div className="onboarding-optional" aria-label="接入后的可选操作">
   <article><div className="flow-card-title"><span className="flow-number">4</span><div><h3>检查读取与发送</h3><span className="flow-optional-tag">可选 · 不调用 AI · 不发送消息</span></div></div><p>{verify?(verified?'最近检查正常。':verify.status==='succeeded'?'检查完成，部分连接待恢复。':statusName[verify.status]):'按需检查微信、读取服务和发送范围；不影响接入完成状态。'}</p>{verify?.status==='succeeded'&&<p className="hint">微信：{verify.result.wechat?'已连接':'待恢复'} · 读取：{verify.result.reader?'就绪':'待恢复'} · 发送范围：{verify.result.sender?'已配置':'待恢复'}</p>}<LoadingButton className="button" loading={(busy&&action==='verify')||['queued','working'].includes(verify?.status)} busyLabel="正在检查连接…" disabled={busy||!done} onClick={onVerify}>{verify?'重新检查连接':'检查连接（不发消息）'}</LoadingButton>{verify&&<button className="text-button" disabled={busy} onClick={()=>onViewTask(verify.id)}>查看检查记录</button>}</article>
   <article><div className="flow-card-title"><span className="flow-number">5</span><div><h3>发送入群问候</h3><span className="flow-optional-tag">可选 · 调用 AI · 实际发送一条消息</span></div></div><p>{greeting?(greeting.status==='succeeded'?'问候已确认发送，不会重复发送。':['queued','working'].includes(greeting.status)?'问候正在处理，可查看进度。':'问候尚未确认成功，请核对群聊和任务记录；不会自动重发。'):'沿用本群模型与人设生成问候，点击后仍需单独确认。'}</p>{!flow.group?.enabled&&<p className="hint">本群保持停用，启用后才能发送问候。</p>}{['queued','working'].includes(greeting?.status)&&<LoadingStatus label="问候任务正在处理…" detail="请查看已有任务，无需再次发送。"/>}{greeting?<button className="button" disabled={busy} onClick={()=>onViewTask(greeting.id)}>查看问候结果</button>:<button className="button" disabled={busy||!done||!flow.group?.enabled} onClick={onGreeting}>发送入群问候（需确认）</button>}</article>
   <article><div className="flow-card-title"><span className="flow-number">6</span><div><h3>进入群管理</h3><span className="flow-optional-tag">可选 · 后续维护</span></div></div><p>以后可继续调整话题、语言、人设和模型。无需现在操作，也不影响接入完成。</p><button className="button" disabled={busy} onClick={onOpenGroup}>打开本群管理</button></article>
  </div>
 </section>;
}
