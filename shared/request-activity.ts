export type RequestActivity={id:number;label:string;botId?:string};
export function requestActivityLabel(path:string,method='GET'):string|null{
 if(/^\/persona-resources\/[^/]+\/preview$/.test(path))return '正在读取公开人设来源和参考资料…';
 if(/^\/persona-resources\/[^/]+\/import$/.test(path))return '正在存档来源并准备 Persona 草稿…';
 // Automatic onboarding job updates already have a persistent task indicator.
 if(method==='GET'&&/^\/group-onboarding\/jobs\//.test(path))return null;
 if(path==='/group-onboarding/suggest')return 'AI 正在生成配置建议…';
 if(path==='/topics/draft')return 'AI 正在完善话题草稿…';
 if(/^\/model-credentials\/[^/]+\/refresh$/.test(path))return '正在查询可用模型…';
 if(path==='/group-onboarding/discover')return '正在提交微信群读取任务…';
 if(path==='/group-onboarding/connect')return '正在提交新群接入…';
 if(/\/import$/.test(path))return '正在上传并整理素材…';
 if(/\/generate$/.test(path))return '正在提交 Persona 制作任务…';
 if(/\/analyze$/.test(path))return '正在提交 AI 分析任务…';
 if(path==='/summaries/jobs'&&method==='POST')return '正在提交群聊总结任务…';
 if(method==='GET')return '正在加载数据…';
 return method==='DELETE'?'正在处理删除请求…':'正在处理，请稍候…';
}
export function createRequestActivityStore(){
 let next=0,snapshot:readonly RequestActivity[]=[];const listeners=new Set<()=>void>();
 function publish(value:readonly RequestActivity[]){snapshot=value;for(const listener of [...listeners])listener();}
 const getSnapshot=()=>snapshot;
 return {getSnapshot,subscribe(listener:()=>void){listeners.add(listener);return()=>{listeners.delete(listener);};},
  begin(label:string|null,botId?:string){if(!label)return()=>{};const id=++next;publish([...snapshot,{id,label,botId}]);let finished=false;return()=>{if(finished)return;finished=true;publish(snapshot.filter(item=>item.id!==id));};},
  visible(botId:string){return snapshot.filter(item=>!item.botId||item.botId===botId);}};
}
export const requestActivity=createRequestActivityStore();
export async function trackRequest<T>(store:ReturnType<typeof createRequestActivityStore>,path:string,method:string,botId:string|undefined,request:()=>Promise<T>):Promise<T>{
 const end=store.begin(requestActivityLabel(path,method),botId);try{return await request();}finally{end();}
}
