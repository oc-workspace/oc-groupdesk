import {z} from 'zod';
export const readingModes=['auto','database','gui'] as const;
export const readingMethods=['unknown','chatlog_keeper','chatlog','gui','macos_wechat_export'] as const;
export const readingModeLabels={auto:'由 AI 检查后推荐',database:'只使用数据库读取',gui:'使用微信界面读取（GUI 备用）'};
export const readingMethodLabels={unknown:'尚未确定',chatlog_keeper:'chatlog-keeper 数据库读取',chatlog:'chatlog 数据库读取',gui:'微信界面读取（GUI）',macos_wechat_export:'Mac 数据库读取'};
export const installationFailureLabels={none:'无',database_unavailable:'数据库读取方案不可用或尚未验证',gui_adapter_missing:'缺少适配当前设备的界面采集组件',gui_not_verified:'界面读取尚未验证',login_required:'微信需要登录或解锁',permission_required:'需要本人确认设备操作权限',unsupported_platform:'当前平台或版本尚未适配',missing_components:'缺少运行组件',install_failed:'组件安装未完成',connection_failed:'设备尚未连接',verification_failed:'实际读取或收发验证未通过',unknown:'需要进一步排查'};
export const installationReportSchema=z.object({
 contract:z.literal(1),report_id:z.uuid(),generated_at:z.string().max(40).datetime({offset:true}),
 phase:z.enum(['inspect','plan','install','connect','verify']),outcome:z.enum(['info','planned','success','blocked','failed']),
 reading_mode:z.enum(readingModes),selected_method:z.enum(readingMethods),used_method:z.enum(readingMethods),
 platform:z.enum(['unknown','linux','windows','macos']),arch:z.enum(['unknown','x86_64','arm64','other']),
 wechat_version:z.string().max(48).regex(/^(?:unknown|\d{1,3}(?:\.[0-9A-Za-z]{1,12}){1,4}(?:[+() _-][0-9A-Za-z.+() _-]{1,16})?)$/),
 compatibility:z.enum(['unknown','project_verified_build','upstream_reported','needs_verification','not_supported','wechat_not_detected']),
 failure_code:z.enum(Object.keys(installationFailureLabels) as [keyof typeof installationFailureLabels,...(keyof typeof installationFailureLabels)[]])
}).strict().superRefine((value,ctx)=>{if(value.phase==='verify'&&value.outcome==='success'&&value.used_method==='unknown')ctx.addIssue({code:'custom',message:'本地试读成功时需注明实际读取方式'});if(value.used_method!=='unknown'&&(value.phase!=='verify'||value.outcome!=='success'))ctx.addIssue({code:'custom',message:'实际使用方式只能随成功的本地验收报告提交'});});
export const installationReportBatch=z.object({contract:z.literal(1),events:z.array(installationReportSchema).min(1).max(50)}).strict();
export type InstallationReport=z.infer<typeof installationReportSchema>;
