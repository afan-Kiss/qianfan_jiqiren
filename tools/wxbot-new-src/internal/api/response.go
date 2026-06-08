package api

import (
	"encoding/json"
	"net/http"
)

// Response 统一响应格式
type Response struct {
	Code    int         `json:"code"`           // 状态码: 0=成功, 其他=失败
	Message string      `json:"message"`        // 消息
	Data    interface{} `json:"data,omitempty"` // 数据
}

// SuccessResponse 成功响应
func SuccessResponse(w http.ResponseWriter, message string, data interface{}) {
	JSONResponse(w, http.StatusOK, Response{
		Code:    0,
		Message: message,
		Data:    data,
	})
}

// ErrorResponse 错误响应
func ErrorResponse(w http.ResponseWriter, statusCode int, message string) {
	JSONResponse(w, statusCode, Response{
		Code:    statusCode,
		Message: message,
	})
}

// JSONResponse JSON 响应
func JSONResponse(w http.ResponseWriter, statusCode int, resp Response) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(statusCode)

	if err := json.NewEncoder(w).Encode(resp); err != nil {
		// 编码失败,记录日志但不再修改响应
		http.Error(w, "内部服务器错误", http.StatusInternalServerError)
	}
}
