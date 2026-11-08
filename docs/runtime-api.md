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
适配器实际应用成功后 POST /api/runtime/ack：group_id、revision、timeout_policy_version=2；启用模型路由或发布 Persona 的群也需要对应能力和版本摘要。只有真正应用完整配置后才能确认。
版本已变化返回409，必须重取；应用失败不能确认。

建议30–60秒同步配置；每个私聊请求仍重取授权和检索。
管理界面分开显示已保存和已应用；3分钟无确认提示连接待检查。
按用户最新要求，状态仅由人工点击只读 GET /api/groups/status 检查，无定时轮询、切回页面检查或保存后自动检查；不会替换配置表单的未保存编辑。
群名下方和保存按钮上方均显示确认结果；编辑或保存后红字提示手动刷新。若人工检查发现其他页面更新了配置，提示重新载入后再编辑。
示例客户端支持 HTTPS/SSH loopback，具备超时和错误处理。

API 不发送微信消息、不调用模型，测试不会向真实群发言。

## 群聊策略契约 v1

配置接口新增policy_contract_version、policy、完整topics与participation_skill。话题数据含lexicons、all组合、排除、承接和深度；实际匹配及限流由适配器执行。后台topic.policy编辑后增加关联群revision。仓库模板只首次导入；显式覆盖需带当前话题revision。

policy.topic_scope=all保留原来的全部回答范围限制；proactive只限制主动参与，点名可问其他一般问题。私聊仍使用all，知识访问不扩展。语言policy包含follow/restricted/fixed、allowed、fallback和allow_requested；识别词条语言与输出语言独立。group.topic_overrides可覆盖当前群的讨论深度。

可信群标识可包含适配器实例命名空间和持久会话标识，不必冒充微信官方wxid。昵称派生用户标识只用于群内会话，不授予私聊权限。专用适配器token以SHA256存数据库，限制group_external_ids，禁止私聊场景。主BOT_API_TOKEN仍用于服务端管理集成，不能交给浏览器。

MaiBot接入实现见integration/maibot。30秒同步、75秒租约；失联/撤销停止该群处理，发送前复核服务端revision。ack表示已应用对应版本，不代表已发送实测。测试预览不调用模型或微信。

## 群等待策略契约 v2

`timeout_policy_contract_version=2` 与 `policy.timeouts` 下发本群的 planner_seconds、request_seconds、direct_ttl_seconds、wait_apology_seconds。旧群缺省300/310/420秒及5分钟致歉。致歉阈值存秒数，只接受1—30整分钟。校验范围、参数关系、请求绝对截止及原生客户端缓存处理见[按群配置等待时间](reply-controls.md)。ACK未声明v2返回409；通用客户端要求apply回调在实际应用后返回匹配能力字段，不自动替旧适配器声明支持。新机器人仍能接收v1配置并按v1确认。

## Persona 组合契约 v1

有特色的群在基础Persona字段之外下发persona_feature_skills、有序组合摘要和persona_composition_contract_version=1。ACK须声明persona_composition_version=1及完整组合摘要，旧适配器不能确认部分应用。基础-only仍兼容原契约；详见[组合与维护](persona-composition.md)。

### 2026-11-03：Replyer 超时与话题长度

当前运行时等待契约为 v3：`policy.timeouts.replyer_seconds` 与 Planner 独立，ACK 必须声明 `timeout_policy_version: 3`。其他时间字段语义不变。存在非空 `topics[].policy.max_reply_chars` 时，配置增加 `topic_reply_length_contract_version: 1`，ACK 同时须带 `topic_reply_length_version: 1`；没有自定义上限时不要求此能力。详见[回复控制与等待时间](reply-controls.md)和[话题策略](topic-policy-guide.md)。


## 删除登记与禁用通知

总管理员可GET `/api/bots/:id/deletion`、`/api/groups/:id/deletion`读取影响及阻止原因，再DELETE对应`/api/bots/:id`或`/api/groups/:id`，JSON为当前`revision`与完整`confirmation`（微信号/群名）。群请求必须使用所选机器人作用域；普通用户始终403，其他机器人群ID不可越权。删除不会通过此API执行Docker或微信操作。

已删除机器人凭据失效且不再作为业务空间；已删除群从普通管理/业务访问排除，但授权原适配器仍可获取`enabled:false`、`removed:true`、文字/图片路由停用且无话题/知识/人设绑定的配置通知，并按现有契约ACK。这是退订配置通知，不能凭它继续请求上下文或模型；同微信真实群被明确重新登记后，以新的存活配置为准。金融用量归属保留原UUID，不清空授权限定数组（空数组原含义为不限范围），不因删除扩大Key权限。

## 站点账号删除（仅总管理员）

- `GET /api/users/:id/deletion`：返回kind=user、revision、confirmation、影响统计与can_delete/reasons，不返回口令或Key。
- `DELETE /api/users/:id`：严格接收`{revision,confirmation}`，沿用管理会话/CSRF；角色403、错误输入400、旧版本/未满足前置条件409、已删除或未知404。撤销会话与授权，保留账本和创建者历史；详情见[用户管理](users-and-permissions.md)。
