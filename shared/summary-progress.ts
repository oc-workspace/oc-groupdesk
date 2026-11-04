export function summaryProgressText(job:{status:string;progress?:Record<string,any>}){
 const p=job.progress||{},parts:string[]=[];
 if(job.status==='waiting_source'||job.status==='reading'&&!p.total_count)return '正在等待或统计本时段消息量';
 if(Number.isInteger(p.total_count))parts.push(`预检查 ${p.total_count.toLocaleString('zh-CN')} 条 · 正文 ${p.total_characters.toLocaleString('zh-CN')} 字符`);
 if(Number.isInteger(p.completed_batches))parts.push(`已读取 ${p.read_count||0}/${p.total_count} 条 · ${p.completed_batches}/${Math.max(p.completed_batches,p.planned_batches)} 批（计划值）`);
 if(p.strategy==='whole')parts.push(p.phase==='completed'?'全天材料已统一总结':'合并全天材料统一总结');
 if(p.strategy==='hierarchical')parts.push(`分段归纳 ${p.completed_model_batches||0}/${p.model_batches} · 最后统一合并跨时段话题`);
 if(p.phase==='reducing')parts.push(`正在合并中间归纳 · 第 ${p.merge_round} 轮`);
 if(p.phase==='merging')parts.push('正在生成全天最终总结');
 return parts.join('；');
}
