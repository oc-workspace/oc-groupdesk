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
    await apply(config);
    // Send acknowledgement only AFTER the adapter applied this exact version.
    await this.request('/ack',{group_id:config.id,revision:config.revision});
    return config;
  }
}
