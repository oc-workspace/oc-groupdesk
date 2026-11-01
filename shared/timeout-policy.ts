export type TimeoutPolicy={planner_seconds:number;request_seconds:number;direct_ttl_seconds:number};
export const timeoutDefaults:TimeoutPolicy={planner_seconds:300,request_seconds:310,direct_ttl_seconds:420};
export const timeoutLimits={planner_seconds:[30,600],request_seconds:[40,660],direct_ttl_seconds:[105,1800]} as const;
export function timeoutPolicyIssue(t:TimeoutPolicy):string{
 for(const [key,label] of [['planner_seconds','Planner 超时'],['request_seconds','接口请求超时'],['direct_ttl_seconds','点名请求总有效期']] as const){
  const [min,max]=timeoutLimits[key];
  if(!Number.isInteger(t[key])||t[key]<min||t[key]>max)return `${label}需填写 ${min}—${max} 秒的整数`;
 }
 if(t.request_seconds<t.planner_seconds+10)return '接口请求超时需比 Planner 超时至少多 10 秒';
 if(t.direct_ttl_seconds<t.request_seconds+65)return '点名请求总有效期需比接口请求超时至少多 65 秒，为回复生成和发送留出时间';
 return '';
}
