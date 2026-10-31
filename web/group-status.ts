export type GroupStatus={
  id:string;revision:number;applied_revision:number;bot_seen_at:string|null;enabled:boolean
};
export type StatusMap=Record<string,GroupStatus>;
export type Confirmation={kind:'confirmed'|'pending'|'offline'|'changed'|'checking';label:string};

export function mergeStatuses(previous:StatusMap,incoming:readonly GroupStatus[]):StatusMap{
  const merged={...previous};
  for(const value of incoming){
    const next:GroupStatus={id:value.id,revision:value.revision,applied_revision:value.applied_revision,bot_seen_at:value.bot_seen_at,enabled:value.enabled};
    const old=merged[next.id];
    if(old&&next.revision<old.revision)continue;
    if(old&&next.revision===old.revision){
      next.applied_revision=Math.max(old.applied_revision,next.applied_revision);
      if(old.bot_seen_at&&(!next.bot_seen_at||Date.parse(old.bot_seen_at)>Date.parse(next.bot_seen_at)))next.bot_seen_at=old.bot_seen_at;
    }
    merged[next.id]=next;
  }
  return merged;
}
export function confirmationFor(savedRevision:number,status:GroupStatus|undefined,now=Date.now()):Confirmation{
  if(!status||status.revision<savedRevision)return {kind:'checking',label:'正在检查机器人状态'};
  if(status.revision>savedRevision)return {kind:'changed',label:'服务器配置已更新至 v'+status.revision};
  if(status.applied_revision!==savedRevision||!status.bot_seen_at)return {kind:'pending',label:'等待机器人应用'};
  const seen=Date.parse(status.bot_seen_at);
  if(!Number.isFinite(seen)||seen>now+60000)return {kind:'checking',label:'确认时间异常，请刷新状态'};
  if(now-seen>=180000)return {kind:'offline',label:'版本已确认，机器人连接待检查'};
  return {kind:'confirmed',label:'机器人已确认'};
}
