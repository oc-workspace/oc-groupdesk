# GroupDesk 功能与运维文档

本文是功能说明的入口。`progress/`记录按日的开发、测试、发布和验收证据；功能说明与进度日志分别维护。

| 功能 | 当前说明 |
|---|---|
| 群接入、群标识与配置确认 | [微信群接入](wechat-group-onboarding.md)、[运行接口](runtime-api.md) |
| 话题库、群话题、AI Prompt助填、讨论深度与回复长度 | [话题策略](topic-policy-guide.md) |
| 输出语言、AI身份与角色扮演 | [身份策略](identity-policy.md)、[话题策略](topic-policy-guide.md) |
| API Key、模型目录与按群模型选择 | [模型路由](model-routing.md) |
| Planner、Replyer、辅助任务和总结分阶段模型 | [阶段模型](model-stages.md) |
| Persona素材、增量归档、按人提取与人工发布 | [Persona工作室](persona-studio.md) |
| 基础与特色Persona组合、独立素材与完整草稿 | [Persona组合](persona-composition.md) |
| 随机延迟迎新 | [从容迎新](newcomer-welcome.md) |
| 每日摸鱼、多语言命令、积分、奖品与兑换 | [群互动](group-interactions.md) |
| 认真/玩笑讨论统计与按群接梗 | [讨论与接梗](conversation-insights.md) |
| 连续回复、免点名跟进、频率与补答 | [回复控制](reply-controls.md) |
| Planner/Replyer/API超时、请求时效与延迟致歉 | [等待时间](group-timeouts.md) |
| 群总结、预览、定时与单次预约、自适应批次 | [群聊总结](group-summaries.md) |
| 知识库、文件处理与私聊成员核验 | [知识与权限](knowledge-and-access.md) |
| 微信数据库读取、写入事件、加密与送达校验 | [Chatlog Reader](../integration/chatlog-reader/README.md) |
| Linux读取改进、叙间方案对照与原生发送候选评估 | [Linux原生发送评估](linux-native-transport-evaluation.md) |
| 微信巡检、独立告警、Docker部署与备份 | [运维](operations.md) |
| 多机器人管理、相互隔离与先后切换 | [多机器人方案与实现](multi-bot-management.md) |
| 历史测试、发布、部署与阻塞证据 | [每日进度](progress/README.md) |

生图目前提供Key与模型配置，不等于已接通群内生图、图片识别或图片发送。界面上的配置确认、生成成功、微信发送成功是不同状态，不能混用。

## 文档维护约定

新增功能时同步更新本索引、相应功能说明和当天进度；功能文档标明已实现与待接入的能力。部署不覆盖用户维护的话题、知识库、Persona或模板。禁止在仓库保存API Key、Cookie、数据库密钥、完整群聊或生成的真实Persona/总结正文。
