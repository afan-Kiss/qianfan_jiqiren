package api

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"

	"wxbot-new/internal/config"
	"wxbot-new/internal/service"
)

// ConfigHandler 配置接口处理器
type ConfigHandler struct {
	configManager *config.Manager
	wechatService *service.WeChatService
}

// NewConfigHandler 创建配置处理器
func NewConfigHandler(configManager *config.Manager) *ConfigHandler {
	return &ConfigHandler{
		configManager: configManager,
	}
}

// SetWeChatService 设置微信服务实例, 以便配置变更时同步更新相关参数
func (h *ConfigHandler) SetWeChatService(wechatService *service.WeChatService) {
	h.wechatService = wechatService
}

// GetConfig 查询完整配置
// GET /api/config
func (h *ConfigHandler) GetConfig(w http.ResponseWriter, r *http.Request) {
	cfg := h.configManager.Get()
	SuccessResponse(w, "查询成功", cfg)
}

// CreateConfig 创建配置
// POST /api/config
func (h *ConfigHandler) CreateConfig(w http.ResponseWriter, r *http.Request) {
	h.updateConfigInternal(w, r)
}

// UpdateConfig 更新完整配置
// PUT /api/config
func (h *ConfigHandler) UpdateConfig(w http.ResponseWriter, r *http.Request) {
	h.updateConfigInternal(w, r)
}

// DeleteConfig 删除配置(恢复默认)
// DELETE /api/config
func (h *ConfigHandler) DeleteConfig(w http.ResponseWriter, r *http.Request) {
	if err := h.configManager.Delete(); err != nil {
		ErrorResponse(w, http.StatusInternalServerError, "删除配置失败: "+err.Error())
		return
	}

	cfg := h.configManager.Get()
	SuccessResponse(w, "已恢复默认配置", cfg)
}

// GetConfigItem 查询指定配置项
// GET /api/config/{key}
func (h *ConfigHandler) GetConfigItem(w http.ResponseWriter, r *http.Request) {
	key := extractKey(r.URL.Path)
	if key == "" {
		ErrorResponse(w, http.StatusBadRequest, "配置项名称不能为空")
		return
	}

	value, err := h.configManager.GetValue(key)
	if err != nil {
		ErrorResponse(w, http.StatusBadRequest, err.Error())
		return
	}

	SuccessResponse(w, "查询成功", map[string]interface{}{
		"key":   key,
		"value": value,
	})
}

// UpdateConfigItem 更新指定配置项
// PUT /api/config/{key}
func (h *ConfigHandler) UpdateConfigItem(w http.ResponseWriter, r *http.Request) {
	key := extractKey(r.URL.Path)
	if key == "" {
		ErrorResponse(w, http.StatusBadRequest, "配置项名称不能为空")
		return
	}

	// 读取请求体
	body, err := io.ReadAll(r.Body)
	if err != nil {
		ErrorResponse(w, http.StatusBadRequest, "读取请求体失败: "+err.Error())
		return
	}
	defer r.Body.Close()

	// 解析 JSON
	var req map[string]interface{}
	if err := json.Unmarshal(body, &req); err != nil {
		ErrorResponse(w, http.StatusBadRequest, "解析 JSON 失败: "+err.Error())
		return
	}

	// 获取 value
	value, ok := req["value"]
	if !ok {
		ErrorResponse(w, http.StatusBadRequest, "缺少 value 字段")
		return
	}

	// 更新配置项
	if err := h.configManager.UpdateValue(key, value); err != nil {
		ErrorResponse(w, http.StatusInternalServerError, "更新配置失败: "+err.Error())
		return
	}

	// 配置更新后, 同步刷新微信服务相关配置(实时生效)
	if h.wechatService != nil {
		cfg := h.configManager.Get()
		h.wechatService.SetLogRecvCallback(cfg.LogRecvCallback)
		h.wechatService.SetCallbackURLs(cfg.CallbackURLs)
	}

	SuccessResponse(w, "更新成功", map[string]interface{}{
		"key":   key,
		"value": value,
	})
}

// updateConfigInternal 内部更新配置方法
func (h *ConfigHandler) updateConfigInternal(w http.ResponseWriter, r *http.Request) {
	// 读取请求体
	body, err := io.ReadAll(r.Body)
	if err != nil {
		ErrorResponse(w, http.StatusBadRequest, "读取请求体失败: "+err.Error())
		return
	}
	defer r.Body.Close()

	// 解析 JSON
	var cfg config.Config
	if err := json.Unmarshal(body, &cfg); err != nil {
		ErrorResponse(w, http.StatusBadRequest, "解析 JSON 失败: "+err.Error())
		return
	}

	// 更新配置
	if err := h.configManager.Update(&cfg); err != nil {
		ErrorResponse(w, http.StatusInternalServerError, "更新配置失败: "+err.Error())
		return
	}

	// 配置更新后, 同步刷新微信服务相关配置(实时生效)
	if h.wechatService != nil {
		newCfg := h.configManager.Get()
		h.wechatService.SetLogRecvCallback(newCfg.LogRecvCallback)
		h.wechatService.SetCallbackURLs(newCfg.CallbackURLs)
	}

	SuccessResponse(w, "更新成功", cfg)
}

// extractKey 从路径中提取配置项 key
// /api/config/host -> host
// /api/config/port -> port
func extractKey(path string) string {
	parts := strings.Split(strings.TrimPrefix(path, "/api/config/"), "/")
	if len(parts) > 0 {
		return strings.TrimSpace(parts[0])
	}
	return ""
}
