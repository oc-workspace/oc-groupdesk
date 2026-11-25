# GroupDesk macOS 原生独立安装包（免 Docker）

本包为 **macOS 原生独立站点包（不依赖 Docker）**，内置独立 Node.js 运行时、独立可重定位 PostgreSQL 16 数据库、预构建的前后端产物及 `manage-macos.py` 管理工具。

- **干净发行边界**：不含原站点的机器人、群聊、聊天记录、用户、付费 Key、私人 Persona、第三方 Skill 或微信登录资料；仅包含独立编写的五份基础总结模板。
- **默认隔离与安全**：Web 与私有 PostgreSQL 均默认仅绑定本机回环 `127.0.0.1`；私有数据与配置保存在独立目录（权限 `0700` / `0600`），不触碰本机已有的 PostgreSQL 或线上环境；后台 worker 默认关闭，须显式开启。
- **不包含微信与机器人运行端**：站点安装启动成功不代表微信/Reader/MaiBot 已接通，机器人宿主机仍按各自接入向导单独准备与备份。

---

## 方式一：图形化快捷启动（推荐给本机测试）

1. 双击打开 `groupdesk-standalone-*-macos-*.dmg`。
2. 将 `GroupDesk.app` 拖入 `Applications`（或直接从挂载卷复制到任意本机目录）。
3. 双击 `GroupDesk.app`：
   - **首次运行**：会自动打开终端，引导你在 `~/Library/Application Support/GroupDesk/default` 初始化新实例（隐藏输入 16 位以上管理员密码），自动启动私有 PostgreSQL 16 与 GroupDesk 网页服务，并在浏览器打开 `http://localhost:3110`。
   - **后续再次双击**：若服务已停止则自动启动并打开网页；若已在运行，会弹出控制窗口，支持 **打开网页**、**查看日志** 或 **停止服务**。

> 若从网络下载后触发 macOS 首次未公证提示，可在「系统设置 → 隐私与安全性」中选择「仍要打开」，或在终端对该 `.app` 执行 `xattr -dr com.apple.quarantine /Applications/GroupDesk.app`。

---

## 方式二：命令行管理（支持多实例、自定义端口、备份与恢复）

安装包内的管理工具位于：
- `.dmg` 安装后：`/Applications/GroupDesk.app/Contents/Resources/bundle/distribution/manage-macos.py`
- `.tar.gz` 解压后：`<解压目录>/distribution/manage-macos.py`

前提仅需 macOS 自带或本机 Python 3.10+（加密备份/恢复另需 GnuPG，可通过 `brew install gnupg` 安装）。

### 1. 初始化并启动新实例

```sh
MANAGE="/Applications/GroupDesk.app/Contents/Resources/bundle/distribution/manage-macos.py"

python3 "$MANAGE" init \
  --target "$HOME/groupdesk-test-instance" \
  --project gd-mac-test \
  --port 3110

python3 "$MANAGE" up --target "$HOME/groupdesk-test-instance"
```

- `init` 会隐藏输入 16 位以上管理员密码，自动生成独立的数据库角色/密码、加密密钥和机器人令牌，并自动分配一个不冲突的私有 PostgreSQL 回环端口（也可用 `--pg-port` 指定）。
- 已存在的目标目录或被占用的端口会直接中止，绝不覆盖旧数据。
- 启动成功后访问 `http://localhost:3110` 登录；业务空间默认全空。

### 2. 常用运维命令

```sh
# 查看运行状态（可加 --json）
python3 "$MANAGE" status --target "$HOME/groupdesk-test-instance"

# 查看日志（可指定 --service app|postgres|worker|interaction-worker）
python3 "$MANAGE" logs --target "$HOME/groupdesk-test-instance"

# 显式开启后台 worker（需先核对模型 Key 和计划）
python3 "$MANAGE" up --target "$HOME/groupdesk-test-instance" --workers

# 停止全部服务（含私有 PostgreSQL）
python3 "$MANAGE" down --target "$HOME/groupdesk-test-instance"

# 可选：注册/移除当前用户登录自启 LaunchAgent
python3 "$MANAGE" launchd-install --target "$HOME/groupdesk-test-instance"
python3 "$MANAGE" launchd-uninstall --target "$HOME/groupdesk-test-instance"
```

### 3. 加密备份与空实例恢复

```sh
# 加密备份（自动暂停写入、校验全部表指纹与密文解密）
python3 "$MANAGE" backup \
  --target "$HOME/groupdesk-test-instance" \
  --output "$HOME/groupdesk-backup.gpg" \
  --passphrase-file "$HOME/.groupdesk-recovery-passphrase"

# 初始化一个全新空目标并恢复
python3 "$MANAGE" init \
  --target "$HOME/groupdesk-restore-test" \
  --project gd-mac-restore \
  --port 3111 \
  --isolated

python3 "$MANAGE" restore \
  --target "$HOME/groupdesk-restore-test" \
  --source "$HOME/groupdesk-backup.gpg" \
  --passphrase-file "$HOME/.groupdesk-recovery-passphrase" \
  --confirm-empty-target
```

- 恢复仅允许全新的空目标；恢复前逐表核对原始指纹，恢复后自动执行 `reconcile.ts` 暂停所有机器人、失效旧令牌/配对码、停用旧定时计划且不启动 worker。
- 原生模式的 `--isolated` 会禁止启动 worker 并为进程注入失效代理变量以阻止常规 HTTP 出站，但不同于 Linux Docker 内部网络命名空间隔离；公网访问仍须另行配置 HTTPS 反向代理及 `--origin https://your-domain.example`。
