import {initializeUserOwners} from './user-access.js';
import {withBot} from './bot-workspaces.js';
import {controlPool} from './db.js';
import {ensureLegacyIsolation} from './bot-provisioning.js';
import {migrate} from './migrate.js';
import {createApp} from './app.js';
import {pool} from './db.js';
if((process.env.BOT_API_TOKEN||'').length<32)throw new Error('BOT_API_TOKEN must contain at least 32 characters');
await migrate();
await ensureLegacyIsolation();
for(const bot of (await controlPool.query("SELECT id FROM managed_bots WHERE database_state='ready'")).rows)await withBot(bot.id,()=>migrate({controlPlane:false,bootstrapAdmin:false}));
await initializeUserOwners();
const server=createApp().listen(Number(process.env.PORT||3110),'0.0.0.0',()=>console.log('GroupDesk ready on port '+(process.env.PORT||3110)));
function shutdown(){server.close(()=>pool.end().then(()=>process.exit(0)));setTimeout(()=>process.exit(1),10000).unref();}
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
