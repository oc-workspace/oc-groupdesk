import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {pool,transaction,audit} from '../server/db.js';
import {validateSkill} from '../server/persona-generation.js';

// Explicit operator action, not an automatic migration; never publish or bind.
const skill=await readFile(new URL('../skills/newcomer-welcome/SKILL.md',import.meta.url),'utf8');
validateSkill(skill,'newcomer-welcome');
const result=await transaction(async db=>{
 const id=randomUUID();
 const inserted=(await db.query("INSERT INTO personas(id,name,skill_name,description,goal,dataset_ids,draft_skill,draft_provenance,kind) VALUES($1,$2,'newcomer-welcome',$3,$4,'{}',$5,$6,'feature') ON CONFLICT(skill_name) DO NOTHING RETURNING id",[id,'从容迎新（待人工确认）','群友明确介绍新人后，随机等15—40秒再准备简短欢迎；与基础人设组合。','作为独立迎新特色；合并介绍、避免重复，语言和整体声音沿用群设置与基础人设。',skill,{method:'operator-authored feature draft',runtime_contract:'newcomer-welcome-v1',published:false}])).rows[0];
 if(inserted)await audit('operator','persona.welcome_draft_created',id,{},db);
 return {id:inserted?.id??(await db.query("SELECT id FROM personas WHERE skill_name='newcomer-welcome'")).rows[0].id,created:!!inserted};
});
console.log(JSON.stringify(result));await pool.end();
