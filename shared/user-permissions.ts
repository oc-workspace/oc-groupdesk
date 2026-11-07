export const permissionLabels={
 'bots.create':'创建机器人','bots.manage':'管理自己的机器人状态','groups.manage':'管理自己的群与接入',
 'topics.create':'创建和维护自己的话题','personas.create':'制作和维护自己的人设与素材',
 'models.manage':'管理自己的模型与Key','knowledge.manage':'维护自己的知识库',
 'interactions.manage':'配置群互动','summaries.manage':'创建总结与自动计划','conversation.manage':'执行讨论分析',
 'members.manage':'管理群成员授权'
} as const;
export type Permission=keyof typeof permissionLabels;
export type SessionUser={id:string;username:string;display_name:string;github_login:string|null;role:'super_admin'|'user';permissions:Partial<Record<Permission,boolean>>;csrf:string};
export function allowed(user:Pick<SessionUser,'role'|'permissions'>,permission:Permission){return user.role==='super_admin'||user.permissions[permission]===true;}
