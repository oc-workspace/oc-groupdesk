// Trusted operator command. Requires explicit source, target and source group.
import {copyBotConfiguration} from '../server/bot-config-copy.js';
import {closePools} from '../server/db.js';
const [source,target,group]=process.argv.slice(2);
try{
 if(process.argv.length!==5)throw Error('Usage: copy-bot-configuration <source bot UUID> <target bot UUID> <source group UUID>');
 console.log(JSON.stringify(await copyBotConfiguration(source,target,group,'operator:user-authorized-copy')));
}catch{console.error('configuration_copy_failed_no_secret_output');process.exitCode=1;}
finally{await closePools();}
