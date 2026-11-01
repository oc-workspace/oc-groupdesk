/** Operator-selected private IDs arrive on stdin, never in command-line arguments. */
import {readFile} from 'node:fs/promises';
import {z} from 'zod';
import {pool} from '../server/db.js';
import {migrateSpecialist} from '../server/persona-composition-migration.js';
try{
 const input=z.object({group_id:z.uuid(),expected_group_revision:z.number().int().positive(),source_version_id:z.uuid(),base_version_id:z.uuid()}).strict().parse(JSON.parse(await readFile('/dev/stdin','utf8')));
 const feature_skill=await readFile(new URL('../skills/gt-banter/SKILL.md',import.meta.url),'utf8');
 console.log(JSON.stringify(await migrateSpecialist({...input,feature_name:'GT 接梗特色',feature_skill_name:'gt-banter',feature_skill})));
}catch(e){console.error('组合迁移未完成；请核对群版本、原专项与同名特色，不自动覆盖其他配置');process.exitCode=1;}
finally{await pool.end();}
