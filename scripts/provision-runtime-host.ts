// Explicit trusted-operator CLI. Never expose the generated token in stdout.
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {controlPool,audit} from '../server/db.js';
import {sealControlSecret} from '../server/bot-secrets.js';
import {digest,token} from '../server/security.js';
const [host,name,origin,output]=process.argv.slice(2);
if(!/^[a-z0-9][a-z0-9-]{0,62}$/.test(host||'')||!name||!output)throw Error('Usage: provision-runtime-host.ts HOST NAME SITE_ORIGIN NEW_PRIVATE_FILE');
const url=new URL(origin);if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw Error('Use a site origin');
if(url.protocol==='http:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw Error('Remote agents require HTTPS');
const config={host,url:url.origin,token:token(),permit_secret:randomBytes(32).toString('hex')};
try{
 // Exclusive creation prevents rotating a working agent or overwriting a private file by accident.
 await writeFile(resolve(output),JSON.stringify(config),{mode:0o600,flag:'wx'});
 await controlPool.query('INSERT INTO managed_runtime_hosts(id,name,token_hash,permit_ciphertext,enabled,can_cleanup) VALUES($1,$2,$3,$4,true,false)',[host,name,digest(config.token),sealControlSecret(config.permit_secret)]);
 await audit('operator','runtime.agent_provisioned',host,{can_cleanup:false},controlPool);
 console.log('Private host configuration written. Cleanup is disabled; configure its reviewed scope separately.');
}finally{await controlPool.end();}
