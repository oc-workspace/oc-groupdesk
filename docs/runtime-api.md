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
管理界面分开显示已保存和已应用；3分钟无确认视为离线。
示例客户端支持 HTTPS/SSH loopback，具备超时和错误处理。

API 不发送微信消息、不调用模型，测试不会向真实群发言。
