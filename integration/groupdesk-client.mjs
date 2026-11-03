/**
 * For trusted server-side adapters only. Never ship BOT_API_TOKEN to a browser.
 * Identity must be authenticated by the adapter, not supplied by message text.
 */
export class GroupDeskClient {
  constructor({baseUrl,token,fetchImpl=fetch}){
    const url=new URL(baseUrl);
    if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['localhost','127.0.0.1','::1','[::1]'].includes(url.hostname))){
      throw new Error('Use HTTPS or a private SSH loopback tunnel');
    }
    this.baseUrl=url.href.replace(/\/$/,'');this.token=token;this.fetch=fetchImpl;
  }
  async request(path,body){
    const response=await this.fetch(this.baseUrl+'/api/runtime'+path,{
      method:body?'POST':'GET',headers:{Authorization:'Bearer '+this.token,...(body?{'Content-Type':'application/json'}:{})},
      body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(10000),redirect:'error'
    });
    const result=await response.json();
    if(!response.ok)throw Object.assign(new Error(result.error||'GroupDesk denied access'),{status:response.status});
    return result;
  }
  scenes(trustedUserId){return this.request('/scenes?user_id='+encodeURIComponent(trustedUserId));}
  selectScene(trustedUserId,groupId){return this.request('/select-scene',{user_id:trustedUserId,group_id:groupId});}
  context(trustedRequest){return this.request('/context',trustedRequest);}
  async applyConfig(trustedExternalGroupId,apply){
    const config=await this.request('/config/'+encodeURIComponent(trustedExternalGroupId));
    const applied=await apply(config);
    if(config.model_stage_routing_contract_version!==undefined&&(config.model_stage_routing_contract_version!==1||applied?.model_stage_routing_version!==1))throw new Error('Adapter must apply stage model routing before acknowledging this configuration');
    const requiredTimeoutVersion=config.timeout_policy_contract_version;
    if(requiredTimeoutVersion!==undefined&&(![1,2,3].includes(requiredTimeoutVersion)||applied?.timeout_policy_version!==requiredTimeoutVersion)){
      throw new Error('Adapter must apply per-group time budgets before acknowledging this configuration');
    }
    if(config.topic_reply_length_contract_version!==undefined&&(config.topic_reply_length_contract_version!==1||applied?.topic_reply_length_version!==1))throw new Error('Adapter must apply topic reply character limits before acknowledging');
    if(config.interactions?.bindings?.length&&(![1].includes(config.interactions_contract_version)||applied?.interactions_policy_version!==config.interactions_contract_version)){
      throw new Error('Adapter must apply group interactions before acknowledging this configuration');
    }
    if(config.reply_limits_contract_version!==undefined&&(config.reply_limits_contract_version!==1||applied?.reply_limits_version!==1))throw new Error('Adapter must apply per-group reply limits before acknowledging this configuration');
    if(config.policy?.conversation?.enabled&&(config.conversation_policy_contract_version!==1||applied?.conversation_policy_version!==1))throw new Error('Adapter must apply conversation policy before acknowledging this configuration');
    if(config.persona_feature_skills?.length&&(config.persona_composition_contract_version!==1||applied?.persona_composition_version!==1||applied?.persona_composition_sha256!==config.persona_composition_sha256))throw new Error('Adapter must apply complete persona composition before acknowledging this configuration');
    if(config.newcomer_welcome_contract_version!==undefined&&(config.newcomer_welcome_contract_version!==1||applied?.newcomer_welcome_policy_version!==1))throw new Error('Adapter must apply newcomer welcome scheduling before acknowledging this configuration');
    // Send acknowledgement only AFTER the adapter applied this exact version.
    if(config.reply_frequency_contract_version!==undefined&&(config.reply_frequency_contract_version!==1||applied?.reply_frequency_version!==1||applied?.reply_frequency_revision!==config.reply_frequency.revision))throw new Error('Adapter must apply current global reply frequency before acknowledging');
    const capabilities=Object.fromEntries(['topic_reply_length_version','model_stage_routing_version','reply_frequency_version','reply_frequency_revision','reply_limits_version','newcomer_welcome_policy_version','timeout_policy_version','model_routing_version','persona_skill_version','persona_skill_sha256','persona_composition_version','persona_composition_sha256','interactions_policy_version','conversation_policy_version'].filter(key=>applied?.[key]!==undefined).map(key=>[key,applied[key]]));
    await this.request('/ack',{group_id:config.id,revision:config.revision,...capabilities});
    return config;
  }
}
