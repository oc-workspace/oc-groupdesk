# GroupDesk 项目总览与规划

更新于2026-11-08（Asia/Singapore）。本页统一维护当前能力、模块入口及后续规划；每日过程和部署证据保留在progress/，不将历史进行中记录当作当前状态。

| 功能 | 当前说明 |
|---|---|
| 群接入、群标识与配置确认 | [站点新群接入向导](group-onboarding-wizard.md)、[微信群接入](group-onboarding-wizard.md)、[运行接口](runtime-api.md) |
| 话题库、群话题、AI Prompt助填、讨论深度与回复长度 | [话题策略](topic-policy-guide.md) |
| 语言、群内称呼、自称、点名与AI披露 | [称呼与身份](bot-group-identity.md)、[话题策略](topic-policy-guide.md) |
| API Key、私有/公用授权、费用与按群模型选择 | [模型路由](model-routing.md)、[Key治理](api-key-governance.md) |
| 用户、GitHub登录、管理员审核、账号删除/原因/独占清理、归属和资源共享 | [用户与权限](users-and-permissions.md) |
| Persona素材、增量归档、按人提取与人工发布 | [Persona工作室](persona-studio.md) |
| 公共人设资源浏览、选择导入、来源存档与草稿适配 | [人设资源库](persona-resources.md) |
| 基础/特色组合、公开模板、完整草稿与从容迎新 | [Persona组合](persona-composition.md) |
| 每日摸鱼、多语言命令、积分、奖品与兑换 | [群互动](group-interactions.md) |
| 认真/玩笑讨论统计与按群接梗 | [讨论与接梗](conversation-insights.md) |
| 连续回复、跟进、频率、补答、超时与致歉 | [回复控制](reply-controls.md) |
| 消息合并、账号跨群发送间隔、排队与人工接管 | [消息机制优化方案](message-mechanism-optimization.md)，设计待实施 |
| 群总结、预览、定时与单次预约、自适应批次 | [群聊总结](group-summaries.md) |
| 知识库、文件处理与私聊成员核验 | [知识与权限](knowledge-and-access.md) |
| 微信数据库读取、写入事件、加密与送达校验 | [Chatlog Reader](../integration/chatlog-reader/README.md) |
| Linux读取改进、叙间方案对照与原生发送候选评估 | [Linux原生发送评估](linux-native-transport-evaluation.md) |
| 巡检、告警、加载反馈、Docker部署与备份 | [运维](operations.md) |
| 机器人接入向导、隔离、按用户启用与管理员删除 | [多机器人方案与实现](multi-bot-management.md) |
| 已删除独立运行栈清理、旧目录和备份只读盘点、空间回收 | [运行环境与备份](runtime-maintenance.md) |
| 历史测试、发布、部署与阻塞证据 | [每日进度](progress/README.md) |

生图目前提供Key与模型配置，不等于已接通群内生图、图片识别或图片发送。界面上的配置确认、生成成功、微信发送成功是不同状态，不能混用。

## 文档维护约定

新增功能时同步更新本索引、相应功能说明和当天进度；功能文档标明已实现与待接入的能力。部署不覆盖用户维护的话题、知识库、Persona或模板。禁止在仓库保存API Key、Cookie、数据库密钥、完整群聊或生成的真实Persona/总结正文。

## 当前状态与后续优化

| 状态 | 范围与下一步 |
|---|---|
| 已实现并发布 | 上表业务模块；最新总管理员删除登记/群配置及受限运行栈维护证据见11月8日日志；机器人接入、用户审核/共享与Key治理见11月7日日志。最终验证117单元、210隔离集成。各群启用、人设绑定、模型和授权仍由后台选择，不能把“已有功能”视为“每群都已启用”。 |
| 管理员按需配置 | 微信运行环境、首群绑定及专属登录入口仍按现有部署工具准备；GitHub OAuth App与真实登录验收、公用Key授权/单价/额度、奖品、总结计划、各群基础与特色Persona；是否已配置以后台实际状态为准。 |
| 已有设计，尚未实施 | [消息机制优化](message-mechanism-optimization.md)：账号跨群统一发送节奏、收集合并、发送前复核与人工接管；全局发送间隔待用户确定，文档数值不是线上参数。 |
| 正在评估，尚未接通 | [Linux原生发送](linux-native-transport-evaluation.md)：保留现有GUI发送，已有静态/合成/附加退出验证，尚未验证真实原生发送。 |
| 扩展待开发 | 群内生图/发图与公用多媒体计量、更多互动类型；当前生图只配置Key/模型。知识库OCR/embedding、可信身份来源不足时的自动成员核验、加密异地备份未作为已上线能力。 |
| 资源待核实 | MBTI完整来源/引用文件/许可的评估记录见[人设资源库](persona-resources.md)；未因整理文档自动加入资源或人设。 |

这些是状态汇总，不新建执行任务或承诺日期；后续开发范围和优先级按用户明确需求确定。

## 阅读与维护规则

功能行为以对应模块文档为准；控制面与运行端的接口约束见[运行接口](runtime-api.md)。`integration/`与`scripts/`下保留组件部署/测试说明，不与产品操作指南混用。独立验证报告和JSON证据继续保留。

新增或修改功能时同步本页、模块文档及当天日志。一个自然日一份主日志；测试、PR、部署、备份和未完成验收保留可追溯记录。删除合并文档前先迁移正文并检查引用；不额外建立重复的规划文件。密钥、Cookie、完整聊天与真实生成正文不入仓库。
