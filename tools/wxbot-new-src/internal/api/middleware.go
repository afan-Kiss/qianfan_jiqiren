package api

import (
	"encoding/base64"
	"log"
	"net/http"
	"strings"
	"time"

	"wxbot-new/internal/config"
)

// Middleware 中间件函数类型
type Middleware func(http.Handler) http.Handler

// Chain 链式组合多个中间件
func Chain(middlewares ...Middleware) Middleware {
	return func(next http.Handler) http.Handler {
		for i := len(middlewares) - 1; i >= 0; i-- {
			next = middlewares[i](next)
		}
		return next
	}
}

// LoggingMiddleware 日志中间件
func LoggingMiddleware() Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()

			// 创建响应包装器以捕获状态码
			wrapper := &responseWrapper{ResponseWriter: w, statusCode: http.StatusOK}

			// 处理请求
			next.ServeHTTP(wrapper, r)

			// 记录日志
			log.Printf("[HTTP] %s %s - Status: %d - 耗时: %v",
				r.Method,
				r.URL.Path,
				wrapper.statusCode,
				time.Since(start),
			)
		})
	}
}

// CORSMiddleware CORS 中间件
func CORSMiddleware() Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// 设置 CORS 头
			w.Header().Set("Access-Control-Allow-Origin", "*")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
			w.Header().Set("Access-Control-Max-Age", "3600")

			// 处理预检请求
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusOK)
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}

// RecoveryMiddleware 恢复中间件(捕获 panic)
func RecoveryMiddleware() Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			defer func() {
				if err := recover(); err != nil {
					log.Printf("[PANIC] %s %s - Error: %v", r.Method, r.URL.Path, err)
					ErrorResponse(w, http.StatusInternalServerError, "服务器内部错误")
				}
			}()
			next.ServeHTTP(w, r)
		})
	}
}

// ContentTypeMiddleware 内容类型中间件
func ContentTypeMiddleware() Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// 对于 POST/PUT 请求,检查 Content-Type
			if r.Method == http.MethodPost || r.Method == http.MethodPut {
				contentType := r.Header.Get("Content-Type")
				if contentType != "" &&
					!strings.HasPrefix(contentType, "application/json") &&
					!strings.HasPrefix(contentType, "multipart/form-data") {
					ErrorResponse(w, http.StatusUnsupportedMediaType, "仅支持 application/json 或 multipart/form-data")
					return
				}
			}
			next.ServeHTTP(w, r)
		})
	}
}

// BasicAuthMiddleware HTTP Basic 认证中间件
// 如果配置中存在 auth 数组,则启用认证;否则跳过
func BasicAuthMiddleware(configManager *config.Manager) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			cfg := configManager.Get()

			// 如果 auth 数组为空,跳过认证
			if len(cfg.Auth) == 0 {
				next.ServeHTTP(w, r)
				return
			}

			// 获取 Authorization 头
			authHeader := r.Header.Get("Authorization")
			if authHeader == "" {
				requestAuth(w)
				return
			}

			// 解析 Basic Auth
			username, password, ok := parseBasicAuth(authHeader)
			if !ok {
				requestAuth(w)
				return
			}

			// 验证用户名和密码
			if !validateCredentials(username, password, cfg.Auth) {
				log.Printf("[Auth] 认证失败: %s from %s", username, r.RemoteAddr)
				requestAuth(w)
				return
			}

			// 认证成功
			log.Printf("[Auth] 认证成功: %s from %s", username, r.RemoteAddr)
			next.ServeHTTP(w, r)
		})
	}
}

// parseBasicAuth 解析 HTTP Basic Auth 头
func parseBasicAuth(authHeader string) (username, password string, ok bool) {
	// Authorization: Basic base64(username:password)
	const prefix = "Basic "
	if !strings.HasPrefix(authHeader, prefix) {
		return "", "", false
	}

	// 解码 base64
	encoded := authHeader[len(prefix):]
	decoded, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return "", "", false
	}

	// 分割 username:password
	credentials := string(decoded)
	idx := strings.Index(credentials, ":")
	if idx == -1 {
		return "", "", false
	}

	return credentials[:idx], credentials[idx+1:], true
}

// validateCredentials 验证用户名和密码
func validateCredentials(username, password string, authUsers []config.AuthUser) bool {
	for _, user := range authUsers {
		if user.Username == username && user.Password == password {
			return true
		}
	}
	return false
}

// requestAuth 请求客户端提供认证信息
func requestAuth(w http.ResponseWriter) {
	w.Header().Set("WWW-Authenticate", `Basic realm="Restricted"`)
	ErrorResponse(w, http.StatusUnauthorized, "需要认证")
}

// responseWrapper 响应包装器,用于捕获状态码
type responseWrapper struct {
	http.ResponseWriter
	statusCode int
}

func (rw *responseWrapper) WriteHeader(code int) {
	rw.statusCode = code
	rw.ResponseWriter.WriteHeader(code)
}

// WeChatServiceMiddleware 微信服务状态检查中间件
// 针对微信相关接口统一检查服务是否已运行
func WeChatServiceMiddleware(wechatHandler *WeChatHandler) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			path := r.URL.Path

			// 仅对微信相关接口做检查:
			// - /api/wechat/* (但排除 /api/wechat/status)
			needCheck := false
			if strings.HasPrefix(path, "/api/wechat/") && path != "/api/wechat/status" {
				needCheck = true
			}

			if needCheck {
				if wechatHandler == nil || wechatHandler.wechatService == nil || !wechatHandler.wechatService.IsRunning() {
					ErrorResponse(w, http.StatusServiceUnavailable, "微信服务未运行")
					return
				}
			}

			next.ServeHTTP(w, r)
		})
	}
}
