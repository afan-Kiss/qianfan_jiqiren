package loader

import (
	"fmt"
	"os"
	"syscall"
	"unsafe"
)

// DLL函数偏移地址
const (
	offsetInitWeChatSocket      = 0xB080
	offsetGetUserWeChatVersion  = 0xCB80
	offsetInjectWeChat          = 0xCC10
	offsetSendWeChatData        = 0xAF90
	offsetDestroyWeChat         = 0xC540
	offsetUseUtf8               = 0xC680
	offsetInjectWeChat2         = 0xCC30
	offsetInjectWeChatPid       = 0xB750
	offsetInjectWeChatMultiOpen = 0xC780
)

// NoveLoader DLL加载器
type NoveLoader struct {
	dll             *syscall.DLL
	baseAddr        uintptr
	callbackManager *CallbackManager
	manualModule    *manualModule
}

// NewNoveLoader 创建DLL加载器
func NewNoveLoader(loaderPath string) (*NoveLoader, error) {
	// 检查文件是否存在
	if _, err := os.Stat(loaderPath); os.IsNotExist(err) {
		return nil, fmt.Errorf("loader文件不存在: %s", loaderPath)
	}
	// 仅使用 Manual DLL Mapping（手动映射），不再回退到 LoadDLL
	mod, err := manualLoadModule(loaderPath)
	if err != nil {
		return nil, fmt.Errorf("手动映射DLL失败: %v", err)
	}

	loader := &NoveLoader{
		dll:             nil,
		baseAddr:        mod.base,
		callbackManager: NewCallbackManager(),
		manualModule:    mod,
	}

	// 使用UTF-8编码
	if err := loader.UseUtf8(); err != nil {
		return nil, fmt.Errorf("设置UTF-8编码失败: %v", err)
	}

	return loader, nil
}

// callFunc 调用非导出函数
func (l *NoveLoader) callFunc(offset uintptr, args ...uintptr) (uintptr, error) {
	funcAddr := l.baseAddr + offset

	// 准备参数，确保有9个参数
	var a [9]uintptr
	for i := 0; i < len(args) && i < 9; i++ {
		a[i] = args[i]
	}

	ret, _, err := syscall.Syscall9(
		funcAddr,
		uintptr(len(args)),
		a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7], a[8],
	)

	// Windows API调用即使成功也会返回错误，需要检查返回值
	if ret == 0 && err != 0 {
		return ret, err
	}

	return ret, nil
}

// InitWeChatSocket 初始化微信Socket
func (l *NoveLoader) InitWeChatSocket() error {
	connectPtr := l.callbackManager.GetConnectCallbackPtr()
	recvPtr := l.callbackManager.GetRecvCallbackPtr()
	closePtr := l.callbackManager.GetCloseCallbackPtr()

	ret, err := l.callFunc(
		offsetInitWeChatSocket,
		connectPtr,
		recvPtr,
		closePtr,
	)

	if ret == 0 {
		return fmt.Errorf("初始化微信Socket失败: %v", err)
	}

	return nil
}

// GetUserWeChatVersion 获取用户微信版本
func (l *NoveLoader) GetUserWeChatVersion() (string, error) {
	buf := make([]byte, 20)
	ret, _ := l.callFunc(
		offsetGetUserWeChatVersion,
		uintptr(unsafe.Pointer(&buf[0])),
	)

	if ret == 0 {
		return "", fmt.Errorf("获取微信版本失败")
	}

	// 找到null终止符
	for i, b := range buf {
		if b == 0 {
			return string(buf[:i]), nil
		}
	}

	return string(buf), nil
}

// InjectWeChat 注入微信
func (l *NoveLoader) InjectWeChat(dllPath string) (uint32, error) {
	dllPathBytes := append([]byte(dllPath), 0)

	ret, _ := l.callFunc(
		offsetInjectWeChat,
		uintptr(unsafe.Pointer(&dllPathBytes[0])),
	)

	return uint32(ret), nil
}

// SendWeChatData 发送微信数据
func (l *NoveLoader) SendWeChatData(clientID uint32, message string) error {
	messageBytes := append([]byte(message), 0)

	ret, err := l.callFunc(
		offsetSendWeChatData,
		uintptr(clientID),
		uintptr(unsafe.Pointer(&messageBytes[0])),
	)

	if ret == 0 {
		return fmt.Errorf("SendWeChatData调用失败: ret=%d, err=%v, clientID=%d, msgLen=%d",
			ret, err, clientID, len(message))
	}

	return nil
}

// DestroyWeChat 销毁微信连接
func (l *NoveLoader) DestroyWeChat() error {
	ret, _ := l.callFunc(offsetDestroyWeChat)

	if ret == 0 {
		return fmt.Errorf("销毁微信连接失败")
	}

	return nil
}

// UseUtf8 使用UTF-8编码
func (l *NoveLoader) UseUtf8() error {
	ret, _ := l.callFunc(offsetUseUtf8)

	if ret == 0 {
		return fmt.Errorf("设置UTF-8编码失败")
	}

	return nil
}

// InjectWeChat2 注入微信（方式2）
func (l *NoveLoader) InjectWeChat2(dllPath, exePath string) (uint32, error) {
	dllPathBytes := append([]byte(dllPath), 0)
	exePathBytes := append([]byte(exePath), 0)

	ret, _ := l.callFunc(
		offsetInjectWeChat2,
		uintptr(unsafe.Pointer(&dllPathBytes[0])),
		uintptr(unsafe.Pointer(&exePathBytes[0])),
	)

	return uint32(ret), nil
}

// InjectWeChatPid 通过PID注入微信
func (l *NoveLoader) InjectWeChatPid(pid uint32, dllPath string) (uint32, error) {
	dllPathBytes := append([]byte(dllPath), 0)

	ret, _ := l.callFunc(
		offsetInjectWeChatPid,
		uintptr(pid),
		uintptr(unsafe.Pointer(&dllPathBytes[0])),
	)

	return uint32(ret), nil
}

// InjectWeChatMultiOpen 多开注入微信
func (l *NoveLoader) InjectWeChatMultiOpen(dllPath, exePath string) (uint32, error) {
	dllPathBytes := append([]byte(dllPath), 0)
	exePathBytes := append([]byte(exePath), 0)

	ret, _ := l.callFunc(
		offsetInjectWeChatMultiOpen,
		uintptr(unsafe.Pointer(&dllPathBytes[0])),
		uintptr(unsafe.Pointer(&exePathBytes[0])),
	)

	return uint32(ret), nil
}

// AddConnectCallback 添加连接回调
func (l *NoveLoader) AddConnectCallback(cb ConnectCallback) {
	l.callbackManager.AddConnectCallback(cb)
}

// AddRecvCallback 添加接收消息回调
func (l *NoveLoader) AddRecvCallback(cb RecvCallback) {
	l.callbackManager.AddRecvCallback(cb)
}

// AddCloseCallback 添加关闭回调
func (l *NoveLoader) AddCloseCallback(cb CloseCallback) {
	l.callbackManager.AddCloseCallback(cb)
}

// SetDebugMode 设置调试模式
func (l *NoveLoader) SetDebugMode(enabled bool) {
	l.callbackManager.SetDebugMode(enabled)
}

// Release 释放资源
func (l *NoveLoader) Release() error {
	if err := l.DestroyWeChat(); err != nil {
		return err
	}

	if l.manualModule != nil {
		if err := manualFreeModule(l.manualModule); err != nil {
			return err
		}
		l.manualModule = nil
	}

	if l.dll != nil {
		if err := l.dll.Release(); err != nil {
			return err
		}
	}

	return nil
}
