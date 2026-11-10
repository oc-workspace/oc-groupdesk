export const summaryMemberRules="【总结成员昵称格式】总结中提及可确认的群成员时，一律使用 @昵称，例如成员叫 aa 就写 @aa；适用于正文、标题、署名、人物/互动描述、分段归纳和排行榜，所有输出语言均如此。昵称已有 @ 前缀时不重复添加，保留原昵称的文字、空格和表情。仅给来源可确认的成员昵称加前缀，不给群名、机构、普通人名或“发送者昵称未获取”等缺失提示加 @；不猜测未知成员，不改写原话内容中的邮箱、链接和账号。这里的 @ 是文字显示格式，不代表真实微信提醒。";
export function summaryMemberName(name:string){const value=name.trim();return value?'@'+value.replace(/^@+/,''):'';}
export function withSummaryMemberRules(instructions:string){return instructions.includes('【总结成员昵称格式】')?instructions:instructions+'\n\n'+summaryMemberRules;}
