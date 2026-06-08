package loader

/*
#include <windows.h>
#include <stdint.h>

// 前向声明：Go 侧实现的回调函数
extern void goOnConnect(uintptr_t clientID);
extern void goOnRecv(uintptr_t clientID, uintptr_t data, uint32_t length);
extern void goOnClose(uintptr_t clientID);

// C 回调函数（提供给 DLL 调用，真正的 C 代码，无 Go 特征）
static uintptr_t __stdcall c_connect_callback(void* clientID) {
    goOnConnect((uintptr_t)clientID);
    return 0;
}

static uintptr_t __stdcall c_recv_callback(uintptr_t clientID, uintptr_t data, uint32_t length) {
    goOnRecv(clientID, data, length);
    return 0;
}

static uintptr_t __stdcall c_close_callback(uintptr_t clientID) {
    goOnClose(clientID);
    return 0;
}

// 获取 C 函数指针的辅助函数
static void* get_connect_callback_ptr() {
    return (void*)c_connect_callback;
}

static void* get_recv_callback_ptr() {
    return (void*)c_recv_callback;
}

static void* get_close_callback_ptr() {
    return (void*)c_close_callback;
}
*/
import "C"
import (
	"encoding/json"
	"log"
	"sync"
	"unsafe"
)

// CallbackFunc 回调函数类型
type ConnectCallback func(clientID uintptr)
type RecvCallback func(clientID uintptr, msgType int, data map[string]interface{})
type CloseCallback func(clientID uintptr)

// CallbackManager 回调管理器
type CallbackManager struct {
	connectCallbacks []ConnectCallback
	recvCallbacks    []RecvCallback
	closeCallbacks   []CloseCallback
	mu               sync.RWMutex
	debugMode        bool // 调试模式，控制是否打印原始数据
}

// 全局回调管理器（CGO 需要全局访问）
var globalCallbackManager *CallbackManager

// NewCallbackManager 创建回调管理器
func NewCallbackManager() *CallbackManager {
	return &CallbackManager{
		connectCallbacks: make([]ConnectCallback, 0),
		recvCallbacks:    make([]RecvCallback, 0),
		closeCallbacks:   make([]CloseCallback, 0),
		debugMode:        false, // 默认关闭调试模式
	}
}

// SetDebugMode 设置调试模式
func (m *CallbackManager) SetDebugMode(enabled bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.debugMode = enabled
}

// AddConnectCallback 添加连接回调
func (m *CallbackManager) AddConnectCallback(cb ConnectCallback) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.connectCallbacks = append(m.connectCallbacks, cb)
}

// AddRecvCallback 添加接收消息回调
func (m *CallbackManager) AddRecvCallback(cb RecvCallback) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.recvCallbacks = append(m.recvCallbacks, cb)
}

// AddCloseCallback 添加关闭回调
func (m *CallbackManager) AddCloseCallback(cb CloseCallback) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.closeCallbacks = append(m.closeCallbacks, cb)
}

// onConnect 连接回调处理
func (m *CallbackManager) onConnect(clientID uintptr) uintptr {
	m.mu.RLock()
	defer m.mu.RUnlock()

	for _, cb := range m.connectCallbacks {
		cb(clientID)
	}
	return 0
}

// onRecv 接收消息回调处理
func (m *CallbackManager) onRecv(clientID uintptr, data uintptr, length uint32) uintptr {
	m.mu.RLock()
	defer m.mu.RUnlock()

	// 从指针读取数据
	dataBytes := make([]byte, length)
	for i := uint32(0); i < length; i++ {
		dataBytes[i] = *(*byte)(unsafe.Pointer(data + uintptr(i)))
	}

	// 移除尾部的null字符（C字符串终止符）
	dataBytes = trimNullBytes(dataBytes)

	// 调试模式下打印接收到的原始数据
	if m.debugMode {
		log.Printf("[DEBUG] 接收到的数据 [长度:%d]: %s", len(dataBytes), string(dataBytes))
	}

	// 解析JSON（兼容 data 字段为对象或数组的情况）
	var msg struct {
		Type int             `json:"type"`
		Data json.RawMessage `json:"data"`
	}

	if err := json.Unmarshal(dataBytes, &msg); err != nil {
		log.Printf("解析消息失败: %v, 原始数据: %s", err, string(dataBytes))
		return 0
	}

	// 统一转换为 map[string]interface{} 传递给上层：
	// - 当 data 是对象时，直接映射为 map
	// - 当 data 是数组时，包装为 {"data": [...]}，方便好友列表等场景使用
	payload := make(map[string]interface{})

	// 优先尝试解析为对象
	if len(msg.Data) > 0 && string(msg.Data) != "null" {
		if err := json.Unmarshal(msg.Data, &payload); err != nil {
			// 如果不是对象，再尝试解析为数组
			var list []interface{}
			if errArr := json.Unmarshal(msg.Data, &list); errArr == nil {
				payload["data"] = list
			} else {
				// 最后兜底为任意类型，放在 value 字段中，避免整个消息丢失
				var v interface{}
				if errAny := json.Unmarshal(msg.Data, &v); errAny == nil {
					payload["value"] = v
				} else {
					log.Printf("解析消息 data 字段失败: %v, data=%s", err, string(msg.Data))
					return 0
				}
			}
		}
	}

	// 调用回调
	for _, cb := range m.recvCallbacks {
		cb(clientID, msg.Type, payload)
	}

	return 0
}

// trimNullBytes 移除字节数组尾部的null字符
func trimNullBytes(b []byte) []byte {
	// 找到第一个null字符的位置
	for i, v := range b {
		if v == 0 {
			return b[:i]
		}
	}
	return b
}

// onClose 关闭回调处理
func (m *CallbackManager) onClose(clientID uintptr) uintptr {
	m.mu.RLock()
	defer m.mu.RUnlock()

	for _, cb := range m.closeCallbacks {
		cb(clientID)
	}
	return 0
}

//export goOnConnect
func goOnConnect(clientID uintptr) {
	if globalCallbackManager != nil {
		globalCallbackManager.onConnect(clientID)
	}
}

//export goOnRecv
func goOnRecv(clientID uintptr, data uintptr, length uint32) {
	if globalCallbackManager != nil {
		globalCallbackManager.onRecv(clientID, data, length)
	}
}

//export goOnClose
func goOnClose(clientID uintptr) {
	if globalCallbackManager != nil {
		globalCallbackManager.onClose(clientID)
	}
}

// GetConnectCallbackPtr 获取连接回调函数指针（CGO 版本）
func (m *CallbackManager) GetConnectCallbackPtr() uintptr {
	// 设置全局回调管理器
	globalCallbackManager = m
	return uintptr(C.get_connect_callback_ptr())
}

// GetRecvCallbackPtr 获取接收消息回调函数指针（CGO 版本）
func (m *CallbackManager) GetRecvCallbackPtr() uintptr {
	return uintptr(C.get_recv_callback_ptr())
}

// GetCloseCallbackPtr 获取关闭回调函数指针（CGO 版本）
func (m *CallbackManager) GetCloseCallbackPtr() uintptr {
	return uintptr(C.get_close_callback_ptr())
}
