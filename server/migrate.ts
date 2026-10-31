import {readFile,readdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {pool,transaction} from './db.js';
import {passwordHash} from './security.js';

export async function migrate(){
  await transaction(async db=>{
    await db.query("SELECT pg_advisory_xact_lock(78511942)");
    await db.query('CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const files=(await readdir(new URL('../migrations/',import.meta.url))).filter(f=>f.endsWith('.sql')).sort();
    for(const name of files){
      if((await db.query('SELECT 1 FROM schema_migrations WHERE name=$1',[name])).rowCount)continue;
      await db.query(await readFile(new URL('../migrations/'+name,import.meta.url),'utf8'));
      await db.query('INSERT INTO schema_migrations(name) VALUES($1)',[name]);
    }
    if(!(await db.query('SELECT 1 FROM admins LIMIT 1')).rowCount){
      const password=process.env.ADMIN_PASSWORD;
      if(!password||password.length<16)throw new Error('ADMIN_PASSWORD must contain at least 16 characters for initial setup');
      await db.query('INSERT INTO admins(id,username,password_hash) VALUES($1,$2,$3)',[randomUUID(),process.env.ADMIN_USERNAME||'admin',passwordHash(password)]);
      const topicData=[
        ['外语交流','练习英语、日语等外语表达，讨论学习方法。','根据成员水平解释，纠错温和，提供自然表达。','blue'],
        ['创业经营','讨论产品、经营、团队与商业经验。','区分事实与个人观点，提供具体可执行的分析。','violet'],
        ['活动问答','回答群活动的时间、地点与参加方式。','活动事实以知识库为准；没有依据时说明未知。','amber'],
        ['轻松闲聊','日常分享、趣事和友善互动。','自然简短，不虚构经历，不泄露其他群的信息。','green']
      ];
      const ids=[];
      for(const [name,description,instructions,color] of topicData){
        const id=randomUUID();ids.push(id);
        await db.query('INSERT INTO topics(id,name,description,instructions,color) VALUES($1,$2,$3,$4,$5)',[id,name,description,instructions,color]);
      }
      for(const [name,language,indices] of [
        ['ssh外语学习园地','en',[0,3]],['Shanghai Entrepreneurs Meetup','auto',[1,2,3]]
      ] as const){
        const id=randomUUID();
        await db.query('INSERT INTO groups(id,name,language) VALUES($1,$2,$3)',[id,name,language]);
        for(const i of indices)await db.query('INSERT INTO group_topics(group_id,topic_id) VALUES($1,$2)',[id,ids[i]]);
      }
    }
  });
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  await migrate();await pool.end();console.log('Migrations complete');
}
