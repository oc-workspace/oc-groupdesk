import {botStorage,legacyBotId} from './bot-context.js';
import {botRecord} from './bot-workspaces.js';
import {digest,requireCondition} from './security.js';
import {resolveBotIdentity,botIdentityInstructions} from '../shared/bot-identity.js';
import type {IdentityPolicy} from './identity.js';
export async function botIdentityBundle(group:{id:string;policy:{identity:IdentityPolicy}}){
 const bot=await botRecord(botStorage.getStore()?.id||legacyBotId);requireCondition(bot,409,'机器人身份配置暂不可用');
 const identity=resolveBotIdentity(bot,group.id,group.policy.identity),sha=digest(JSON.stringify([1,identity.bot_id,identity.group_id,identity.display_name,identity.self_reference,identity.mention_names]));
 return {bot_identity_contract_version:1,bot_identity:identity,bot_identity_sha256:sha,bot_name_instructions:botIdentityInstructions(identity)};
}
