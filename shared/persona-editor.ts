export function isInitialPersonaDraft(skill:string){
 const body=skill.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/,'').trim();
 return /^# [^\r\n]+\r?\n\r?\n在这里编写适用场景、表达方式、语言和边界；也可以先关联素材，再生成待人工修订的草稿。$/.test(body);
}
export function refreshPersonaEditor<T extends {id:string;jobs:unknown[];versions:unknown[]}>(current:T,incoming:T,dirty:boolean):T{
 if(current.id!==incoming.id)return current;
 return dirty?{...current,jobs:incoming.jobs,versions:incoming.versions}:incoming;
}
