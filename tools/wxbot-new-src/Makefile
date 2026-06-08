SHELL := /bin/bash

# 仅构建 32 位 Windows 可执行文件
OS := windows
ARCH := 386

APP := wxbot
MAIN := .

DIST := dist
OUT_EXE := $(DIST)/$(APP).exe

# CGO 配置
CGO_ENABLED := 1
# 检测操作系统，自动选择合适的编译器
ifeq ($(shell uname -s),Darwin)
    # macOS 下使用 Homebrew 安装的 mingw-w64
    CC := i686-w64-mingw32-gcc
    # 检查编译器是否存在
    CC_CHECK := $(shell command -v $(CC) 2> /dev/null)
else ifeq ($(shell uname -s),Linux)
    # Linux 下使用系统包管理器安装的 mingw-w64
    CC := i686-w64-mingw32-gcc
    CC_CHECK := $(shell command -v $(CC) 2> /dev/null)
else
    # Windows 下直接使用 gcc
    CC := gcc
    CC_CHECK := $(shell where gcc 2> nul)
endif

# LDFLAGS 优化选项
LDFLAGS := -s -w -extldflags "-static"

.PHONY: all build build-debug clean tidy run help example-basic example-auto-reply check-compiler

all: build

help:
	@echo "可用命令:"
	@echo "  make build              - 构建 32 位 Windows 可执行文件 (CGO 启用)"
	@echo "  make build-debug        - 构建调试版本 (保留符号表)"
	@echo "  make clean              - 清理 dist 目录"
	@echo "  make tidy               - 整理 Go 依赖"
	@echo "  make run                - 直接运行程序（需在 Windows 上）"
	@echo "  make check-compiler     - 检查 MinGW-w64 编译器是否安装"
	@echo "  make example-basic      - 构建基本使用示例"
	@echo "  make example-auto-reply - 构建自动回复示例"
	@echo ""
	@echo "CGO 编译要求:"
	@echo "  - macOS: brew install mingw-w64"
	@echo "  - Linux: apt install gcc-mingw-w64-i686 或 yum install mingw32-gcc"
	@echo "  - Windows: 安装 MinGW-w64 (https://www.mingw-w64.org/)"

check-compiler:
	@echo "检查 MinGW-w64 编译器..."
ifndef CC_CHECK
	@echo "❌ 错误: 未找到 32 位交叉编译器: $(CC)"
	@echo ""
	@echo "请安装 MinGW-w64:"
	@echo "  - macOS:   brew install mingw-w64"
	@echo "  - Ubuntu:  sudo apt install gcc-mingw-w64-i686"
	@echo "  - Fedora:  sudo dnf install mingw32-gcc"
	@echo "  - Windows: 下载 https://www.mingw-w64.org/"
	@exit 1
else
	@echo "✓ 找到编译器: $(CC_CHECK)"
	@$(CC) --version | head -n 1
endif

tidy:
	@echo "整理 Go 依赖..."
	@go mod tidy
	@echo "✓ 依赖整理完成"

build: check-compiler tidy
	@echo "开始构建 (CGO 模式)..."
	@mkdir -p $(DIST)
	@echo "  - 目标: $(OS)/$(ARCH)"
	@echo "  - 编译器: $(CC)"
	@echo "  - 输出: $(OUT_EXE)"
	@GOOS=$(OS) GOARCH=$(ARCH) CGO_ENABLED=$(CGO_ENABLED) CC=$(CC) \
		go build -trimpath -ldflags="$(LDFLAGS)" -o $(OUT_EXE) $(MAIN)
	@echo "✓ 构建完成: $(OUT_EXE)"
	@echo "  文件大小: $$(du -h $(OUT_EXE) | cut -f1)"

build-debug: check-compiler tidy
	@echo "开始构建调试版本 (CGO 模式)..."
	@mkdir -p $(DIST)
	@GOOS=$(OS) GOARCH=$(ARCH) CGO_ENABLED=$(CGO_ENABLED) CC=$(CC) \
		go build -trimpath -gcflags="all=-N -l" -o $(OUT_EXE) $(MAIN)
	@echo "✓ 调试版本构建完成: $(OUT_EXE)"

example-basic: check-compiler tidy
	@echo "构建基本示例..."
	@mkdir -p $(DIST)
	@GOOS=$(OS) GOARCH=$(ARCH) CGO_ENABLED=$(CGO_ENABLED) CC=$(CC) \
		go build -trimpath -ldflags="$(LDFLAGS)" -o $(DIST)/basic_usage.exe ./examples/basic_usage.go
	@echo "✓ 基本示例构建完成: $(DIST)/basic_usage.exe"

example-auto-reply: check-compiler tidy
	@echo "构建自动回复示例..."
	@mkdir -p $(DIST)
	@GOOS=$(OS) GOARCH=$(ARCH) CGO_ENABLED=$(CGO_ENABLED) CC=$(CC) \
		go build -trimpath -ldflags="$(LDFLAGS)" -o $(DIST)/auto_reply.exe ./examples/auto_reply.go
	@echo "✓ 自动回复示例构建完成: $(DIST)/auto_reply.exe"

run:
	@if [ "$(shell go env GOOS)" != "windows" ]; then \
		echo "❌ 错误: 此程序只能在 Windows 上运行"; \
		exit 1; \
	fi
	@GOARCH=$(ARCH) CGO_ENABLED=$(CGO_ENABLED) go run $(MAIN)

clean:
	@echo "清理构建产物..."
	@rm -rf $(DIST)
	@echo "✓ 已清理 dist 目录"

# 格式化代码
fmt:
	@echo "格式化代码..."
	@go fmt ./...
	@echo "✓ 代码格式化完成"

# 代码检查
lint:
	@echo "代码检查..."
	@if command -v golangci-lint >/dev/null 2>&1; then \
		golangci-lint run; \
	else \
		go vet ./...; \
	fi
	@echo "✓ 代码检查完成"

# 显示构建信息
info:
	@echo "构建配置信息:"
	@echo "  GOOS:        $(OS)"
	@echo "  GOARCH:      $(ARCH)"
	@echo "  CGO_ENABLED: $(CGO_ENABLED)"
	@echo "  CC:          $(CC)"
	@echo "  LDFLAGS:     $(LDFLAGS)"
	@echo "  输出文件:    $(OUT_EXE)"
