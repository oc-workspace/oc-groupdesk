export type DeploymentChoice={deployment_mode?:string|null;device_kind?:string|null};
export function isSelfDeployment(value:DeploymentChoice){return value.deployment_mode==='self_hosted'&&(value.device_kind==='computer'||value.device_kind==='server');}
export const selfDeploymentMessage='当前仅开放部署到自己的电脑或自己选择的服务器，站点托管暂未开放。原接入记录保留，请确认自部署方式后继续。';
