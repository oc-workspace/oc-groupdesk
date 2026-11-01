export type AppliedCapabilities={timeout_policy_version?:1|2;model_routing_version?:1;persona_skill_version?:1;interactions_policy_version?:1;persona_skill_sha256?:string};
export class GroupDeskClient{
 constructor(options:{baseUrl:string;token:string;fetchImpl?:typeof fetch});
 request(path:string,body?:unknown):Promise<any>;
 scenes(trustedUserId:string):Promise<any>;
 selectScene(trustedUserId:string,groupId:string):Promise<any>;
 context(trustedRequest:unknown):Promise<any>;
 applyConfig(trustedExternalGroupId:string,apply:(config:any)=>Promise<AppliedCapabilities|void>):Promise<any>;
}
