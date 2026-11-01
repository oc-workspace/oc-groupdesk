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
    const requiredTimeoutVersion=config.timeout_policy_contract_version;
    if(requiredTimeoutVersion!==undefined&&(![1,2].includes(requiredTimeoutVersion)||applied?.timeout_policy_version!==requiredTimeoutVersion)){
      throw new Error('Adapter must apply per-group time budgets before acknowledging this configuration');
    }
    if(config.interactions?.bindings?.length&&(![1].includes(config.interactions_contract_version)||applied?.interactions_policy_version!==config.interactions_contract_version)){
      throw new Error('Adapter must apply group interactions before acknowledging this configuration');
    }
    // Send acknowledgement only AFTER the adapter applied this exact version.
    const capabilities=Object.fromEntries(['timeout_policy_version','model_routing_version','persona_skill_version','persona_skill_sha256','interactions_policy_version'].filter(key=>applied?.[key]!==undefined).map(key=>[key,applied[key]]));
    await this.request('/ack',{group_id:config.id,revision:config.revision,...capabilities});
    return config;
  }
}
