// Trusted deployment CLI only. Config is written to a private file, never stdout.
import {writeFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {controlPool,audit} from '../server/db.js';
import {sealControlSecret} from '../server/bot-secrets.js';
import {digest,token} from '../server/security.js';
const host=process.argv[2];if(!['rococo-root','rococo-root2'].includes(host))throw Error('Use registered host');
const config={host,url:'https://groupdesk.rococo.dev',token:token(),permit_secret:randomBytes(32).toString('hex')};
try{await controlPool.query('UPDATE managed_runtime_hosts SET token_hash=$2,permit_ciphertext=$3,enabled=true WHERE id=$1',[host,digest(config.token),sealControlSecret(config.permit_secret)]);await writeFile('/tmp/runtime-agent-config-'+host+'.json',JSON.stringify(config),{mode:0o600});await audit('operator','runtime.agent_provisioned',host,{can_cleanup:host==='rococo-root2'},controlPool);console.log('Private host configuration written; token not displayed.');}finally{await controlPool.end();}
