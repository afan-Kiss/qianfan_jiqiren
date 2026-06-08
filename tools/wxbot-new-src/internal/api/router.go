package api

import (
	"net/http"

	"wxbot-new/internal/config"
	"wxbot-new/internal/service"
)

// Router 路由管理器
type Router struct {
	mux           *http.ServeMux
	configHandler *ConfigHandler
	wechatHandler *WeChatHandler
	configManager *config.Manager
}

// NewRouter 创建路由管理器
func NewRouter(configManager *config.Manager, wechatService *service.WeChatService) *Router {
	return &Router{
		mux:           http.NewServeMux(),
		configHandler: NewConfigHandler(configManager),
		wechatHandler: NewWeChatHandler(wechatService),
		configManager: configManager,
	}
}

// SetWeChatService 设置微信服务实例
func (r *Router) SetWeChatService(wechatService *service.WeChatService) {
	r.wechatHandler = NewWeChatHandler(wechatService)
	r.configHandler.SetWeChatService(wechatService)
}

// RegisterRoutes 注册所有路由
func (r *Router) RegisterRoutes() http.Handler {
	// ========== 健康检查 ==========
	r.mux.HandleFunc("/health", r.healthCheck)

	// ========== 配置管理 API ==========
	// 完整配置操作
	r.mux.HandleFunc("/api/config", r.handleConfig)

	// 单个配置项操作
	r.mux.HandleFunc("/api/config/", r.handleConfigItem)

	// ========== 微信服务 API ==========
	// 检查微信服务状态
	r.mux.HandleFunc("/api/wechat/status", r.wechatHandler.CheckServiceStatus)
	// 获取当前登录信息
	r.mux.HandleFunc("/api/wechat/login-info", r.wechatHandler.GetCurrentLoginInfo)
	// 刷新二维码
	r.mux.HandleFunc("/api/wechat/refresh-qrcode", r.wechatHandler.RefreshQRCode)
	// 获取小程序code
	r.mux.HandleFunc("/api/wechat/mini-program-code", r.wechatHandler.GetMiniProgramCode)
	// 语音转文本
	r.mux.HandleFunc("/api/wechat/voice-to-text", r.wechatHandler.GetVoiceToText)
	// 注销当前微信账号
	r.mux.HandleFunc("/api/wechat/logout", r.wechatHandler.LogoutCurrent)
	// 获取好友列表
	r.mux.HandleFunc("/api/wechat/friend-list", r.wechatHandler.GetFriendList)
	// 获取指定好友信息
	r.mux.HandleFunc("/api/wechat/friend-info", r.wechatHandler.GetFriendInfo)
	// 邀请好友进群
	r.mux.HandleFunc("/api/wechat/invite-group-member", r.wechatHandler.InviteGroupMember)
	// 获取群列表
	r.mux.HandleFunc("/api/wechat/group-list", r.wechatHandler.GetGroupList)
	// 获取群成员列表
	r.mux.HandleFunc("/api/wechat/group-member-list", r.wechatHandler.GetGroupMemberList)
	// 修改群名称
	r.mux.HandleFunc("/api/wechat/modify-group-name", r.wechatHandler.ModifyGroupName)
	// 发送普通文本消息
	r.mux.HandleFunc("/api/wechat/send-text", r.wechatHandler.SendTextMessage)
	// 发送@文本消息
	r.mux.HandleFunc("/api/wechat/send-at-text", r.wechatHandler.SendAtTextMessage)
	// 发送图片消息
	r.mux.HandleFunc("/api/wechat/send-image", r.wechatHandler.SendImageMessage)
	// 发送文件消息
	r.mux.HandleFunc("/api/wechat/send-file", r.wechatHandler.SendFileMessage)
	// 发送名片消息
	r.mux.HandleFunc("/api/wechat/send-card", r.wechatHandler.SendCardMessage)

	// 应用中间件链
	handler := Chain(
		RecoveryMiddleware(),                     // 最外层: 捕获 panic
		LoggingMiddleware(),                      // 日志记录
		CORSMiddleware(),                         // CORS 支持
		BasicAuthMiddleware(r.configManager),     // HTTP Basic 认证
		WeChatServiceMiddleware(r.wechatHandler), // 微信服务状态检查
		ContentTypeMiddleware(),                  // 内容类型检查
	)(r.mux)

	return handler
}

// handleConfig 处理完整配置的 CRUD
func (r *Router) handleConfig(w http.ResponseWriter, req *http.Request) {
	switch req.Method {
	case http.MethodGet:
		r.configHandler.GetConfig(w, req)
	case http.MethodPost:
		r.configHandler.CreateConfig(w, req)
	case http.MethodPut:
		r.configHandler.UpdateConfig(w, req)
	case http.MethodDelete:
		r.configHandler.DeleteConfig(w, req)
	default:
		ErrorResponse(w, http.StatusMethodNotAllowed, "不支持的请求方法")
	}
}

// handleConfigItem 处理单个配置项的操作
func (r *Router) handleConfigItem(w http.ResponseWriter, req *http.Request) {
	switch req.Method {
	case http.MethodGet:
		r.configHandler.GetConfigItem(w, req)
	case http.MethodPut:
		r.configHandler.UpdateConfigItem(w, req)
	default:
		ErrorResponse(w, http.StatusMethodNotAllowed, "不支持的请求方法")
	}
}

// healthCheck 健康检查
func (r *Router) healthCheck(w http.ResponseWriter, req *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	w.Write([]byte(`{"status":"ok"}`))
}
