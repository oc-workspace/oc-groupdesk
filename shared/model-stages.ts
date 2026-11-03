export const modelStageIds=['planner','replyer','fast_model','utils','summary'] as const;
export type ModelStage=typeof modelStageIds[number];
export const modelStages:ReadonlyArray<{id:ModelStage;name:string;description:string}>=[
  {id:'planner',name:'内容分析与规划',description:'理解当前内容，决定是否回复以及调用哪些工具；模型需支持工具调用。'},
  {id:'replyer',name:'回答生成',description:'生成最终文字回答；普通回复和长文共用此选择。'},
  {id:'fast_model',name:'快速辅助判断',description:'MaiBot 按需要使用的快速辅助任务，不是每条消息必调。'},
  {id:'utils',name:'信息提取与整理',description:'MaiBot 按需要使用的信息归纳等辅助文字任务。'},
  {id:'summary',name:'群总结',description:'群总结继承此选择；总结页面的单独模型仍优先。'}
];
