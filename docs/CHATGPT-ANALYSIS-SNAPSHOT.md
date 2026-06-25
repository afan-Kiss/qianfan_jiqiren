# 千帆中转机器人 — ChatGPT 代码分析快照

> 分支用途：供外部 AI（ChatGPT 等）完整阅读源码、运行日志与持久化数据，分析稳定性与 bug 根因。  
> 生成时间：2026-06-25  
> **Git 分支**：`chatgpt-analysis-snapshot`  
> **仓库地址**：https://github.com/afan-Kiss/qianfan_jiqiren  
> **本快照入口**：https://github.com/afan-Kiss/qianfan_jiqiren/tree/chatgpt-analysis-snapshot  
> 基线 commit：`6ab0642` + 本地稳定性修复（见下文「未合并修复清单」）

---

## 1. 项目是什么

Electron 桌面应用 + 6-worker 分布式运行时，打通 **千帆客服工作台** 与 **微信**：

1. 买家在千帆发消息 → `qianfan-listener` 经 CDP 捕获  
2. → `wechat-notifier` 向二号微信发 `【千帆待回复 #编号】`  
3. 二号 **引用** 该通知并回复文字 → `wechat-callback` → `wechat-reply` → `qianfan-sender`  
4. 经 WebSocket（Phase A→B→C）发到千帆买家会话；成功/失败应回微信 `✅/❌`

**技术栈**：Node.js、Electron、Chrome DevTools Protocol、千帆 impaas WebSocket、wxbot DLL 回调。

---

## 2. 目录与源码地图（72 个 JS 文件）

### 2.1 入口与 UI

| 路径 | 职责 |
|------|------|
| `src/main/main.js` | Electron 主进程 |
| `src/main/ipc-bridge.js` | UI ↔ RuntimeSupervisor IPC |
| `src/main/preload.js` | 渲染进程桥 |
| `src/renderer/app.js` | 首页三灯健康、启动/停止中转 |
| `src/wxbot-new-oneclick.js` | CLI 模式入口（`npm run start:cli`） |

### 2.2 分布式运行时（当前稳定架构）

| 路径 | 职责 |
|------|------|
| `src/runtime/supervisor.js` | 启动/停止 6 个 worker、看门狗 |
| `src/runtime/watchdog.js` | 20s 心跳超时，触发 worker 重启 |
| `src/runtime/restart-policy.js` | 10 分钟窗口最多 10 次重启 |
| `src/runtime/message-bus.js` | worker 间 topic 路由 |
| `src/runtime/worker-runner.js` | 子进程 worker 生命周期 |
| `src/workers/worker-bootstrap.js` | worker 通用 bootstrap |

**6 个 Worker：**

| Worker | 文件 | 职责 |
|--------|------|------|
| qianfan-listener | `workers/qianfan-listener.worker.js` | CDP 连千帆、买家消息 → bus |
| wechat-notifier | `workers/wechat-notifier.worker.js` | 合并通知 → 微信 |
| wechat-callback | `workers/wechat-callback.worker.js` | wxbot HTTP 回调收微信消息 |
| wechat-reply | `workers/wechat-reply.worker.js` | 解析引用回复、触发发送 |
| qianfan-sender | `workers/qianfan-sender.worker.js` | 调用 WS bridge 发送 |
| persistence | `workers/persistence.worker.js` | JSON 持久化、去重 |

### 2.3 适配器层（legacy-* = worker 内业务逻辑）

| 路径 | 职责 |
|------|------|
| `adapters/legacy-qianfan-listener-adapter.js` | 监听句柄、店铺 attach |
| `adapters/legacy-wechat-notifier-adapter.js` | 通知文案、合并策略 |
| `adapters/legacy-wechat-callback-adapter.js` | 回调解析、转发 reply topic |
| `adapters/legacy-wechat-reply-adapter.js` | 引用回复解析 `#编号` |
| `adapters/legacy-qianfan-sender-adapter.js` | **发送核心**：CDP 就绪、会话解析、WS 发送 |
| `adapters/legacy-data-store-adapter.js` | persistence worker 的 action 处理器 |
| `adapters/qianfan-runtime-controller.js` | 千帆进程/调试端口控制 |

### 2.4 核心业务模块

| 路径 | 行数量级 | 职责 |
|------|----------|------|
| `src/qianfan-ws-bridge.js` | ~2100 | WS 连接、Phase A/B/C 发送、会话解析、`pickBuyerMessageForNick` |
| `src/qianfan-data-store.js` | ~500 | pending 通知、session context、receiver 缓存、去重 |
| `src/qianfan-message-listener.js` | | CDP 事件、买家消息识别 |
| `src/qianfan-wechat-notifier.js` | | 通知格式化 |
| `src/wechat-to-qianfan-reply.js` | | CLI 直连回复路径（含成功/失败回执） |
| `src/qianfan-send-guard.js` | | `sendOnlyBuyerNick` 白名单 |
| `src/wechat/wxbot-new-config.js` | | 配置加载（ROOT、wxid、千帆路径） |

### 2.5 未接入主线的实验代码（本快照一并上传供对比）

| 路径 | 说明 |
|------|------|
| `src/relay-service.js` | 单进程重构草案，**未 wired 到 ipc-bridge** |
| `src/listener-state.js` | 单进程监听状态，**未使用** |

---

## 3. 消息总线 Topic 速查

```
qianfan.buyer.message     → wechat-notifier
wechat.reply.received     → wechat-reply（解析引用）
qianfan.send.request      → qianfan-sender
qianfan.send.result       → wechat-reply（回执/UI）
persistence.*             → persistence worker
```

---

## 4. 发送链路详解（分析 bug 时重点读）

### 4.1 Phase A → B → C（`qianfan-ws-bridge.js`）

- **Phase A**：确保 impaas WS 已连接（必要时饭饭探针唤醒）  
- **Phase B**：构造 send payload（appCid、receiverAppUids、content）  
- **Phase C**：WS 发送 + ACK；成功后 `qianfan-native-sync` 触发 PC 端已读/同步  

### 4.2 会话解析（易错点）

`resolveReplyContextForSend(shopTitle, buyerNick, appCidHint)` 顺序：

1. 若有 `appCidHint` → 先拉该会话 HTTP message list  
2. 否则按 nick 拉 batch list  
3. 否则遍历 bridge active appCids  

`pickBuyerMessageForNick`：**nick 有值但无匹配时必须返回 null**（修复前会 fallback 到最后一条 → 发错人）。

### 4.3 Pending 上下文（`legacy-qianfan-sender-adapter.js`）

通知阶段写入 `pending-notifications.json`：`shopTitle`, `buyerNick`, `appCid`, `receiverAppUids`。

发送时应 **优先信任完整 pending**，不要被 HTTP 实时解析覆盖（修复前会覆盖成饭饭会话）。

---

## 5. 已知 Bug 与根因（有数据证据）

### 5.1 和田雅玉 · 买家「罗本」quote 失败（replyId #1092–#1094）

| replyId | 现象 | 根因 |
|---------|------|------|
| #1092/#1094 | 系统标记 sent，买家未收到 | `pickBuyerMessageForNick` fallback + HTTP 覆盖 pending → **appCid 指向饭饭会话** |
| #1093 | `LISTENER_NOT_READY` | CDP 瞬态不可用 + `isBuyerListenerActive()` 硬拦截 |

证据文件：

- `data/qianfan-sent-replies.json` — 搜索 `"replyId":1093`
- `data/failure-receipt-sent.json`
- `tmp/bot-send-debug/qianfan-send-debug-2026-06-24.jsonl` — 搜索 `1093` / `罗本`
- `logs/debug/qianfan-send-debug-2026-06-24.jsonl`

### 5.2 sendOnlyBuyerNick 误拦真实买家

默认曾为 `"饭饭"` → 正式买家（如欣欣吖 #1002）被 `qianfan-send-guard.js` 拦截。  
**生产必须**：`config.wxbot-new.json` → `"sendOnlyBuyerNick": ""`

### 5.3 Worker 路径缺微信成功回执

CLI 路径 `wechat-to-qianfan-reply.js` 有回执；worker 路径原先只有 Electron 活动日志 → 二号不知道是否成功。

---

## 6. 未合并修复清单（相对 origin/main）

以下改动在本分析分支中，**尚未合并到 main**：

| 文件 | 改动摘要 |
|------|----------|
| `qianfan-ws-bridge.js` | nick 无匹配不 fallback；`appCidHint` 优先；单 appCid 校验 nick；导出 `waitForBridgeCdpReady` |
| `legacy-qianfan-sender-adapter.js` | 信任完整 pending；CDP 5s 重试；listener 仅 warn；成功/失败微信回执；agent debug 埋点 |
| `qianfan-data-store.js` | `findReceiverCacheForShop` 指定 nick 无匹配返回 null |
| `qianfan-send-guard.js` + `wxbot-new-config.js` | 默认 `sendOnlyBuyerNick: ""` |
| `wechat-reply.worker.js` | 成功回执；skipped 原因也发失败回执 |
| `shared/agent-debug-log.js` | 调试会话埋点（验证后可删） |

完整 diff：`git diff origin/main..HEAD`

---

## 7. 运行数据快照说明

### 7.1 稳定运行窗口（来自 data/ 时间戳）

- 约 **2026-06-21 18:22** → **2026-06-24 18:15**（~72 小时）  
- 成功发送 ~106 次（见 `qianfan-sent-replies.json`）  
- 近期真实失败 mainly #1093（LISTENER_NOT_READY）

### 7.2 `data/` JSON 文件索引

| 文件 | 内容 |
|------|------|
| `pending-notifications.json` | 待回复通知上下文（发送时读 pending） |
| `qianfan-sent-replies.json` | 已成功回复记录 |
| `qianfan-send-pending.json` | 发送中/失败 pending（含 retryAt，**无消费 worker**） |
| `qianfan-session-context.json` | appCid → buyerNick 映射 |
| `app-cid-receivers.json` | receiverAppUids 缓存 |
| `wechat-reply-dedup.json` | 引用回复去重 |
| `failure-receipt-sent.json` | 已发失败回执 dedup |
| `sent-notification-map.json` | 通知 id 映射 |
| `notified-message-ids.json` | 已通知千帆 msgId |
| `buyer-notify-claims.json` | 通知合并 claim |
| `dead-letters.json` | 死信 |
| `reply-id-counter.json` | 单调递增 #编号 |

> **未上传**：`data/wechat-image-cache/`（二进制图片，对代码分析无帮助）

### 7.3 日志目录

| 路径 | 内容 |
|------|------|
| `logs/runtime-YYYY-MM-DD.log` | supervisor 主日志 |
| `logs/worker-*-YYYY-MM-DD.log` | 各 worker 日志 |
| `logs/dead-letter-*.log` | 死信 |
| `logs/debug/qianfan-send-debug-*.jsonl` | WS 发送逐步 debug |
| `logs/debug/wxbot-callback-*.jsonl` | 微信回调 raw |
| `logs/debug/qianfan-to-wechat-*.jsonl` | 千帆→微信通知 debug |
| `tmp/bot-send-debug/` | 发送 debug 副本 |

---

## 8. 配置说明

| 文件 | 说明 |
|------|------|
| `config.wxbot-new.example.json` | 无密钥模板 |
| `config.wxbot-new.snapshot.json` | **本快照上传**：真实结构，wxid/wechatNo 已脱敏 |

`config.wxbot-new.example.json` 关键字段：

```json
{
  "qianfanDebug": {
    "expectedShopCount": 4,
    "wsWakeBuyerNick": "饭饭",
    "sendOnlyBuyerNick": ""
  }
}
```

- `wsWakeBuyerNick`：仅 WS Phase C 饭饭探针，**不限制**对客发送  
- `sendOnlyBuyerNick: ""`：生产对全部买家发送  
- 原始 `config.wxbot-new.json`（含真实 wxid）**未上传**，见 `config.wxbot-new.snapshot.json`

---

## 9. 给 ChatGPT 的分析提示词（可直接复制）

```
你是 Node.js/Electron 专家。仓库是「千帆客服台机器人」。

请先读 docs/CHATGPT-ANALYSIS-SNAPSHOT.md，然后：

1. 梳理 6-worker 架构与 qianfan.send 全链路（从 wechat.reply.received 到 WS ACK）。
2. 对照 data/qianfan-sent-replies.json 与 logs/debug/qianfan-send-debug-*.jsonl，
   分析 replyId 1092-1094（买家罗本/和田雅玉）为何发错会话或 LISTENER_NOT_READY。
3. 评估「未合并修复清单」是否完整，有无回归风险。
4. 列出 P0/P1 稳定性改进（自动重试、失败队列、告警），附具体改哪些函数。

重点文件：qianfan-ws-bridge.js, legacy-qianfan-sender-adapter.js,
qianfan-data-store.js, wechat-reply.worker.js, supervisor.js, watchdog.js
```

---

## 10. 本快照已上传 vs 未上传

### 已上传（`chatgpt-analysis-snapshot` 分支）

| 路径 | 约大小 | 说明 |
|------|--------|------|
| `src/` 全部源码 | — | 含稳定性修复 + 实验 `relay-service.js` |
| `docs/CHATGPT-ANALYSIS-SNAPSHOT.md` | — | 本文档 |
| `data/*.json` | ~1MB | 持久化业务数据 |
| `data/wechat-image-cache/` | ~9MB | 微信图片缓存 |
| `logs/` | ~30MB | runtime/worker/debug 全量日志 |
| `tmp/bot-send-debug/` | ~0.3MB | WS 发送 debug jsonl |
| `config.wxbot-new.snapshot.json` | — | 脱敏配置快照 |
| `scripts/check-send-chain-health.js` | — | 发送链健康检查 |

### 故意未上传

| 路径 | 原因 |
|------|------|
| `node_modules/` | `npm install` 可恢复 |
| `dist/`, `dist-build*`, `dist-github/` | Electron 打包 ~280MB–1.4GB，GitHub 单文件 100MB 限制 |
| `config.wxbot-new.json` | 含真实 wxid（见脱敏 snapshot） |
| `NoveHelper.dll`, `NoveLoader.dll`, `wxbot.exe` | 二进制依赖 |

---

## 11. 本地复现

```bash
npm install
npm run start          # Electron UI
npm run start:cli      # 纯 CLI
npm run check:runtime  # 架构自检
```

打包：`npm run build` → `dist/win-unpacked/千帆客服台机器人.exe`
