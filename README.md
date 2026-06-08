# 千帆客服台机器人（四合一客服）

千帆买家消息 → 微信二号通知 → 二号引用回复 → 千帆买家端送达。

本项目将 **千帆客服工作台** 与 **微信** 打通：买家在千帆发消息后，二号微信收到待回复通知；二号引用该通知并回复文字后，消息自动发送到千帆买家会话。

---

## 功能概览

| 能力 | 说明 |
|------|------|
| 千帆消息监听 | 通过 DevTools/CDP 监听买家消息 |
| 微信通知 | 向配置的通知人（默认二号）发送 `【千帆待回复 #编号】` |
| 引用回复 | 二号引用通知回复，自动转发到千帆 |
| 多人通知 | 支持多个通知人，部分失败可续发 |
| 自动重连 | 千帆/微信/worker 异常时自动重试 |
| 授权校验 | 启动时读取有道云笔记开关（可跳过：`QIANFAN_SKIP_LICENSE_CHECK=1`） |

---

## 主链路

```
买家（千帆）发消息
    ↓
qianfan-listener 监听并识别
    ↓
wechat-notifier 合并后通知二号微信
    ↓
二号引用通知并回复
    ↓
wechat-reply → qianfan-sender 发送到千帆买家端
    ↓
二号收到「✅ 已回复 #编号」
```

---

## 快速开始

### 方式一：独立 EXE（推荐）

1. 安装依赖并打包：

```bash
npm install
npm run build
```

2. 双击运行：

- `dist/win-unpacked/千帆客服台机器人.exe`
- 或 `dist/启动千帆客服台机器人.bat`（若存在）

3. 首次运行会在 EXE **同目录** 自动生成：

- `config.wxbot-new.json` — 配置文件（含千帆路径模板）
- `data/` — 持久化数据
- `logs/` — 运行日志

4. 在界面中：

- 选择微信通知人
- 点击 **启动中转**
- 微信扫码登录后，等待「千帆已连接 + 微信已就绪」

> **无需手动开千帆调试模式**：启动中转时会自动检测千帆；若未运行或非调试模式，会自动关闭并以 `--remote-debugging-port=9223` 重新启动。

### 方式二：开发模式

```bash
npm install
npm start          # Electron 界面
# 或
npm run start:cli  # 命令行一键启动
```

开发前请将 `wxbot.exe` 放到 `tools/wxbot-new-runtime/`（打包时会内置）。

---

## 千帆自动调试模式

机器人依赖千帆 **9223** 调试端口读取消息。默认行为（`config.wxbot-new.json` → `qianfanDebug`）：

| 场景 | 自动处理 |
|------|----------|
| 千帆未运行 | 以调试参数自动启动 |
| 千帆在运行，但 9223 不可访问 | 结束千帆进程 → 调试模式重启 |
| 9223 已开，但不是千帆页面 | 若检测到千帆进程则重启；否则提示端口被 Chrome/Edge 占用 |
| 9223 已开且为千帆调试页 | 直接接入，不重复启动 |

相关配置项：

```json
{
  "qianfanDebug": {
    "enabled": true,
    "devtoolsPort": 9223,
    "qianfanClientExePath": "E:\\千帆\\eva\\千帆客服工作台.exe",
    "qianfanClientWorkingDir": "E:\\千帆\\eva",
    "autoLaunchQianfanClientWhenMissing": true,
    "autoCloseExistingQianfanClient": true
  }
}
```

若千帆安装路径不同，请修改 `qianfanClientExePath` 和 `qianfanClientWorkingDir`。

---

## 配置说明

配置文件：`config.wxbot-new.json`（与 EXE 同目录，已加入 `.gitignore`）

首次启动会从 `config.wxbot-new.example.json` 生成模板。

| 配置块 | 作用 |
|--------|------|
| `qianfanDebug` | 千帆路径、调试端口、自动启动/关闭 |
| `notifyAccounts` | 通知人列表（wxid、是否可回复） |
| `ui.autoStart` | 下次打开是否自动启动中转 |

内置默认账号（可在配置中覆盖）：

| 角色 | wxid |
|------|------|
| 机器人登录号 | `wxid_ddke8w2dtkcp22` |
| 通知/回复二号 | `wxid_jr6nn7q8lezg12` |

---

## 上传代码到 Gitee

仓库地址：

```
git@gitee.com:ff472336362/four-in-one-customer-service.git
```

**双击项目根目录的 `自动上传Gitee.bat`** 即可：

1. 检查/配置 `origin` 远程
2. `git pull --rebase` 同步远程
3. `git add -A` + 自动提交（带时间戳）
4. `git push` 到当前分支

### SSH 配置（首次使用）

1. 生成密钥：`ssh-keygen -t ed25519 -C "your_email"`
2. 将 `~/.ssh/id_ed25519.pub` 内容添加到 Gitee → 设置 → SSH 公钥
3. 测试：`ssh -T git@gitee.com`

---

## 目录结构

```
├── src/
│   ├── main/              Electron 主进程、IPC
│   ├── renderer/          界面
│   ├── workers/           分布式 worker（监听/通知/回复/持久化）
│   ├── adapters/          运行时适配层
│   ├── runtime/           Supervisor、消息总线、重启策略
│   ├── qianfan-message-listener.js   千帆 CDP 监听
│   ├── qianfan-wechat-notifier.js    微信通知
│   └── wechat/            wxbot 配置
├── tools/wxbot-new-runtime/   微信底座（wxbot.exe）
├── config.wxbot-new.example.json
├── 自动上传Gitee.bat
└── package.json
```

---

## 常用命令

| 命令 | 说明 |
|------|------|
| `npm start` | Electron 开发模式 |
| `npm run build` | 打包 Windows 目录版 |
| `npm run build:portable` | 单文件便携版 |
| `npm run check` | 快速检查（约 1–2 分钟） |
| `npm run check:full` | 全量检查（含混沌/长跑） |
| `npm run longrun:stable` | 100 天模拟稳定性测试 |

---

## 打包产物

| 命令 | 输出 |
|------|------|
| `npm run build` | `dist/win-unpacked/千帆客服台机器人.exe` |
| `npm run build:portable` | `dist/*.exe` 便携单文件 |
| `npm run build:setup` | NSIS 安装包 |

数据目录始终与 **EXE 同目录**，不会写入 `app.asar` 内部。

---

## 故障排查

### 千帆未连接

1. 确认 `config.wxbot-new.json` 中千帆路径正确
2. 确认 9223 未被其他 Chrome/Edge 占用
3. 查看 `logs/` 下日志，搜索 `[千帆]`
4. 手动验证：浏览器打开 `http://127.0.0.1:9223/json/list` 应能看到千帆页面

### 微信未就绪

1. 确认 `tools/wxbot-new-runtime/wxbot.exe` 存在
2. 界面提示扫码时，用机器人号登录微信
3. 运行 `npm run wx:check` 检查 wxbot 健康状态

### 上传 Gitee 失败

1. 检查 SSH：`ssh -T git@gitee.com`
2. 有冲突时手动：`git pull --rebase origin 你的分支`
3. 再执行 `git push`

### 授权失败

- 有道云笔记开关 `千帆中转=关` 时会退出
- 网络异常时 24 小时内可使用上次成功缓存
- 本地调试：`set QIANFAN_SKIP_LICENSE_CHECK=1`

---

## 开发说明

- Node.js >= 18
- 架构：Electron 主进程 + RuntimeSupervisor + 多 Worker 子进程
- Worker 从 `app.asar` 内 fork（无需 asarUnpack）
- 持久化经 `persistence.worker` 统一写入 `data/`

---

## 许可证

MIT
