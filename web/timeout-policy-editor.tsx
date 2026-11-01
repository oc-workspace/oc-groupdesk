import React from 'react';
import {timeoutDefaults,timeoutLimits,timeoutPolicyIssue,type TimeoutPolicy} from '../shared/timeout-policy';
export function TimeoutPolicyEditor({value,onChange}:{value:TimeoutPolicy;onChange:(t:TimeoutPolicy)=>void}){
 const t=value||timeoutDefaults,issue=timeoutPolicyIssue(t);
 return <section className="policy-editor" aria-labelledby="timeout-policy-title"><h3 id="timeout-policy-title">模型等待与请求时效</h3>
 <p className="hint">仅作用于当前群。以下均以秒填写；保存群配置后，由机器人同步并确认。</p>
 <div className="policy-grid">{([['planner_seconds','Planner 超时'],['request_seconds','接口请求超时'],['direct_ttl_seconds','点名请求总有效期']] as const).map(([key,label])=><label key={key}>{label}（秒）<input type="number" step={1} min={timeoutLimits[key][0]} max={timeoutLimits[key][1]} value={t[key]||''} onChange={e=>onChange({...t,[key]:Number(e.target.value)})}/></label>)}</div>
 {issue?<p className="form-error" role="alert">{issue}</p>:<p className="hint">Planner 最多等待 {t.planner_seconds} 秒；接口最多等待 {t.request_seconds} 秒；点名请求从首次采集开始，排队与处理共用 {t.direct_ttl_seconds} 秒。</p>}
 <p className="hint">接口需比 Planner 至少多 10 秒；总有效期需比接口至少多 65 秒。排队会减少实际可用时间，重试和催促不会重新计时。超过两分钟的等待致歉、普通主动插话时效及共享并发限制继续按原规则执行。</p>
 <button type="button" className="button small" onClick={()=>onChange({...timeoutDefaults})}>恢复等待时间默认值</button></section>;
}
