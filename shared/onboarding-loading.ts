type Job={kind:string;status:string;ready?:boolean;stage?:string};
export const onboardingActionLabels:Record<string,string>={refresh:'正在加载任务与配置…',discover:'正在提交微信群读取…',suggest:'AI 正在生成配置建议…',connect:'正在提交群接入…',verify:'正在提交连接检查…',greeting:'正在提交问候任务…'};
export function onboardingTaskLoading(job:Job|null|undefined,updating:boolean){
 if(!job)return null;
 const active=['queued','working'].includes(job.status),ack=job.kind==='connect'&&job.status==='succeeded'&&!job.ready;
 if(!active&&!ack)return null;
 if(!updating)return {active:false,label:'任务状态等待刷新',detail:'后台任务可能仍在继续。自动更新已暂停，请点击刷新查看最新结果，无需重复提交。'};
 const labels:Record<string,string>={discover:'正在读取微信群信息…',connect:'正在检查并接入群…',verify:'正在检查微信与读取连接…',greeting:'正在生成并处理问候…'};
 return {active:true,label:ack?'等待机器人确认配置…':job.status==='queued'?'任务已排队，等待运行端处理…':labels[job.kind]||'后台任务正在处理…',detail:'任务完成或失败后会停止加载。当前任务进行中会更新状态，请勿重复提交。'};
}
