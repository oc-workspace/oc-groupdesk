export const onboardingErrors:Record<string,string>={
 agent_offline:'接入运行端尚未就绪或暂时离线，请稍后刷新；已保存内容不会丢失。',
 needs_login:'微信尚未处于可发送的完整主界面。请打开该机器人的微信桌面，完成手机确认或展开窗口，使搜索框可见，再重试。',
 reader_unavailable:'聊天读取服务未就绪，请稍后重试；没有重新取钥或重启微信。',
 group_missing:'微信本地尚未同步到这个群，或群名称已经变化。请确认机器人已加入，再重新读取群列表。',
 duplicate_name:'微信本地有同名群，暂不能安全发送。请先在微信中区分群名称，再重新读取。',
 group_limit:'本机器人已达到当前最多10个接入群的上限。原有群未改动。',
 busy:'机器人仍有在途任务或待发送消息，请等回复结束后重试。',
 config_changed:'接入期间服务器配置有变化，已停止自动覆盖。请刷新后重试。',
 scope_mismatch:'账号、群标识或接入范围校验不一致，已停止接入。',
 source_expired:'群列表已过期，请重新读取后选择。',
 restart_failed:'服务重载未完成。新群保持停用，请重试接入以继续检查。',
 greeting_pending:'问候已交给正常回复队列，尚未确认送达。请检查群聊并刷新；不会自动重复发送。',
 greeting_failed:'本次问候未能完成，请查看群聊与运行记录；不会自动重发。',
 not_ready:'群尚未启用或机器人尚未确认当前配置，请先完成接入并刷新检查。',
 operation_failed:'接入任务暂未完成，群保持停用。请查看当前步骤后重试；不要重复创建同一个群。'
};
export const onboardingSteps=[['queued','等待运行端'],['preflight','检查账号与队列'],['binding','绑定真实群'],['reader','配置读取'],['sender','配置发送'],['runtime','更新本群连接'],['ack','等待机器人确认'],['ready','接入完成']] as const;

export type OnboardingTaskRef={id:string;kind:string;parent_id?:string|null;status?:string};
export function onboardingFlowId(job:OnboardingTaskRef|null|undefined){return job?.kind==='connect'?job.id:job&&['verify','greeting'].includes(job.kind)?job.parent_id||null:null;}
export function resumeOnboardingTask(saved:string|null,flows:OnboardingTaskRef[],jobs:OnboardingTaskRef[]){
 const selected=[...flows,...jobs].find(j=>j.id===saved);
 if(selected)return onboardingFlowId(selected)||selected.id;
 const active=jobs.find(j=>['queued','working'].includes(j.status||''));
 return active?(onboardingFlowId(active)||active.id):flows[0]?.id||(jobs[0]?(onboardingFlowId(jobs[0])||jobs[0].id):null);
}
