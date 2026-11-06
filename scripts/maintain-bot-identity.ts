import {readFile} from 'node:fs/promises';
import {z} from 'zod';
import {pool} from '../server/db.js';
import {withBot,listedWorkspaces} from '../server/bot-workspaces.js';
import {identityMaintenancePlan,maintainBotIdentity} from '../server/bot-identity-maintenance.js';
try{
 const input=z.object({apply:z.boolean().default(false),bots:z.array(z.object({id:z.uuid(),fingerprint:z.string().regex(/^[a-f0-9]{64}$/).optional(),mention_names:z.array(z.string()).max(12)}).strict())}).strict().parse(JSON.parse(await readFile('/dev/stdin','utf8')));
 const known=new Set((await listedWorkspaces()).map(b=>b.id));
 for(const b of input.bots){if(!known.has(b.id))throw Error('Unknown workspace');const result=await withBot(b.id,()=>input.apply?maintainBotIdentity(b.fingerprint||'',b.mention_names):identityMaintenancePlan());console.log(JSON.stringify({bot_id:b.id,...result}));}
}catch{console.error('Identity maintenance incomplete; check current revisions, jobs and persona size. No source material is rewritten.');process.exitCode=1;}
finally{await pool.end();}
