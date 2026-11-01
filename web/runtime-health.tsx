import React from 'react';
export type RuntimeHealth={state:string;wechat:boolean;bridge:boolean;maibot:boolean;reason:string;interval_seconds:number;actions:string[];memory_mib?:number;swap_mib?:number};
export function runtimeLabel(health:RuntimeHealth|null|undefined,at:string|null|undefined,now=Date.now()){
 if(!health||!at)return {label:'尚未收到微信巡检结果',ok:false};
 const age=now-Date.parse(at);
 if(!Number.isFinite(age)||age< -60000||age>4500000)return {label:'巡检结果已过期，在线状态待确认',ok:false};
 const labels:Record<string,string>={online:'微信与机器人连接正常',recovering:'正在尝试恢复',needs_phone:'需要手机确认或扫码',needs_unlock:'需要手机解除电脑端锁定',degraded:'服务异常，待恢复',maintenance:'已暂停，处于维护状态',offline:'微信或服务未连接'};
 return {label:labels[health.state]||'在线状态待确认',ok:health.state==='online'&&health.wechat&&health.bridge&&health.maibot};
}
export function RuntimeHealthPanel({health,at,now}:{health?:RuntimeHealth|null;at?:string|null;now:number}){
 const s=runtimeLabel(health,at,now);
 return <div className={'confirmation-panel '+(s.ok?'confirmed':'pending')} aria-label="微信在线巡检"><div><strong>{s.label}</strong><p>微信：{health?.wechat?'已连接':'待确认'} · 桥接：{health?.bridge?'已连接':'待确认'} · MaiBot：{health?.maibot?'运行中':'待确认'}</p><small>每小时巡检一次；{at?'最近巡检 '+new Date(at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'等待首次巡检'}。此状态与配置应用确认分别检查，页面需手动刷新。</small></div></div>;
}
