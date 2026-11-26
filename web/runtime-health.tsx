import React from 'react';
export type RuntimeHealth={state:string;wechat:boolean;bridge:boolean;maibot:boolean;reason:string;interval_seconds:number;actions:string[];notification_configured?:boolean;notification_pending?:boolean;memory_mib?:number;swap_mib?:number};
export function runtimeLabel(health:RuntimeHealth|null|undefined,at:string|null|undefined,now=Date.now()){
 if(!health||!at)return {label:'尚未收到微信巡检结果',ok:false};
 const age=now-Date.parse(at);
 if(!Number.isFinite(age)||age< -60000||age>4500000)return {label:'巡检结果已过期，在线状态待确认',ok:false};
 const labels:Record<string,string>={online:'微信与机器人连接正常',recovering:'正在尝试恢复',needs_phone:'需要手机确认或扫码',needs_unlock:'需要手机解除电脑端锁定',degraded:'服务异常，待恢复',maintenance:'已暂停，处于维护状态',offline:'微信或服务未连接'};
 return {label:labels[health.state]||'在线状态待确认',ok:health.state==='online'&&health.wechat&&health.bridge&&health.maibot};
}
export function RuntimeHealthPanel({health,at,now}:{health?:RuntimeHealth|null;at?:string|null;now:number}){
 const s=runtimeLabel(health,at,now);
 return <div className={'confirmation-panel '+(s.ok?'confirmed':'pending')} aria-label="微信在线巡检"><div><strong>{s.label}</strong><p>微信：{health?.wechat?'已连接':'待确认'} · 桥接：{health?.bridge?'已连接':'待确认'} · MaiBot：{health?.maibot?'运行中':'待确认'}</p><small>每小时巡检一次；{at?'最近巡检 '+new Date(at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'等待首次巡检'}。此状态与配置应用确认分别检查，页面需手动刷新。</small><p>微信告警：{health?.notification_pending?'推送待重试':health?.notification_configured?'已配置独立通道':'待配置或待确认，请到系统设置完成'}</p></div></div>;
}

export type RuntimeRequest={id:string;stage:string;reason?:string|null;received_at:number;updated_at:number};
export const requestStageLabels:Record<string,string>={
 queued:'排队中',deferred:'等待补答',waiting_model:'等待模型',processing:'处理中',
 planner:'分析与检索中',replyer:'生成回答中',utils:'辅助处理中',fast_model:'生成回答中',
 generation_retry:'准备重新生成',failed_attempt:'调用失败',sending:'微信发送中',sent:'已送达',
 failed:'回复失败',expired:'已过期',uncertain:'发送待核实',idle_released:'未参与',paused:'已暂停'
};
export function RequestStatusPanel({requests,at,now}:{requests?:RuntimeRequest[];at?:string|null;now:number}){
 if(!requests?.length)return null;
 const stale=!at||now-Date.parse(at)>180000;
 return <section className="confirmation-panel pending" aria-label="近期回复进度"><div>
  <strong>近期回复进度{stale?' · 状态待刷新':''}</strong>
  <p>最近十条请求，按首次收到时间排列。点击下方“刷新确认状态”查看最新进度。</p>
  <ul>{requests.map(item=><li key={item.id}>
   {new Date(item.received_at*1000).toLocaleTimeString('zh-CN',{timeZone:'Asia/Singapore',hour12:false})}
   {' · '}{requestStageLabels[item.stage]||'处理中'}
   {['model_failed','no_reply'].includes(item.reason||'')?' · 未能完成回答':''}
  </li>)}</ul>
 </div></section>;
}
