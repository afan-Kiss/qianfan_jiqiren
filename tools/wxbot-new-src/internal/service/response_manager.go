package service

import (
	"fmt"
	"log"
	"sync"
	"time"
)

// PendingRequest 待处理的请求
type PendingRequest struct {
	ResponseChan chan map[string]interface{}
	Timeout      time.Time
	CreateTime   time.Time
}

// ResponseManager 异步响应管理器
// 使用 "msgType-clientID" 作为唯一标识来匹配请求和响应
type ResponseManager struct {
	pendingRequests map[string]*PendingRequest // key 是 "msgType-clientID"
	mu              sync.RWMutex
	defaultTimeout  time.Duration
}

// NewResponseManager 创建响应管理器
func NewResponseManager(timeout time.Duration) *ResponseManager {
	return &ResponseManager{
		pendingRequests: make(map[string]*PendingRequest),
		defaultTimeout:  timeout,
	}
}

// RegisterRequest 注册一个待处理的请求
func (rm *ResponseManager) RegisterRequest(msgType int, clientID uint32, timeout time.Duration) chan map[string]interface{} {
	if timeout == 0 {
		timeout = rm.defaultTimeout
	}

	key := fmt.Sprintf("%d-%d", msgType, clientID)

	rm.mu.Lock()
	defer rm.mu.Unlock()

	// 如果已存在,先清理旧的
	if old, exists := rm.pendingRequests[key]; exists {
		close(old.ResponseChan)
		log.Printf("[ResponseManager] 覆盖已存在的请求: key=%s", key)
	}

	responseChan := make(chan map[string]interface{}, 1)
	rm.pendingRequests[key] = &PendingRequest{
		ResponseChan: responseChan,
		Timeout:      time.Now().Add(timeout),
		CreateTime:   time.Now(),
	}

	log.Printf("[ResponseManager] 注册请求: msgType=%d, clientID=%d, timeout=%v", msgType, clientID, timeout)
	return responseChan
}

// HandleResponse 处理收到的响应
func (rm *ResponseManager) HandleResponse(msgType int, clientID uint32, data map[string]interface{}) bool {
	key := fmt.Sprintf("%d-%d", msgType, clientID)

	rm.mu.Lock()
	defer rm.mu.Unlock()

	request, exists := rm.pendingRequests[key]
	if !exists {
		return false
	}

	// 检查是否超时
	if time.Now().After(request.Timeout) {
		close(request.ResponseChan)
		delete(rm.pendingRequests, key)
		log.Printf("[ResponseManager] 请求已超时: msgType=%d, clientID=%d", msgType, clientID)
		return false
	}

	// 计算响应时间
	elapsed := time.Since(request.CreateTime)
	log.Printf("[ResponseManager] 收到响应: msgType=%d, clientID=%d, 耗时=%v", msgType, clientID, elapsed)

	// 发送响应
	select {
	case request.ResponseChan <- data:
		delete(rm.pendingRequests, key)
		return true
	default:
		// Channel 已满或已关闭
		delete(rm.pendingRequests, key)
		log.Printf("[ResponseManager] 响应发送失败 (channel 已满或关闭): msgType=%d, clientID=%d", msgType, clientID)
		return false
	}
}

// WaitForResponse 等待响应
func (rm *ResponseManager) WaitForResponse(responseChan chan map[string]interface{}, timeout time.Duration) (map[string]interface{}, error) {
	select {
	case data := <-responseChan:
		return data, nil
	case <-time.After(timeout):
		return nil, fmt.Errorf("等待响应超时")
	}
}

// CleanupExpiredRequests 清理过期的请求
func (rm *ResponseManager) CleanupExpiredRequests() {
	rm.mu.Lock()
	defer rm.mu.Unlock()

	now := time.Now()
	expiredCount := 0
	for trace, request := range rm.pendingRequests {
		if now.After(request.Timeout) {
			close(request.ResponseChan)
			delete(rm.pendingRequests, trace)
			expiredCount++
		}
	}

	if expiredCount > 0 {
		log.Printf("[ResponseManager] 清理过期请求: count=%d, 剩余=%d", expiredCount, len(rm.pendingRequests))
	}
}

// StartCleanupRoutine 启动定期清理过期请求的协程
func (rm *ResponseManager) StartCleanupRoutine(interval time.Duration, stopChan chan bool) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			rm.CleanupExpiredRequests()
		case <-stopChan:
			log.Println("[ResponseManager] 停止清理协程")
			return
		}
	}
}

// GetPendingCount 获取待处理请求数量
func (rm *ResponseManager) GetPendingCount() int {
	rm.mu.RLock()
	defer rm.mu.RUnlock()
	return len(rm.pendingRequests)
}

// CancelRequest 取消待处理的请求
func (rm *ResponseManager) CancelRequest(msgType int, clientID uint32) {
	key := fmt.Sprintf("%d-%d", msgType, clientID)

	rm.mu.Lock()
	defer rm.mu.Unlock()

	if request, exists := rm.pendingRequests[key]; exists {
		close(request.ResponseChan)
		delete(rm.pendingRequests, key)
		log.Printf("[ResponseManager] 取消请求: msgType=%d, clientID=%d", msgType, clientID)
	}
}
