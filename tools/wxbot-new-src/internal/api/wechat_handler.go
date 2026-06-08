package api

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"wxbot-new/internal/service"
)

// WeChatHandler 微信相关接口处理器
type WeChatHandler struct {
	wechatService *service.WeChatService
}

// NewWeChatHandler 创建微信处理器
func NewWeChatHandler(wechatService *service.WeChatService) *WeChatHandler {
	return &WeChatHandler{
		wechatService: wechatService,
	}
}

// LogoutCurrent 注销当前微信账号
func (h *WeChatHandler) LogoutCurrent(w http.ResponseWriter, r *http.Request) {
	if err := h.wechatService.HelperLogoutCurrent(); err != nil {
		log.Printf("注销当前微信账号失败: %v", err)
		ErrorResponse(w, http.StatusInternalServerError, "注销当前微信账号失败: "+err.Error())
		return
	}

	// 无需返回业务数据,仅返回统一成功响应
	SuccessResponse(w, "注销请求已发送", nil)
}

// CheckServiceStatus 检查微信服务状态
func (h *WeChatHandler) CheckServiceStatus(w http.ResponseWriter, r *http.Request) {
	status := map[string]interface{}{
		"running":         false,
		"message":         "微信服务未初始化",
		"client_id":       0,
		"connected_count": 0,
	}

	if h.wechatService != nil {
		isRunning := h.wechatService.IsRunning()
		clientID := h.wechatService.GetClientID()
		connectedCount := h.wechatService.GetConnectedClientsCount()

		status["running"] = isRunning
		status["client_id"] = clientID
		status["connected_count"] = connectedCount

		if !isRunning {
			status["message"] = "微信服务已停止"
		} else if clientID == 0 {
			status["message"] = "微信服务运行中，但未成功注入或已断开连接"
		} else {
			status["message"] = "微信服务正常运行"
		}
	}

	SuccessResponse(w, "状态检查完成", status)
}

// GetCurrentLoginInfo 获取当前登录信息
func (h *WeChatHandler) GetCurrentLoginInfo(w http.ResponseWriter, r *http.Request) {
	loginInfo, err := h.wechatService.HelperGetCurrentLoginInfo()
	if err != nil {
		log.Printf("获取登录信息失败: %v", err)
		ErrorResponse(w, http.StatusInternalServerError, "获取登录信息失败: "+err.Error())
		return
	}

	SuccessResponse(w, "获取登录信息成功", loginInfo)
}

// RefreshQRCode 刷新二维码
func (h *WeChatHandler) RefreshQRCode(w http.ResponseWriter, r *http.Request) {
	qrData, err := h.wechatService.HelperRefreshQRCode()
	if err != nil {
		log.Printf("刷新二维码失败: %v", err)
		ErrorResponse(w, http.StatusInternalServerError, "刷新二维码失败: "+err.Error())
		return
	}

	SuccessResponse(w, "刷新二维码成功", qrData)
}

// GetMiniProgramCode 获取小程序code
func (h *WeChatHandler) GetMiniProgramCode(w http.ResponseWriter, r *http.Request) {
	appID := r.URL.Query().Get("appid")
	if appID == "" {
		ErrorResponse(w, http.StatusBadRequest, "appid不能为空")
		return
	}

	result, err := h.wechatService.HelperGetMiniProgramCode(appID)
	if err != nil {
		log.Printf("获取小程序code失败: %v", err)
		ErrorResponse(w, http.StatusInternalServerError, "获取小程序code失败: "+err.Error())
		return
	}

	SuccessResponse(w, "获取小程序code成功", result)
}

// GetVoiceToText 语音转文本
func (h *WeChatHandler) GetVoiceToText(w http.ResponseWriter, r *http.Request) {
	msgID := r.URL.Query().Get("msgid")
	if msgID == "" {
		ErrorResponse(w, http.StatusBadRequest, "msgid不能为空")
		return
	}

	result, err := h.wechatService.HelperGetVoiceToText(msgID)
	if err != nil {
		log.Printf("语音转文本失败: %v", err)
		ErrorResponse(w, http.StatusInternalServerError, "语音转文本失败: "+err.Error())
		return
	}

	SuccessResponse(w, "语音转文本成功", result)
}

// GetFriendList 获取好友列表
func (h *WeChatHandler) GetFriendList(w http.ResponseWriter, r *http.Request) {
	friends, err := h.wechatService.HelperGetFriendList()
	if err != nil {
		log.Printf("获取好友列表失败: %v", err)
		ErrorResponse(w, http.StatusInternalServerError, "获取好友列表失败: "+err.Error())
		return
	}

	// 直接返回好友数组，保持与其他接口一致（data 类型可为任意）
	SuccessResponse(w, "获取好友列表成功", friends)
}

// GetFriendInfo 获取指定好友信息
func (h *WeChatHandler) GetFriendInfo(w http.ResponseWriter, r *http.Request) {
	wxid := r.URL.Query().Get("wxid")
	if wxid == "" {
		ErrorResponse(w, http.StatusBadRequest, "wxid不能为空")
		return
	}

	friend, err := h.wechatService.HelperGetFriendInfo(wxid)
	if err != nil {
		log.Printf("获取好友信息失败: %v", err)
		ErrorResponse(w, http.StatusInternalServerError, "获取好友信息失败: "+err.Error())
		return
	}

	// 直接返回好友对象
	SuccessResponse(w, "获取好友信息成功", friend)
}

// GetGroupList 获取群列表
func (h *WeChatHandler) GetGroupList(w http.ResponseWriter, r *http.Request) {
	detail := 0
	if dStr := r.URL.Query().Get("detail"); dStr != "" {
		d, err := strconv.Atoi(dStr)
		if err != nil || (d != 0 && d != 1) {
			ErrorResponse(w, http.StatusBadRequest, "detail参数仅支持0或1")
			return
		}
		detail = d
	}

	groups, err := h.wechatService.HelperGetGroupList(detail)
	if err != nil {
		log.Printf("获取群列表失败: %v", err)
		ErrorResponse(w, http.StatusInternalServerError, "获取群列表失败: "+err.Error())
		return
	}

	// 当 detail=0 时, 不返回 member_list 字段
	if detail == 0 {
		for _, g := range groups {
			g.MemberList = nil
		}
	}

	SuccessResponse(w, "获取群列表成功", groups)
}

// GetGroupMemberList 获取群成员列表
func (h *WeChatHandler) GetGroupMemberList(w http.ResponseWriter, r *http.Request) {
	roomWxid := r.URL.Query().Get("room_wxid")
	if roomWxid == "" {
		ErrorResponse(w, http.StatusBadRequest, "room_wxid不能为空")
		return
	}

	result, err := h.wechatService.HelperGetGroupMemberList(roomWxid)
	if err != nil {
		log.Printf("获取群成员列表失败: %v", err)
		ErrorResponse(w, http.StatusInternalServerError, "获取群成员列表失败: "+err.Error())
		return
	}

	SuccessResponse(w, "获取群成员列表成功", result)
}

// SendTextMessage 发送普通文本消息
func (h *WeChatHandler) SendTextMessage(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		ErrorResponse(w, http.StatusMethodNotAllowed, "仅支持 POST 方法")
		return
	}

	var req struct {
		Wxid    string `json:"wxid"`
		Content string `json:"content"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		ErrorResponse(w, http.StatusBadRequest, "请求体不是有效的JSON")
		return
	}

	if req.Wxid == "" {
		ErrorResponse(w, http.StatusBadRequest, "wxid不能为空")
		return
	}
	if req.Content == "" {
		ErrorResponse(w, http.StatusBadRequest, "content不能为空")
		return
	}

	if err := h.wechatService.HelperSendText(req.Wxid, req.Content); err != nil {
		log.Printf("发送文本消息失败: %v", err)
		ErrorResponse(w, http.StatusInternalServerError, "发送文本消息失败: "+err.Error())
		return
	}

	// 不需要返回业务数据
	SuccessResponse(w, "发送文本消息成功", nil)
}

// SendAtTextMessage 发送@文本消息
func (h *WeChatHandler) SendAtTextMessage(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		ErrorResponse(w, http.StatusMethodNotAllowed, "仅支持 POST 方法")
		return
	}

	var req struct {
		Wxid    string   `json:"wxid"`
		Content string   `json:"content"`
		AtList  []string `json:"at_list"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		ErrorResponse(w, http.StatusBadRequest, "请求体不是有效的JSON")
		return
	}

	if req.Wxid == "" {
		ErrorResponse(w, http.StatusBadRequest, "wxid不能为空")
		return
	}
	if req.Content == "" {
		ErrorResponse(w, http.StatusBadRequest, "content不能为空")
		return
	}

	if err := h.wechatService.HelperSendAtText(req.Wxid, req.Content, req.AtList); err != nil {
		log.Printf("发送@文本消息失败: %v", err)
		ErrorResponse(w, http.StatusInternalServerError, "发送@文本消息失败: "+err.Error())
		return
	}

	SuccessResponse(w, "发送@文本消息成功", nil)
}

// InviteGroupMember 邀请好友进群
func (h *WeChatHandler) InviteGroupMember(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		ErrorResponse(w, http.StatusMethodNotAllowed, "仅支持 POST 方法")
		return
	}

	var req struct {
		RoomWxid   string   `json:"room_wxid"`
		MemberList []string `json:"member_list"`
		Reason     string   `json:"reason"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		ErrorResponse(w, http.StatusBadRequest, "请求体不是有效的JSON")
		return
	}

	if req.RoomWxid == "" {
		ErrorResponse(w, http.StatusBadRequest, "room_wxid不能为空")
		return
	}
	if len(req.MemberList) == 0 {
		ErrorResponse(w, http.StatusBadRequest, "member_list不能为空")
		return
	}

	result, err := h.wechatService.HelperInviteGroupMember(req.RoomWxid, req.MemberList, req.Reason)
	if err != nil {
		log.Printf("邀请好友进群失败: %v", err)
		ErrorResponse(w, http.StatusInternalServerError, "邀请好友进群失败: "+err.Error())
		return
	}

	SuccessResponse(w, "邀请好友进群成功", result)
}

// SendImageMessage 发送图片消息
func (h *WeChatHandler) SendImageMessage(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		ErrorResponse(w, http.StatusMethodNotAllowed, "仅支持 POST 方法")
		return
	}

	// 解析 multipart/form-data
	if err := r.ParseMultipartForm(32 << 20); err != nil { // 32MB
		ErrorResponse(w, http.StatusBadRequest, "解析上传表单失败: "+err.Error())
		return
	}

	wxid := r.FormValue("wxid")
	if wxid == "" {
		ErrorResponse(w, http.StatusBadRequest, "wxid不能为空")
		return
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		ErrorResponse(w, http.StatusBadRequest, "获取上传文件失败: "+err.Error())
		return
	}
	defer file.Close()

	uploadDir := "uploads"
	if err := os.MkdirAll(uploadDir, 0755); err != nil {
		ErrorResponse(w, http.StatusInternalServerError, "创建上传目录失败: "+err.Error())
		return
	}

	ext := filepath.Ext(header.Filename)
	fileName := strconv.FormatInt(time.Now().UnixNano(), 10) + ext
	localPath := filepath.Join(uploadDir, fileName)

	out, err := os.Create(localPath)
	if err != nil {
		ErrorResponse(w, http.StatusInternalServerError, "保存上传文件失败: "+err.Error())
		return
	}
	defer out.Close()

	if _, err := io.Copy(out, file); err != nil {
		ErrorResponse(w, http.StatusInternalServerError, "写入上传文件失败: "+err.Error())
		return
	}

	absPath, err := filepath.Abs(localPath)
	if err != nil {
		ErrorResponse(w, http.StatusInternalServerError, "获取文件绝对路径失败: "+err.Error())
		return
	}

	if err := h.wechatService.HelperSendImage(wxid, absPath); err != nil {
		log.Printf("发送图片消息失败: %v", err)
		ErrorResponse(w, http.StatusInternalServerError, "发送图片消息失败: "+err.Error())
		return
	}

	SuccessResponse(w, "发送图片消息成功", nil)
}

// SendFileMessage 发送文件消息
func (h *WeChatHandler) SendFileMessage(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		ErrorResponse(w, http.StatusMethodNotAllowed, "仅支持 POST 方法")
		return
	}

	// 解析 multipart/form-data
	if err := r.ParseMultipartForm(32 << 20); err != nil { // 32MB
		ErrorResponse(w, http.StatusBadRequest, "解析上传表单失败: "+err.Error())
		return
	}

	wxid := r.FormValue("wxid")
	if wxid == "" {
		ErrorResponse(w, http.StatusBadRequest, "wxid不能为空")
		return
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		ErrorResponse(w, http.StatusBadRequest, "获取上传文件失败: "+err.Error())
		return
	}
	defer file.Close()

	uploadDir := "uploads"
	if err := os.MkdirAll(uploadDir, 0755); err != nil {
		ErrorResponse(w, http.StatusInternalServerError, "创建上传目录失败: "+err.Error())
		return
	}

	ext := filepath.Ext(header.Filename)
	fileName := strconv.FormatInt(time.Now().UnixNano(), 10) + ext
	localPath := filepath.Join(uploadDir, fileName)

	out, err := os.Create(localPath)
	if err != nil {
		ErrorResponse(w, http.StatusInternalServerError, "保存上传文件失败: "+err.Error())
		return
	}
	defer out.Close()

	if _, err := io.Copy(out, file); err != nil {
		ErrorResponse(w, http.StatusInternalServerError, "写入上传文件失败: "+err.Error())
		return
	}

	absPath, err := filepath.Abs(localPath)
	if err != nil {
		ErrorResponse(w, http.StatusInternalServerError, "获取文件绝对路径失败: "+err.Error())
		return
	}

	if err := h.wechatService.HelperSendFile(wxid, absPath); err != nil {
		log.Printf("发送文件消息失败: %v", err)
		ErrorResponse(w, http.StatusInternalServerError, "发送文件消息失败: "+err.Error())
		return
	}

	SuccessResponse(w, "发送文件消息成功", nil)
}

// SendCardMessage 发送名片消息
func (h *WeChatHandler) SendCardMessage(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		ErrorResponse(w, http.StatusMethodNotAllowed, "仅支持 POST 方法")
		return
	}

	var req struct {
		Wxid     string `json:"wxid"`
		CardWxid string `json:"card_wxid"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		ErrorResponse(w, http.StatusBadRequest, "请求体不是有效的JSON")
		return
	}

	if req.Wxid == "" {
		ErrorResponse(w, http.StatusBadRequest, "wxid不能为空")
		return
	}
	if req.CardWxid == "" {
		ErrorResponse(w, http.StatusBadRequest, "card_wxid不能为空")
		return
	}

	if err := h.wechatService.HelperSendCard(req.Wxid, req.CardWxid); err != nil {
		log.Printf("发送名片消息失败: %v", err)
		ErrorResponse(w, http.StatusInternalServerError, "发送名片消息失败: "+err.Error())
		return
	}

	SuccessResponse(w, "发送名片消息成功", nil)
}

// ModifyGroupName 修改群名称
func (h *WeChatHandler) ModifyGroupName(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		ErrorResponse(w, http.StatusMethodNotAllowed, "仅支持 POST 方法")
		return
	}

	var req struct {
		RoomWxid string `json:"room_wxid"`
		Name     string `json:"name"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		ErrorResponse(w, http.StatusBadRequest, "请求体不是有效的JSON")
		return
	}

	if req.RoomWxid == "" {
		ErrorResponse(w, http.StatusBadRequest, "room_wxid不能为空")
		return
	}
	if req.Name == "" {
		ErrorResponse(w, http.StatusBadRequest, "name不能为空")
		return
	}

	result, err := h.wechatService.HelperModifyGroupName(req.RoomWxid, req.Name)
	if err != nil {
		log.Printf("修改群名称失败: %v", err)
		ErrorResponse(w, http.StatusInternalServerError, "修改群名称失败: "+err.Error())
		return
	}

	// 直接返回 DLL data 对象，保持结构简单
	SuccessResponse(w, "修改群名称成功", result)
}
