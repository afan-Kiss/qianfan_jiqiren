# 发送后 PC 原生同步链 — Cursor 必读

> **项目**：`E:\我的软件源码\千帆中转机器人`  
> **状态**：✅ **已集成**（2026-06-09）  
> **参考实现（只读）**：`e:\抓手机端回复`

---

## ⚠️ 修改范围约束（最高优先级）

**只允许做一件事**：机器人 `sendQianfanTextReply` 在 **ACK 成功之后**，触发千帆 Windows 端自己的原生同步链，让 PC 客服台插入气泡、清除倒计时、更新弹窗。

### ✅ 允许改动的文件（白名单）

| 文件 | 作用 |
|------|------|
| `src/qianfan-native-sync.js` | ACK 后 31010+30001 sync / read / HTTP 刷新 |
| `src/qianfan-ws-bridge.js` | 发送入口；ACK 后调用 `triggerNativeSyncAfterAck` |
| `src/qianfan-ui-sync.js` | 辅助：重选会话、HTTP 模板；**已移除假气泡** |
| `src/capture/bot-send-debug.js` | 发送调试日志（ws-bridge 引用） |
| `scripts/test-native-sync-send.js` | 独立验收脚本 |

### 🚫 禁止改动的模块

| 模块 | 原因 |
|------|------|
| `src/workers/*` | worker 拓扑不变 |
| `src/wechat-to-qianfan-reply.js` | 微信引用回复逻辑不变 |
| `src/adapters/*`（除上述白名单外） | 适配层接口不变 |
| `src/qianfan-message-listener.js` | 买家监听不变 |
| `src/qianfan-data-store.js` | 持久化/去重不变 |
| `src/qianfan-wechat-notifier.js` | 微信通知不变 |
| `src/renderer/*`、`src/main/*` | UI/Electron 主进程不变 |
| `electron-builder` 配置 | 打包配置不变 |

**禁止行为**：
- 禁止 `injectLocalEcho` 假 DOM 气泡
- 禁止改千帆页面样式
- 禁止改微信回调、去重、通知、持久化逻辑
- 禁止改 worker topic 路由

---

## 已完成的集成内容

### 新增文件
- `src/qianfan-native-sync.js`
- `src/capture/bot-send-debug.js`
- `scripts/test-native-sync-send.js`

### 覆盖文件
- `src/qianfan-ws-bridge.js` — ACK 后从 `syncQianfanConversationUi` 改为 `triggerNativeSyncAfterAck`
- `src/qianfan-ui-sync.js` — 移除假气泡注入路径

### 调用链（未改其他环节）

```
微信引用回复
  → wechat-reply.worker
  → qianfan-sender.worker
  → qianfan-listener.worker
  → legacy-qianfan-sender-adapter.sendQianfanReplyRequest()
  → sendQianfanTextReply()                    ← 仅此处 ACK 后多了原生同步
       ├─ /message/send → ACK
       └─ triggerNativeSyncAfterAck()         ← 新增
```

---

## 原生同步链原理（fixMode: ack_then_native_sync）

ACK 拿到 `msgId` 后，按顺序执行：

```
1. installNativeSyncBridge（页面注入 __qfDispatchWsMessage）
2. HTTP 预热消息列表
3. dispatch WebSocket MessageEvent：31010 预告帧
4. dispatch WebSocket MessageEvent：30001 userMessage 帧
5. 原生重选当前会话（reselectConversation）
6. 再 dispatch 一次 30001
7. 页面 WS 发送 /message/read/from/one（清倒计时/弹窗）
8. HTTP 刷新消息列表 + unchecked/ai/msg
9. 只读观测 UI（pcBubbleInsertedByQianfan 等，不改 DOM）
```

关键帧类型（之前错误用过 type=1，必须是）：
- **31010** — 预告 `{appCid, msgId, time}`
- **30001** — 完整 `userMessage`，插入气泡

---

## 给 Cursor 的执行提示词

```
本项目 E:\我的软件源码\千帆中转机器人 已集成「发送后 PC 原生同步链」。

请先阅读 docs/NATIVE-SYNC-AFTER-SEND.md。

若需修复/增强， ONLY 改白名单内 5 个文件，且 ONLY 围绕 sendQianfanTextReply ACK 后的 triggerNativeSyncAfterAck 链路。

禁止：改 worker、微信回调、通知、去重、UI、打包配置；禁止 injectLocalEcho 假气泡。

验收：npm run check:quick 必须通过；可选 node scripts/test-native-sync-send.js 实测。
```

---

## 验收命令

### 1. 静态检查（必跑）

```powershell
cd "E:\我的软件源码\千帆中转机器人"
npm run check:quick
```

### 2. 独立发送测试（千帆客服台 + 调试端口 9223 已开）

```powershell
node scripts/test-native-sync-send.js --shop "你的店铺名" --text "原生同步验收"
```

**不要**在 PowerShell 里裸传 `--appCid $3$...`（`$3` 会被吃掉）。不传 `--appCid` 即可。

### 3. 生产链路（微信二号引用回复）

1. 重启机器人
2. 买家发消息 → 微信收到待回复
3. 二号引用回复
4. 确认：买家收到 + PC 右侧气泡 + 倒计时消失 + 弹窗消失

### 4. 日志验收

路径：`logs/debug/qianfan-send-debug-YYYY-MM-DD.jsonl`  
打包版：`dist/win-unpacked/logs/debug/...`

找 `"event":"send_final"`，期望：

```json
{
  "fixMode": "ack_then_native_sync",
  "bubbleInserted": true,
  "countdownCleared": true,
  "popupCleared": true,
  "directDomMutationUsed": false,
  "syncPrelude31010Dispatched": true,
  "syncUserMessage30001Dispatched": true,
  "readFromOneSent": true
}
```

---

## 核心 API（仅供白名单内文件使用）

```javascript
// qianfan-ws-bridge.js — ACK 成功后
const pcSync = await triggerNativeSyncAfterAck({
  bridge,
  shopTitle: bridge.shopTitle,
  appCid,
  text,
  ack,
  ackParsed: ack.ackParsed,
  receiverAppUids: finalReceiverAppUids,
  seq: ctx.seq,
  chatId: sessionContext?.chatId || extractChatIdFromBridge(bridge) || null,
  token: sessionContext?.staffToken || '1#1#4#4333439630',
  fixMode: 'ack_then_native_sync',
});
```

```javascript
// qianfan-native-sync.js — 主入口
module.exports = {
  triggerNativeSyncAfterAck,
  buildSyncUnreliableFrames,
  buildReadFromOneFrame,
  installNativeSyncBridge,
};
```

---

## 常见问题

| 现象 | 处理 |
|------|------|
| ACK 超时 | 确认千帆店铺页已开、WS 已连；重试一次 |
| 气泡未插入 | 查 `syncPrelude31010Dispatched` / `syncUserMessage30001Dispatched` |
| 倒计时未清 | 查 `readFromOneSent`；确认 `receiverAppUids` 正确 |
| `conversationReselected: false` | 非致命，sync dispatch 仍可能成功 |
| 集成后需生效 | **重启机器人**；已打包版需 `npm run build:dir` 重新打包 |

---

## 参考测试数据（饭饭买家，XY祥钰珠宝）

```
appCid: $3$MSMyIzIjNjAyMTNhZmQwMDAwMDAwMDAxMDA1NWZk.MSMzIzYjNmEwMThmYTUzMGM5Y2YwMDE1MTIwMjJh
receiverAppUids: 1#2#2#60213afd00000000010055fd
DevTools: 127.0.0.1:9223
```

参考项目在 `e:\抓手机端回复` 已连续 4 次实测通过。

---

## 若需从参考项目重新同步

```powershell
$SRC = "e:\抓手机端回复"
$DST = "E:\我的软件源码\千帆中转机器人"

Copy-Item "$SRC\src\qianfan-native-sync.js" "$DST\src\qianfan-native-sync.js" -Force
Copy-Item "$SRC\src\qianfan-ui-sync.js" "$DST\src\qianfan-ui-sync.js" -Force
Copy-Item "$SRC\src\qianfan-ws-bridge.js" "$DST\src\qianfan-ws-bridge.js" -Force
Copy-Item "$SRC\src\capture\bot-send-debug.js" "$DST\src\capture\bot-send-debug.js" -Force
Copy-Item "$SRC\scripts\test-native-sync-send.js" "$DST\scripts\test-native-sync-send.js" -Force
```

同步后运行 `npm run check:quick` 并重启机器人。

---

*文档版本：2026-06-09 | 集成状态：已完成*
