# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

这是一个通过 DLL 注入技术实现的微信机器人项目,从 Python 迁移到 Go。使用系统级 API 与微信进程交互。

**技术栈**: Go 1.18+
**目标平台**: Windows 32位
**核心技术**: DLL注入、共享内存、Windows API

## 构建与运行

### 常用命令

```bash
# 构建 (生成 dist/wxbot.exe)
make build

# 调试构建 (保留符号)
make build-debug

# 格式化代码
make fmt

# 代码检查
make lint

# 清理构建产物
make clean

# 整理依赖
make tidy
```

### 构建要求

- 必须编译为 **32位 Windows** 程序: `GOOS=windows GOARCH=386`
- **启用 CGO**: `CGO_ENABLED=1` (使用 C 回调降低检测风险)
- 需要 MinGW-w64 交叉编译器: `i686-w64-mingw32-gcc`
- 运行需要 `NoveLoader.dll` 和 `NoveHelper.dll` 在同目录

### 编译环境配置

```bash
# macOS
brew install mingw-w64

# Ubuntu/Debian
sudo apt install gcc-mingw-w64-i686

# Fedora/RHEL
sudo dnf install mingw32-gcc

# 验证安装
make check-compiler
```

## 代码架构

### 目录结构

```
wxbot-new/
├── main.go                      # 入口: 信号处理、资源初始化
├── internal/
│   ├── memory/                  # 共享内存管理 (33字节固定密钥)
│   ├── loader/                  # DLL 加载器和回调系统
│   │   ├── loader.go           # DLL 函数调用 (通过偏移地址)
│   │   └── callback.go         # Go↔C 回调转换
│   ├── message/                 # 消息类型定义 (11024-11046)
│   └── service/                 # 微信服务编排
│       ├── service.go          # 生命周期管理、心跳监控、重连
│       └── helper.go           # 高级 API (发送消息等)
```

### 分层架构

```
main.go (入口层)
    ↓
service (业务服务层) - WeChatService 编排
    ↓
loader (DLL加载层) - NoveLoader + CallbackManager
    ↓
memory + message (基础设施层)
```

### 关键模块

**1. SharedMemoryManager** (`internal/memory/shared_memory.go`)
- 创建名为 `windows_shell_global__` 的 33 字节共享内存
- 写入固定密钥: `3101b223dca7715b0154924f0eeeee20`
- 使用 Windows API: CreateFileMappingA, MapViewOfFile

**2. NoveLoader** (`internal/loader/loader.go`)
- 通过**硬编码偏移地址**调用 DLL 非导出函数 (如 `offsetInitWeChatSocket = 0xB080`)
- 支持 8 个核心函数: InitWeChatSocket, InjectWeChat, SendWeChatData 等
- ⚠️ 偏移地址与 DLL 版本强绑定

**3. CallbackManager** (`internal/loader/callback.go`) ⭐ **CGO 实现**
- 使用 **纯 C 函数**作为回调（降低检测风险，替代 `windows.NewCallback`）
- 回调流程: `C 函数 → //export Go 函数 → globalCallbackManager`
- 管理 3 类回调: 连接/接收消息/断开
- 线程安全 (sync.RWMutex)
- 详见: [CGO_MIGRATION.md](CGO_MIGRATION.md)

**4. WeChatService** (`internal/service/service.go`)
- **心跳监控**: 每 60 秒检查,120 秒无响应触发重连
- **自动重连**: 最多 5 次,延迟 10 秒
- **生命周期**: Initialize → Start → Stop (defer 清理资源)

**5. Helper 方法** (`internal/service/helper.go`)
- 提供 9 个便捷方法: `HelperSendText`, `HelperSendImage` 等
- 统一流程: 构造 Message → JSON 序列化 → SendMessage

## 开发规范

### Commit 格式

遵循 Conventional Commits:
```
feat(core): 添加新功能
fix(service): 修复连接断线问题
refactor(loader): 重构 DLL 调用逻辑
```

### 代码风格

- 使用 `go fmt` 自动格式化
- 导出标识符用 PascalCase,非导出用 camelCase
- 错误必须返回 error 并就地处理

### 测试要求

- 使用原生 `testing` 框架
- 核心模块覆盖率 ≥ 60%
- 优先使用表驱动测试

## 核心技术要点

### 1. 指针和内存管理

```go
// 大量使用 unsafe.Pointer
funcAddr := baseAddr + offset
syscall.Syscall9(funcAddr, numArgs, ...)

// C 字符串处理 (null 终止符)
cStr := append([]byte(str), 0)
```

### 2. 回调函数转换

```go
// Go 函数 → C 回调指针
callback := windows.NewCallback(func(clientID uintptr, ...) uintptr {
    // 必须在有效 goroutine 中执行
    return 0
})
```

### 3. 消息类型

所有消息类型定义在 `message/types.go`:
- MTUserLogin (11025): 用户登录
- MTSendText (11036): 发送文本
- MTChatMessage (11046): 聊天消息

### 4. 并发模型

- Goroutine: 心跳监控、主服务循环
- Channel: 信号传递 (quit)
- Mutex: 保护共享状态 (connectedClients, lastHeartbeat)

## 修改代码指南

### 添加新消息类型

1. 在 `message/types.go` 添加常量:
```go
const MTNewType = 11047
```

2. 定义数据结构:
```go
type NewTypeData struct {
    Field1 string `json:"field1"`
}
```

3. 在 `service/helper.go` 添加 Helper 方法

### 调整重连策略

修改 `service/service.go` 的字段:
```go
maxReconnectAttempts int         // 默认 5
reconnectDelay       time.Duration // 默认 10s
```

### 自定义消息处理

编辑 `service.go` 的 `registerCallbacks()`:
```go
s.loader.GetCallbackManager().AddRecvCallback(func(clientID uintptr, msgType int, data map[string]interface{}) {
    switch msgType {
    case message.MTChatMessage:
        // 自定义处理逻辑
    }
})
```

### 更新 DLL 偏移地址

如果 DLL 版本更新,修改 `loader/loader.go`:
```go
const (
    offsetInitWeChatSocket = 0xXXXX // 新偏移
)
```

## 注意事项

### 安全与合规

⚠️ **本项目使用侵入性技术 (DLL 注入)**
- 仅限授权测试环境
- 可能违反微信服务条款
- 可能被杀毒软件拦截
- 仅供学习交流

### 技术限制

1. **32位依赖**: 必须编译为 386 架构
2. **DLL 版本**: 偏移地址硬编码,DLL 升级需同步更新
3. **平台限制**: 仅支持 Windows
4. **进程单例**: 每个实例只能管理一个微信连接

## 常见问题

**Q: 编译后无法运行?**
A: 确保编译为 32 位 (`GOARCH=386`),且 DLL 文件在当前目录

**Q: 如何启用调试日志?**
A: 调用 `loader.SetDebugMode(true)`

**Q: 消息发送失败?**
A: 检查 clientID 是否有效、微信是否已登录、网络是否正常

**Q: 心跳超时频繁?**
A: 可能是微信进程不稳定,检查微信版本兼容性

## 扩展方向

1. **HTTP API**: 添加 Web 服务层,通过 REST API 控制
2. **插件系统**: 动态加载消息处理插件
3. **多账号支持**: 管理多个微信实例
4. **数据持久化**: 存储聊天记录到数据库
5. **配置文件**: 将硬编码参数提取到配置文件
