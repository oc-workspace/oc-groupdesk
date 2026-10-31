import {migrate} from './migrate.js';
import {createApp} from './app.js';
import {pool} from './db.js';
if((process.env.BOT_API_TOKEN||'').length<32)throw new Error('BOT_API_TOKEN must contain at least 32 characters');
await migrate();
const server=createApp().listen(Number(process.env.PORT||3110),'0.0.0.0',()=>console.log('GroupDesk ready on port '+(process.env.PORT||3110)));
function shutdown(){server.close(()=>pool.end().then(()=>process.exit(0)));setTimeout(()=>process.exit(1),10000).unref();}
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
