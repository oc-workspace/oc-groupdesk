export const keyFeatures={chat:'群回复',summary:'群聊总结',persona:'Persona 制作',topic:'话题生成',onboarding:'新群接入助手',analysis:'讨论分析',interaction:'群互动',image:'生图'} as const;
export type KeyFeature=keyof typeof keyFeatures;
export const limitLabels={daily_requests:'每日调用次数',monthly_requests:'每月调用次数',daily_tokens:'每日 token',monthly_tokens:'每月 token',daily_cost:'每日费用预算',monthly_cost:'每月费用预算',concurrency:'同时处理请求数',alert_percent:'额度提醒阈值（%）'} as const;
