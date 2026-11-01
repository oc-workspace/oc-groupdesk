# MaiBot 1.3.18 适配器

`groupdesk_runtime.py`读取服务端私有`/groupdesk/connection.json`，每30秒取配置，成功应用后确认revision；75秒租约到期或同步失败即停止该群处理，不回退到旧权限。文件包含HTTPS地址、专用适配器token和本地会话到可信external_id的映射，不能提交仓库。

GroupDesk在数据库中仅保存适配器token的SHA256，并限制授权群。该适配器不具备私聊场景或跨群成员核验权限。群标识应包含适配器实例命名空间；昵称派生用户标识只用于本群会话。

`maibot.patch`针对既有带限流和persona绑定的1.3.18部署；应用前必须核对基线、备份并等待空闲。共享模块放入limits目录，连接目录只读挂载到MaiBot和桥接。每次候选和模型调用使用当前快照，发送前另查服务端版本；配置撤销后不继续发送旧答案。

词表、组合、排除、承接和深度来自数据库。普通承接不延长起点，状态按群和话题隔离，换题/过期取消未派发候选。原有全局token预算及模型/发送配额不放宽。现有微信方向和发送者检查保持。

语言策略先约束生成，再阻止明显脚本/常见语言不匹配的输出。短人名、引用和代码不作为主要语言证据；短文本或相近拉丁语种不能保证完全自动判定。不会为语言检测新增模型调用。

群persona选择只加载对应persona；GT真实语料仍由机器人私有挂载。本轮实际接入仅迁移已有授权群，不自动授权其他群。新增群需先由可信适配器完成会话绑定及读取授权。

测试使用临时数据库和无网络容器，不向真实微信群发送测试消息。`test_groupdesk_runtime.py`可在MaiBot测试镜像中运行。

原生测试时需把仓库catalog目录只读挂载为/catalog，用于验证实际发布词表的排除与承接；测试使用临时SQLite，不能指向运行账本。

Unified diff context lines for empty source lines contain a required single space. The scoped .gitattributes rule preserves that patch syntax while leaving source-code whitespace checks enabled.

Gemini 3.8 Flash兼容修正：针对固定MaiBot基线，用patch-gemini-client.py把generateContent工具结果的Content角色从tool改成user；保留函数名、调用ID及thought signature。当前普通gemini-3.8-flash使用LOW思考、关闭思考摘要，不改变既有输出token上限；high等显式变体不覆盖。修正源文件需只读挂载到原路径，仅重建MaiBot，微信会话保持。test_gemini_compatibility.py在原生镜像中验证转换及SDK配置；合成工具结果的真实接口简测不向微信群发消息。

慢模型等待与两分钟致歉：见 [运行策略与安装验证](long-wait/README.md)。Planner 300秒、HTTP 310秒、点名从首次采集起共用420秒，普通插话保留短时效。
