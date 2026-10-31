# 可信微信适配器接口

所有 /api/runtime 请求只允许服务端适配器携带 Authorization: Bearer <BOT_API_TOKEN>。
密钥不可提供给浏览器或聊天用户。

## 身份

user_id、群 external_id 必须取自已认证微信事件，不能信任聊天正文、昵称或用户自行提交的标识。
服务端 token 代表适配器被信任；GroupDesk 无法单独验证适配器所报身份。

既有 UI 桥以群 ID + 昵称生成 ui- ID，不能跨群或私聊验证同一人；核验接口拒绝此类 ID。
第一版管理员通过可信成员目录和私聊身份交叉核验，录入稳定用户 ID、群及核验依据。
禁止只凭“我是某群成员”的自述授权。

## 私聊

1. GET /api/runtime/scenes?user_id=<trusted-id>：返回已核验、已启用的群 id/name。
2. 展示选择项，POST /api/runtime/select-scene：user_id、group_id。
3. 返回 reset_conversation=true 时清空旧场景上下文。
4. POST /api/runtime/context：user_id、channel:"dm"、query（最多500字的检索问题）、可选 topic_id/language。
5. 按 conversation_scope 隔离会话与缓存；只处理 topics 中话题；仅使用 sources 提供的当前群资料，引用 title/document_id。
6. 每次请求重取权限；403/503/超时停止生成和资料访问，不可使用上次缓存。

场景有效期12小时。一个用户可属多个群，同时选择一个私聊群场景。
语言覆盖只影响当前请求，是否允许由群设置决定。

## 群聊

POST /api/runtime/context：user_id、channel:"group"、group_external_id、mentioned（可信 @ 事件）、query、可选 topic_id/language。

未绑定/停用/未启用话题/不满足 @ 回复方式时拒绝。topic_id 不传则返回全部已启用话题供机器人分类。
话题语义门控和回复频率由机器人负责，不可只把规则当普通聊天消息拼接。

## 版本应用

GET /api/runtime/config/:externalId 返回完整配置和 revision，停用配置也返回。
适配器实际应用成功后 POST /api/runtime/ack：group_id、revision。
版本已变化返回409，必须重取；应用失败不能确认。

建议30–60秒同步配置；每个私聊请求仍重取授权和检索。
管理界面分开显示已保存和已应用；3分钟无确认提示连接待检查。
已登录后台通过只读 GET /api/groups/status 每5秒刷新版本和心跳，切回页面时立即检查；不会替换配置表单的未保存编辑。
群名下方和保存按钮上方均显示确认结果，支持手动刷新确认状态；若其他页面更新了配置，提示重新载入后再编辑。
示例客户端支持 HTTPS/SSH loopback，具备超时和错误处理。

API 不发送微信消息、不调用模型，测试不会向真实群发言。

## 群聊策略契约 v1

配置接口新增policy_contract_version、policy、完整topics与participation_skill。话题数据含lexicons、all组合、排除、承接和深度；实际匹配及限流由适配器执行。后台topic.policy编辑后增加关联群revision。仓库模板只首次导入；显式覆盖需带当前话题revision。

policy.topic_scope=all保留原来的全部回答范围限制；proactive只限制主动参与，点名可问其他一般问题。私聊仍使用all，知识访问不扩展。语言policy包含follow/restricted/fixed、allowed、fallback和allow_requested；识别词条语言与输出语言独立。group.topic_overrides可覆盖当前群的讨论深度。

可信群标识可包含适配器实例命名空间和持久会话标识，不必冒充微信官方wxid。昵称派生用户标识只用于群内会话，不授予私聊权限。专用适配器token以SHA256存数据库，限制group_external_ids，禁止私聊场景。主BOT_API_TOKEN仍用于服务端管理集成，不能交给浏览器。

MaiBot接入实现见integration/maibot。30秒同步、75秒租约；失联/撤销停止该群处理，发送前复核服务端revision。ack表示已应用对应版本，不代表已发送实测。测试预览不调用模型或微信。
