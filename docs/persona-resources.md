# 人设资源库

## 使用

在机器人工作区打开「Persona 制作 → 人设资源库」。公共目录来自 [awesome-persona-distill-skills](https://github.com/xixu-me/awesome-persona-distill-skills)，首版固定在 `eeaad969a384ad00aad47f1541dc4f007b859cea`，包含71项链接。2026-11-07按用户指定补充十二星座人格后，共72项；补充条目独立记录来源及人工核对commit。目录升级随项目发布，不自动覆盖用户内容。

1. 搜索人物、用途或仓库，按类别、资源类型筛选，点击「读取来源」。浏览目录不会下载全部仓库或增加基础Persona选项。
2. 来源预览显示仓库、固定commit、主Skill候选文件、许可、已读文件、遗漏和SHA-256。多Skill仓库可选择具体文件；来源脚本和宿主工具不安装或执行。
3. 人设资源可选择基础Persona或特色Skill，填写名称、唯一英文Skill名称、制作目标；可选择Key/模型并勾选AI制作，也可只建立初始化草稿。AI制作只向所选模型服务提交来源参考文本及制作目标。身份、称呼、点名和语言服从GroupDesk本群配置。
4. 查看完成提示，点击「打开草稿编辑器」，手动查看制作进度、校对和修订。初始化模板不能发布。发布草稿后，在「群人设配置」选择目标群并保存；导入不会自动发布或应用。

「自己.skill」「女娲」等元工具按参考方法展示，仅存为参考素材与数据集。README-only仓库也只保存为参考。之后可在新建/已有Persona里勾选该数据集，填写具体制作目标再生成。

## 来源、上限与重复

- 仅读取目录列出的公开GitHub仓库，不接受任意URL；无认证请求、无内部Key传递；固定版本后再读取文件。限制公网HTTPS、DNS固定、禁止重定向、符号链接和子模块。
- 每次最多20个文本文件，主文件/单文件120KB，合计180KB；读取同目录references下Markdown/TXT及根/同目录许可通知。超限文件逐个列出；默认禁止直接制作，管理员可明确选择仅按已读部分制作。正文中的外部工具依赖不会执行或自动安装，草稿需人工核对。
- 预览缓存24小时，仅属于当前机器人；再次读取可能得到新的上游commit。导入存档单独持久保留，原始文本、许可、来源版本、目录版本和摘要进入素材及制作溯源；生成时抽样预算沿用现有Persona制作机制，素材完整存档不等于全部进入单次模型输入。
- 同一机器人按仓库+主文件去重，连续/并发导入返回同一记录，保留人工修订及原来源快照，不更新已有稿。参考素材先导入后如需做人设，在编辑器新建Persona并关联数据集。
- 巴菲特、马斯克等已有同类人设会显示提示与打开按钮。索引中的不同仓库不是现有版本；创建独立变体需明确选择，不能覆盖原版。同机器人Skill名称必须唯一。
- 公共目录共享，各机器人的预览、导入、素材、草稿、版本和群绑定位于独立业务数据库及文件根。归档人设仍保留去重关系，可打开后恢复。
- 目录CC0不等于链接项目使用CC0；各来源许可和原文分别保留，未声明的标记为未声明。发布导出包含来源溯源与许可文本。

## 开发与运维

迁移021仅创建`persona_resource_previews`、`persona_resource_imports`，不批量导入、不变更群revision或已有Persona。API均在现有管理员认证、CSRF、机器人workspace作用域下：

- `GET /api/persona-resources`：目录、本机器人已导入和同类项。
- `POST /api/persona-resources/:id/preview`：可选`path`，版本固定后缓存预览。
- `POST /api/persona-resources/:id/import`：预览ID、名称/slug、种类、制作目标、同类变体/部分资料选择、可选模型路由。

导入事务原子建立存档、素材数据集和未发布模板；模型排队失败仍保留来源和模板，可在编辑器重新提交。使用既有Persona任务worker，任务输入协议兼容，无需改变微信、Reader、桥接或MaiBot。原文件不进仓库，公共目录快照保存在`catalog/persona-resources.json`。

## 十二星座人格补充（2026-11-07）

[Zodiac Persona](https://github.com/sirius-016/zodiac-persona-skill) 为MIT公开资源，核对版本`1e3c8bbd12fe89bc3ce8260e162508bdf2ab7a06`。在人设资源库搜索“星座”或“Zodiac”，读取来源包含SKILL.md、LICENSE和`prompts/zodiac_definitions/`下12份定义，共14个文本文件。该额外目录由仓库代码中的目录元数据明确允许，不开放任意路径；保持固定版本、文本/路径/符号链接/大小限制。

导入时在制作目标指定星座或组合，例如“制作天蝎座风格，简短幽默，服从当前群的语言和称呼设置”；不指定时会同时参考12种原型，建议先明确目标。只增加一个资源入口，不自动生成12个人设，不自动应用到任何群。多份独立星座Persona可在编辑器中新建，重复使用已导入的数据集；同源导入仍保持幂等。

## MBTI资源评估（2026-11-07，未加入目录）

[MCP Market页面](https://mcpmarket.com/zh/tools/skills/mbti-personality-ai-persona)保留SKILL.md，宣称16类MBTI、4个预设（Silent Tech Lead / Visionary PM / Reliable Mentor / Genius Teammate）及32种维度组合。思考、沟通与节奏描述可作为本项目Persona素材。

但原Skill针对Claude Code/OpenClaw，含CLAUDE.md/SOUL.md写入、固定角色昵称、对话内切换/召唤和推广引导；本项目需改为独立草稿，称呼与点名由群配置决定，发布和群绑定仍通过后台。它依赖`references/presets.md`、`references/mbti-types.md`、`references/dimensions.md`。页面GitHub链接`https://github.com/georgedoors888/gb-power-market-jj`本次查询返回404，尚未核验这三份完整参考文件及许可。用户本次仅要求评估，未将缺少可核验源码的条目加入可导入目录，也未下载/执行其CLI。
