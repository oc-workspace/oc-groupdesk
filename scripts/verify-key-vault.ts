// Operator-only migration check. Never print secret material, hints, or digests.
import {controlPool,pool} from '../server/db.js';
import {withBot} from '../server/bot-workspaces.js';
import {openControlSecret} from '../server/bot-secrets.js';
import {digest,requireCondition} from '../server/security.js';
let aliases=0;
for(const bot of (await controlPool.query("SELECT id FROM managed_bots WHERE database_state IN('legacy','ready')")).rows)await withBot(bot.id,async()=>{
 for(const c of (await pool.query('SELECT id,key_ciphertext,key_digest,key_hint,vault_key_id FROM model_credentials')).rows){
  const k=(await controlPool.query('SELECT * FROM managed_model_keys WHERE id=$1',[c.vault_key_id])).rows[0];requireCondition(k&&c.key_ciphertext==='vault:v1',500,'模型凭据迁移不完整');
  const clear=openControlSecret(k.secret_ciphertext);requireCondition(digest(clear)===c.key_digest&&k.key_digest===c.key_digest&&k.key_hint==='••••••'+clear.slice(-6)&&c.key_hint===k.key_hint,500,'模型密钥完整性校验失败');aliases++;
 }
});
console.log(JSON.stringify({verified_aliases:aliases,vault_keys:Number((await controlPool.query('SELECT count(*) FROM managed_model_keys')).rows[0].count),plaintext_output:false}));await pool.end();
