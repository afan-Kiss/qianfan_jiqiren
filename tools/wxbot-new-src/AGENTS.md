# Repository Guidelines

本指南面向贡献者，帮助你快速理解仓库结构、开发流程与协作规范，保持代码一致、稳定、可维护。

## 项目结构与模块组织

- 根目录：`main.go` 为程序入口，`config.example.json` 为配置示例。
- 核心逻辑：位于 `internal/` 目录，按职责划分为 `loader/`、`memory/`、`message/`、`service/` 等包。
- 构建产物：`dist/` 保存构建后的 Windows 32 位可执行文件。
- 示例脚本：`pythondemo.py` 仅作对照，不参与构建。

## 构建、测试与本地开发命令

- `make tidy`：整理 Go 依赖（`go mod tidy`）。
- `make build`：构建 32 位 Windows 可执行文件到 `dist/wxbot.exe`。
- `make build-debug`：调试构建，保留符号信息。
- `make run`：在 Windows 上直接运行程序（需 32 位环境）。
- `make fmt`：格式化代码（`go fmt ./...`）。
- `make lint`：静态检查（优先 `golangci-lint`，否则 `go vet`）。
- 示例：`make example-basic`、`make example-auto-reply` 构建示例程序。

## 代码风格与命名约定

- 风格：遵循 Go 官方风格，使用 `go fmt`；缩进使用 Tab。
- 包名：全小写、简短、无下划线，如 `service`、`loader`。
- 文件名：小写，可使用下划线，如 `shared_memory.go`。
- 命名：导出标识符用 PascalCase，非导出用 camelCase。
- 错误处理：统一返回 `error`，就地记录日志或向上返回。

## 测试规范

- 测试框架：使用 Go 原生 `testing` 包。
- 文件命名：与被测文件同目录，文件名以 `_test.go` 结尾。
- 用例命名：`TestXxx(t *testing.T)`，推荐使用表驱动测试。
- 运行测试：执行 `go test ./... -v -cover`，核心模块覆盖率建议 ≥ 60%。

## Commit 与 Pull Request 规范

- Commit 信息：遵循 Conventional Commits，例如：
  - `feat(core): add message dispatcher`
  - `fix(service): handle empty payload`
- Pull Request 要求：
  - 说明动机、变更点与影响范围，关联 Issue（如 `Closes #123`）。
  - 附本地验证结果（日志/截图），说明可能风险与回滚方案。
  - 提交前确保通过 `make fmt`、`make lint` 并可成功构建。

## 安全与配置提示

- 仅支持 Windows 32 位：`GOOS=windows`、`GOARCH=386`。
- 请将 `NoveLoader.dll`、`NoveHelper.dll` 放在项目根目录以便加载。
- DLL 注入具侵入性，仅在授权与隔离测试环境使用；不要提交 DLL 或敏感配置。

## 架构概览

- 入口层：`main.go` 负责加载配置、初始化日志与核心服务。
- 集成层：`internal/loader` 负责与 DLL 交互，完成微信客户端注入与事件回调。
- 基础设施层：`internal/memory` 管理共享内存与进程间数据交换。
- 域模型层：`internal/message` 定义消息结构、消息类型常量及解析逻辑。
- 业务编排层：`internal/service` 负责消息路由、业务流程编排，对外暴露统一服务接口。

## 贡献者工作流建议

- 新功能：优先在 `internal/service` 中增加编排逻辑，将底层能力封装成清晰接口后再暴露给上层。
- 修改协议或结构：先更新 `internal/message` 中的模型与常量，再调整 `loader`、`service` 的调用。
- 调试建议：本地使用 `make build-debug` 生成可调试二进制，结合日志和 DLL 日志定位问题。
- 变更验证：每次修改后至少执行 `make fmt`、`make lint` 与 `go test ./...`，再进行构建测试。
