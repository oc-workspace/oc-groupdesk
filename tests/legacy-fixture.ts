// Existing feature regression fixtures only; excluded from standalone packages.
import {migrate as migrateReal} from '../server/migrate.js';
import {controlPool as pool} from '../server/db.js';
import {randomUUID} from 'node:crypto';
export async function migrate(options:{controlPlane?:boolean;bootstrapAdmin?:boolean}={}){
 const old=process.env.GROUPDESK_IMPORT_BUILTIN_TOPICS;process.env.GROUPDESK_IMPORT_BUILTIN_TOPICS='1';
 try{await migrateReal(options);}finally{if(old===undefined)delete process.env.GROUPDESK_IMPORT_BUILTIN_TOPICS;else process.env.GROUPDESK_IMPORT_BUILTIN_TOPICS=old;}
 if(options.controlPlane===false)return;
 if(!(await pool.query("SELECT 1 FROM managed_bots WHERE id='00000000-0000-4000-8000-000000000001'")).rowCount){
  await pool.query("INSERT INTO managed_bots(id,name,wechat_id,host_label,state,database_state) VALUES('00000000-0000-4000-8000-000000000001','RyuBuddy','RyuBuddy','rococo-root2','active','legacy')");
  await pool.query("INSERT INTO managed_bot_adapters(token_hash,bot_id,name,group_external_ids) SELECT token_hash,'00000000-0000-4000-8000-000000000001',name,group_external_ids FROM runtime_adapters ON CONFLICT DO NOTHING");
  const db=pool;
      const topicData=[
        ['外语交流','练习英语、日语等外语表达，讨论学习方法。','根据成员水平解释，纠错温和，提供自然表达。','blue'],
        ['创业经营','讨论产品、经营、团队与商业经验。','区分事实与个人观点，提供具体可执行的分析。','violet'],
        ['活动问答','回答群活动的时间、地点与参加方式。','活动事实以知识库为准；没有依据时说明未知。','amber'],
        ['轻松闲聊','日常分享、趣事和友善互动。','自然简短，不虚构经历，不泄露其他群的信息。','green']
      ];
      const ids=[];
      for(const [name,description,instructions,color] of topicData){
        const existing=(await db.query('SELECT id FROM topics WHERE name=$1',[name])).rows[0];
        const id=existing?.id||randomUUID();ids.push(id);
        if(!existing)await db.query('INSERT INTO topics(id,name,description,instructions,color) VALUES($1,$2,$3,$4,$5)',[id,name,description,instructions,color]);
      }
      for(const [name,language,indices] of [
        ['ssh外语学习园地','en',[0,3]],['Shanghai Entrepreneurs Meetup','auto',[1,2,3]]
      ] as const){
        const id=randomUUID();
        await db.query('INSERT INTO groups(id,name,language) VALUES($1,$2,$3)',[id,name,language]);
        for(const i of indices)await db.query('INSERT INTO group_topics(group_id,topic_id) VALUES($1,$2)',[id,ids[i]]);
      }
 }
 // Synthetic known hosts for old governance regression tests only.
 for(const [id,name] of [['rococo-root','GroupDesk与站点备份'],['rococo-root2','微信机器人运行环境'],['rpi-groupdesk-01','树莓派机器人运行环境']])await pool.query('INSERT INTO managed_runtime_hosts(id,name,can_cleanup) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[id,name,id!=='rococo-root']);
 await pool.query("UPDATE managed_bots SET runtime_host_id='rococo-root2' WHERE id='00000000-0000-4000-8000-000000000001' AND runtime_host_id IS NULL");
}
