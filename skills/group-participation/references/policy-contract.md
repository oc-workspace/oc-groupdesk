# 策略契约 v1

可信服务提供group、revision、policy、topics、sources和conversation_scope。每个topic包含稳定catalog_key、revision、说明、回复指导和policy。

topic.policy含多语言lexicons、词组all组合、排除词、承接词与排除词、换题词、context窗口和reply_depth。词条都是字面数据，不接受执行代码或用户正则。上下文状态按群和话题隔离；普通承接不延长起点。

GroupDesk保存并下发数据库中的生效数据；仓库catalog只作初始化或管理员明确导入的模板。管理员编辑优先，不在启动时覆盖。适配器应用完整版本后ack，发送前复核版本；停用或撤销后不使用旧权限继续发送。

无可信方向或群身份的消息不能被skill自行认作入站。UI昵称派生标识只可用于本群会话，不证明跨群或私聊身份。模板和合成测试可公开；真实群标识、私有persona语料、聊天和密钥不进入公开仓库。
