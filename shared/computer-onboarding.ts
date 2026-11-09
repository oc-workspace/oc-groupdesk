export type DeploymentChoice={deployment_mode?:string|null;device_kind?:string|null};
export function isComputerDeployment(value:DeploymentChoice){return value.deployment_mode==='self_hosted'&&value.device_kind==='computer';}
export const computerOnlyMessage='当前仅开放部署到自己的电脑，站点托管和服务器接入暂未开放。原接入记录保留，请确认本机方式后继续。';
