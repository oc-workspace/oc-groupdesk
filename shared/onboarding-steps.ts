export type SetupStep={number:number;status:string};
// Keep the persisted eight-step contract; combine only the presentation.
export function onboardingGroups(steps:SetupStep[]){
 return [
  {number:1,title:'交给 AI 安装',steps:[1,2]},
  {number:2,title:'登录并连接',steps:[3,4,5]},
  {number:3,title:'设置模型并启用',steps:[6,7]}
 ].map(group=>({...group,complete:group.steps.every(n=>steps.some(s=>s.number===n&&s.status==='complete'))}));
}
