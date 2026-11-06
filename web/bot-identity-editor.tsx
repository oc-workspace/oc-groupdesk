import React,{useEffect,useRef,useState} from 'react';
import type {IdentityPolicy} from '../server/identity';
import {resolveBotIdentity} from '../shared/bot-identity';
type Bot={id:string;name:string;wechat_id:string};
export function BotIdentityEditor({value,onChange,bot}:{value:IdentityPolicy;onChange:(v:IdentityPolicy)=>void;bot:Bot}){
 const names=value.mention_names,serialized=JSON.stringify(names),last=useRef(serialized),[text,setText]=useState((names||[]).join('\n'));
 useEffect(()=>{if(serialized!==last.current){last.current=serialized;setText((names||[]).join('\n'));}},[serialized]);
 const identity=resolveBotIdentity(bot,'',value),patch=(v:Partial<IdentityPolicy>)=>onChange({...value,...v,name_policy_version:1});
 const issue=names&&((names.length>12?'最多填写12个点名名称':names.some(n=>n.length>80)?'每个点名名称最多80个字符':new Set(names.map(n=>n.toLowerCase())).size!==names.length?'点名名称不能重复':''));
 return <div className="identity-settings bot-identity-settings"><h3>本群机器人称呼与点名</h3><p className="hint">当前机器人：{bot.name} · 微信号 {bot.wechat_id}。仅对本机器人在本群生效，不会修改微信昵称。</p>
 <div className="policy-grid"><label>本群机器人称呼<input maxLength={80} value={value.bot_name||''} placeholder={bot.name} onChange={e=>patch({bot_name:e.target.value})}/><small className="hint">用于自我介绍、被问名字；留空沿用机器人管理中的名称。</small></label><label>偏好的自称<input maxLength={40} value={value.self_reference||''} placeholder="留空时自然使用 我 / I / 私" onChange={e=>patch({self_reference:e.target.value})}/><small className="hint">例如“小T”；按回复语言自然表达，不要求每句话重复。</small></label></div>
 <label className="inline-check"><input type="checkbox" checked={names!==undefined} onChange={e=>{const next=e.target.checked?identity.mention_names:undefined;setText((next||[]).join('\n'));last.current=JSON.stringify(next);patch({mention_names:next});}}/>本群单独设置文字点名名称</label>
 {names!==undefined&&<label>文字点名名称（每行一个）<textarea rows={4} maxLength={1000} value={text} placeholder="Tatsumi\n小T" onChange={e=>{setText(e.target.value);const next=e.target.value.split('\n').map(n=>n.trim()).filter(Boolean);last.current=JSON.stringify(next);patch({mention_names:next});}}/><small className="hint">最多12个，每个最多80字；填写名称本身，无需加 @。按字面匹配，英文忽略大小写，支持空格和标点。</small></label>}
 <p className="hint">当前文字点名：{identity.mention_names.length?identity.mention_names.join('、'):'未设置（仅接受适配器已验证的点名或引用标记）'}。{names===undefined?'未单独设置时，沿用本群称呼、机器人管理名称及微信号。':''} 已验证的点名/引用标记仍有效。当前数据库通道中的普通“@昵称”也按本名单识别，请保留机器人实际使用的群昵称；点名后的回复仍遵守本群话题、语言与频率规则。</p>{issue&&<p role="alert" className="form-error">{issue}</p>}
 <p className="hint">Persona 只决定表达风格；本群称呼与自称优先于基础 Persona、特色 Skill 和旧回复中的名字。更改后点击“保存配置”，再手动刷新确认状态。</p></div>;
}
