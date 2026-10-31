import {passwordHash} from './security.js';
import {pool,transaction,audit} from './db.js';
let input='';
for await(const chunk of process.stdin){input+=chunk;if(input.length>1000)throw new Error('Input too long');}
const password=input.trim();
if(password.length<16||password.length>200)throw new Error('New password must contain 16–200 characters');
await transaction(async db=>{
  const admin=(await db.query('UPDATE admins SET password_hash=$1 WHERE username=$2 RETURNING id',[passwordHash(password),process.env.ADMIN_USERNAME||'admin'])).rows[0];
  if(!admin)throw new Error('Administrator does not exist');
  await db.query('DELETE FROM sessions WHERE admin_id=$1',[admin.id]);
  await audit('operator','auth.password_reset',null,{},db);
});
await pool.end();console.log('Administrator password updated; all sessions revoked');
