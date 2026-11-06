import React,{useEffect,useState} from 'react';
import {LoadingButton,LoadingStatus} from './loading';
import {ModelChoice,type ModelData} from './model-editors';
type Props={api:(path:string,method?:string,body?:unknown)=>Promise<any>;models:ModelData;blocked:boolean;onPersona:(id:string)=>Promise<void>;onMaterials:(id:string)=>Promise<void>;notify:(s:string,error?:boolean)=>void};
export function PersonaResources({api,models,blocked,onPersona,onMaterials,notify}:Props){
 const [data,setData]=useState<any>(null),[error,setError]=useState(''),[query,setQuery]=useState(''),[category,setCategory]=useState(''),[type,setType]=useState('');
 const [entry,setEntry]=useState<any>(null),[preview,setPreview]=useState<any>(null),[busy,setBusy]=useState(''),[result,setResult]=useState<any>(null);
 const [name,setName]=useState(''),[slug,setSlug]=useState(''),[kind,setKind]=useState('base'),[goal,setGoal]=useState(''),[variant,setVariant]=useState(false),[partial,setPartial]=useState(false),[generate,setGenerate]=useState(true),[model,setModel]=useState<any>(models.defaults.routes.text);
 async function load(){setError('');try{setData(await api('/persona-resources'));}catch(e){setError((e as Error).message);}}
 useEffect(()=>{void load();},[]);
 async function read(e:any,path?:string){setBusy('preview');setError('');setPreview(null);setResult(null);setEntry(e);
  try{const p=await api('/persona-resources/'+e.id+'/preview','POST',path?{path}:{});setPreview(p);setName(e.name);setSlug(e.id.slice(0,57).replace(/-$/,'')+'-style');setKind(e.resource_type==='reference'||!/SKILL\.md$/i.test(p.path)?'reference':'base');setGoal('');setVariant(false);setPartial(false);}
  catch(e){setError((e as Error).message);}finally{setBusy('');}
 }
 async function importSource(){setBusy('import');setError('');try{
  const r=await api('/persona-resources/'+entry.id+'/import','POST',{preview_id:preview.id,name,skill_name:slug,kind,goal,allow_variant:variant,allow_partial:partial,...(kind!=='reference'&&generate?{generation:model}:{})});
  setResult(r);await load();notify(r.generation_error|| (r.reused?'该来源已有存档；保留原有草稿和人工修改':r.persona_id?(r.generation?'来源已存档，AI 正在制作草稿；打开编辑器查看进度，校对发布后再应用到群':'初始化草稿已创建；打开编辑器制作完整草稿，校对发布后再应用到群'):'参考素材和数据集已存档，可在 Persona 编辑器中关联使用'),!!r.generation_error);
 }catch(e){setError((e as Error).message);}finally{setBusy('');}}
 if(!data)return <section className="panel persona-panel">{error?<p role="alert" className="form-error">{error}</p>:<LoadingStatus label="正在载入人设资源库…"/>}<button className="button" onClick={load}>重新加载</button></section>;
 const entries=data.entries.filter((e:any)=>(!category||e.category===category)&&(!type||e.resource_type===type)&&(e.name+' '+e.description+' '+e.repository).toLowerCase().includes(query.toLowerCase()));
 return <section className="persona-resource-library">
  <div className="panel persona-panel"><h2>人设资源库</h2><p>1. 浏览并读取来源　→　2. 按需导入本机器人　→　3. 制作与人工修订　→　4. 发布后在「群人设配置」应用</p><p className="hint">目录中的 {data.entries.length} 项资源不会自动加入基础 Persona。制作工具保存为参考素材；导入的人设只创建草稿，各机器人独立维护。本群的机器人称呼和点名配置始终优先。</p>
   <div className="policy-grid"><label>搜索资源<input value={query} onChange={e=>setQuery(e.target.value)} placeholder="人物、用途或仓库名称"/></label><label>分类<select value={category} onChange={e=>setCategory(e.target.value)}><option value="">全部分类</option>{[...new Set(data.entries.map((e:any)=>e.category))].map(c=><option key={String(c)}>{String(c)}</option>)}</select></label><label>资源类型<select value={type} onChange={e=>setType(e.target.value)}><option value="">全部类型</option><option value="persona">人设 / 表达框架</option><option value="reference">制作工具 / 参考方法</option></select></label></div>
   <small><a href={data.source} target="_blank" rel="noreferrer">目录来源</a> · 快照 {data.reviewed_at} · {data.commit.slice(0,8)}。目录许可不代表各项目许可；仅在读取来源时访问公开 GitHub。</small>
  </div>
  {blocked&&<p className="form-error" role="alert">当前 Persona 有未保存修订，请先回「Persona 技能」保存，再导入或打开其他草稿。</p>}
  {error&&<p className="form-error" role="alert">{error}</p>}
  {busy==='preview'&&<LoadingStatus label={'正在读取「'+entry.name+'」来源…'} detail="核对版本、Skill 文件和参考资料，请稍候。"/>}
  {preview&&<section className="panel persona-panel" aria-label="来源预览"><div className="persona-section-head"><div><h2>{entry.name} · 来源预览</h2><p>{preview.repository} · {preview.commit.slice(0,12)} · {preview.license}</p></div><button className="button" disabled={!!busy} onClick={()=>{setPreview(null);setResult(null);}}>关闭预览</button></div>
   <label>来源文件<select value={preview.path} disabled={!!busy} onChange={e=>void read(entry,e.target.value)}>{preview.choices.map((p:string)=><option key={p}>{p}</option>)}</select></label>
   <p className="hint">已读取 {preview.files.length} 个文本文件；版本与摘要随存档保留。只读取公开文本，来源中的脚本、命令和外部工具不会安装或执行。AI 制作会将这些参考文本发送至你选择的模型服务。</p>
   {preview.omitted.length>0&&<p className="form-error">有 {preview.omitted.length} 个参考文件超过读取上限，不会参与本次制作，可先保存参考素材，或明确选择仅按已读资料制作。未读取：{preview.omitted.join('、')}</p>}
   <details><summary>查看文本、许可与来源摘要</summary><small>SHA-256 {preview.sha256}</small>{preview.files.map((f:any)=><details key={f.path}><summary>{f.path} · {f.content.length} 字符</summary><pre className="persona-resource-source">{f.content}</pre></details>)}<p className="hint">许可未声明时，请在来源核对使用条件；导入和生成的草稿仍需人工审核。</p></details>
   {entry.similar.length>0&&<div className="persona-template-note"><strong>本机器人已有同类人设</strong>{entry.similar.map((p:any)=><button className="button small" key={p.id} disabled={blocked||!!busy} onClick={()=>onPersona(p.id)}>打开 {p.name}{p.archived?'（已归档）':''}</button>)}<p>不同来源不代表同一版本；创建新变体会独立维护，保留现有人设。</p></div>}
   {entry.imports.some((i:any)=>i.source_path===preview.path)?<div className="persona-job-status"><strong>这个来源已导入，现有内容不会被覆盖</strong>{entry.imports.filter((i:any)=>i.source_path===preview.path).map((i:any)=><button key={i.source_path} className="button" disabled={blocked||!!busy} onClick={()=>i.persona_id?onPersona(i.persona_id):onMaterials(i.collection_id)}>打开{ i.persona_id?'已有草稿':'参考素材'}</button>)}</div>:<>
    <fieldset disabled={!!busy||blocked}><label>导入方式<select value={kind} onChange={e=>setKind(e.target.value)}><option value="reference">仅保存参考素材与数据集</option>{entry.resource_type==='persona'&&/SKILL\.md$/i.test(preview.path)&&<><option value="base">制作基础 Persona 草稿</option><option value="feature">制作特色 Skill 草稿</option></>}</select></label>
    {kind!=='reference'&&<>{preview.omitted.length>0&&<label className="check-row"><input type="checkbox" checked={partial} onChange={e=>setPartial(e.target.checked)}/>仅按已读取的资料制作，缺失内容留待人工核对</label>}<div className="policy-grid"><label>人设名称<input value={name} maxLength={120} onChange={e=>setName(e.target.value)}/></label><label>唯一 Skill 名称<input value={slug} maxLength={64} pattern="[a-z0-9]+(-[a-z0-9]+)*" onChange={e=>setSlug(e.target.value)}/></label></div><label>制作目标<textarea value={goal} maxLength={3000} rows={3} placeholder="例如：提炼思考方式和语气，适合本群交流；不要扮称真人本人。" onChange={e=>setGoal(e.target.value)}/></label>
     {entry.similar.length>0&&<label className="check-row"><input type="checkbox" checked={variant} onChange={e=>setVariant(e.target.checked)}/>仍要创建独立变体，保留现有人设</label>}
     <label className="check-row"><input type="checkbox" checked={generate} onChange={e=>setGenerate(e.target.checked)}/>导入后使用 AI 制作完整草稿</label>{generate&&<ModelChoice kind="text" value={model} onChange={setModel} data={models} prefix="资源适配"/>}
    </>}
    <LoadingButton className="button primary" loading={busy==='import'} busyLabel="正在存档并准备草稿…" disabled={!name||!slug||kind!=='reference'&&(preview.omitted.length>0&&!partial||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)||entry.similar.length>0&&!variant||generate&&(!model?.credential_id||!model?.model_id))} onClick={importSource}>{kind==='reference'?'存为参考素材':generate?'导入并用 AI 制作草稿':'导入初始化草稿'}</LoadingButton></fieldset>
   </>}
   {result&&<div className="persona-job-status" role="status"><strong>{result.generation_error|| (result.reused?'已有来源存档，未覆盖原内容':result.generation?'来源已存档，AI 制作任务已提交':'来源已存档')}</strong><p>{result.persona_id?'打开编辑器查看制作进度、修订并发布。发布后，到「群人设配置」选择群并保存才会应用。':'到「素材与数据集」查看；可在现有或新建 Persona 中勾选这个数据集制作。'}</p><button className="button primary" disabled={blocked||!!busy} onClick={()=>result.persona_id?onPersona(result.persona_id):onMaterials(result.collection_id)}>{result.persona_id?'打开草稿编辑器':'查看参考素材'}</button></div>}
  </section>}
  <p className="hint">显示 {entries.length} / {data.entries.length} 项</p><div className="persona-list">{entries.map((e:any)=><article className="panel persona-tile" key={e.id}><strong>{e.name}</strong><small>{e.resource_type==='reference'?'制作工具 / 参考方法':'人设 / 表达框架'} · {e.category}</small><p>{e.description}</p><small>{e.imports.length?'已导入 '+e.imports.length+' 个来源文件':e.similar.length?'已有同类人设':'尚未导入'}</small><div className="model-key-actions"><LoadingButton className="button" loading={busy==='preview'&&entry?.id===e.id} disabled={!!busy} onClick={()=>read(e)}>读取来源</LoadingButton><a href={e.url} target="_blank" rel="noreferrer">查看 GitHub</a></div></article>)}</div>
 </section>;
}
