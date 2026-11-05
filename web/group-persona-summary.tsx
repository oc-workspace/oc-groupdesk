import React from 'react';
type Props={group:{persona_version_id?:string|null;persona_binding?:{name:string;version:number}|null;persona_features?:{name:string;version:number}[];policy:{persona:string}};onManage:()=>void};
export function GroupPersonaSummary({group,onManage}:Props){
 const base=group.persona_binding;
 return <section className="rule-card" aria-label="本群已保存的人设组合">
  <h4>基础 Persona（已保存）</h4>
  <p><strong>{base?`${base.name} · v${base.version}`:group.persona_version_id?'人设绑定信息暂不可用，请刷新配置':'尚未选择已发布的基础 Persona'}</strong></p>
  {!group.persona_version_id&&<p className="hint">当前沿用内置人设：{group.policy.persona==='neutral'?'中性自然表达':'GT Persona'}。可到群人设配置选择已发布的基础 Persona。</p>}
  <p>特色 Skill：{group.persona_features?.map(f=>`${f.name} · v${f.version}`).join('、')||'未选择'}</p>
  <p className="hint">人设统一在「Persona 制作 → 群人设配置」选择和应用。此处展示已保存的组合，是否生效请查看本群的机器人应用确认。</p>
  <button type="button" className="button" onClick={onManage}>前往本群人设配置</button>
 </section>;
}
