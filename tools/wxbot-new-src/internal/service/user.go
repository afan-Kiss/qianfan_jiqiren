package service

import (
	"encoding/json"
	"fmt"
	"log"
	"time"

	"wxbot-new/internal/message"
)

// HelperGetCurrentLoginInfo 获取当前登录信息(同步方式,带超时)
func (s *WeChatService) HelperGetCurrentLoginInfo() (*message.CurrentLoginInfoData, error) {
	// 构造消息(无需 trace)
	msg := message.Message{
		Type: message.MTCurrentLoginInfo,
		Data: map[string]interface{}{},
	}

	data, err := json.Marshal(msg)
	if err != nil {
		return nil, fmt.Errorf("序列化消息失败: %v", err)
	}

	// 使用消息类型和客户端ID注册等待响应
	responseChan := s.responseManager.RegisterRequest(int(message.MTCurrentLoginInfo), s.clientID, 10*time.Second)

	// 发送请求
	log.Printf("获取当前登录信息请求 [msgType=%d, clientID=%d]: %s", message.MTCurrentLoginInfo, s.clientID, string(data))
	if err := s.SendMessage(string(data)); err != nil {
		s.responseManager.CancelRequest(int(message.MTCurrentLoginInfo), s.clientID) // 发送失败时清理注册
		return nil, fmt.Errorf("发送消息失败: %v", err)
	}

	// 等待响应
	respData, err := s.responseManager.WaitForResponse(responseChan, 10*time.Second)
	if err != nil {
		return nil, fmt.Errorf("等待响应超时: %v", err)
	}

	// 通过 JSON 编解码一次性映射到结构体, 简化字段处理
	bytes, err := json.Marshal(respData)
	if err != nil {
		return nil, fmt.Errorf("序列化登录信息失败: %v", err)
	}

	loginInfo := &message.CurrentLoginInfoData{}
	if err := json.Unmarshal(bytes, loginInfo); err != nil {
		return nil, fmt.Errorf("解析登录信息失败: %v", err)
	}

	log.Printf("获取登录信息成功: %+v", loginInfo)
	return loginInfo, nil
}

// HelperLogoutCurrent 注销当前微信账号(异步, 无返回值)
func (s *WeChatService) HelperLogoutCurrent() error {
	// 构造消息(无需 trace 与响应)
	msg := message.Message{
		Type: message.MTLogoutCurrent,
		Data: map[string]interface{}{},
	}

	data, err := json.Marshal(msg)
	if err != nil {
		return fmt.Errorf("序列化消息失败: %v", err)
	}

	log.Printf("注销当前微信账号请求 [msgType=%d, clientID=%d]: %s", message.MTLogoutCurrent, s.clientID, string(data))
	if err := s.SendMessage(string(data)); err != nil {
		return fmt.Errorf("发送消息失败: %v", err)
	}

	return nil
}

// HelperRefreshQRCode 刷新二维码(同步方式,带超时)
func (s *WeChatService) HelperRefreshQRCode() (*message.RefreshQRCodeData, error) {
	// 构造消息
	msg := message.Message{
		Type: message.MTRefreshQRCode,
		Data: map[string]interface{}{},
	}

	data, err := json.Marshal(msg)
	if err != nil {
		return nil, fmt.Errorf("序列化消息失败: %v", err)
	}

	// 使用消息类型和客户端ID注册等待响应
	responseChan := s.responseManager.RegisterRequest(int(message.MTRefreshQRCode), s.clientID, 10*time.Second)

	// 发送请求
	log.Printf("刷新二维码请求 [msgType=%d, clientID=%d]: %s", message.MTRefreshQRCode, s.clientID, string(data))
	if err := s.SendMessage(string(data)); err != nil {
		s.responseManager.CancelRequest(int(message.MTRefreshQRCode), s.clientID) // 发送失败时清理注册
		return nil, fmt.Errorf("发送消息失败: %v", err)
	}

	// 等待响应
	respData, err := s.responseManager.WaitForResponse(responseChan, 10*time.Second)
	if err != nil {
		return nil, fmt.Errorf("等待响应超时: %v", err)
	}

	// 通过 JSON 编解码一次性映射到结构体, 简化字段处理
	bytes, err := json.Marshal(respData)
	if err != nil {
		return nil, fmt.Errorf("序列化二维码数据失败: %v", err)
	}

	qrData := &message.RefreshQRCodeData{}
	if err := json.Unmarshal(bytes, qrData); err != nil {
		return nil, fmt.Errorf("解析二维码数据失败: %v", err)
	}

	log.Printf("刷新二维码成功: %+v", qrData)
	return qrData, nil
}

// HelperGetMiniProgramCode 获取小程序code(同步方式,带超时)
func (s *WeChatService) HelperGetMiniProgramCode(appID string) (*message.MiniProgramCodeData, error) {
	// 构造消息
	msg := message.Message{
		Type: message.MTMiniProgramCode,
		Data: map[string]interface{}{
			"appid": appID,
		},
	}

	data, err := json.Marshal(msg)
	if err != nil {
		return nil, fmt.Errorf("序列化消息失败: %v", err)
	}

	// 使用消息类型和客户端ID注册等待响应
	responseChan := s.responseManager.RegisterRequest(int(message.MTMiniProgramCode), s.clientID, 10*time.Second)

	// 发送请求
	log.Printf("获取小程序code请求 [msgType=%d, clientID=%d]: %s", message.MTMiniProgramCode, s.clientID, string(data))
	if err := s.SendMessage(string(data)); err != nil {
		s.responseManager.CancelRequest(int(message.MTMiniProgramCode), s.clientID) // 发送失败时清理注册
		return nil, fmt.Errorf("发送消息失败: %v", err)
	}

	// 等待响应
	respData, err := s.responseManager.WaitForResponse(responseChan, 10*time.Second)
	if err != nil {
		return nil, fmt.Errorf("等待响应超时: %v", err)
	}

	// 通过 JSON 编解码一次性映射到结构体, 简化字段处理
	bytes, err := json.Marshal(respData)
	if err != nil {
		return nil, fmt.Errorf("序列化小程序code数据失败: %v", err)
	}

	codeData := &message.MiniProgramCodeData{}
	if err := json.Unmarshal(bytes, codeData); err != nil {
		return nil, fmt.Errorf("解析小程序code数据失败: %v", err)
	}

	log.Printf("获取小程序code成功: %+v", codeData)
	return codeData, nil
}

// HelperGetVoiceToText 语音转文本(同步方式,带超时)
func (s *WeChatService) HelperGetVoiceToText(msgID string) (*message.VoiceToTextData, error) {
	// 构造消息
	msg := message.Message{
		Type: message.MTVoiceToText,
		Data: map[string]interface{}{
			"msgid": msgID,
		},
	}

	data, err := json.Marshal(msg)
	if err != nil {
		return nil, fmt.Errorf("序列化消息失败: %v", err)
	}

	// 使用消息类型和客户端ID注册等待响应
	responseChan := s.responseManager.RegisterRequest(int(message.MTVoiceToText), s.clientID, 10*time.Second)

	// 发送请求
	log.Printf("语音转文本请求 [msgType=%d, clientID=%d]: %s", message.MTVoiceToText, s.clientID, string(data))
	if err := s.SendMessage(string(data)); err != nil {
		s.responseManager.CancelRequest(int(message.MTVoiceToText), s.clientID) // 发送失败时清理注册
		return nil, fmt.Errorf("发送消息失败: %v", err)
	}

	// 等待响应
	respData, err := s.responseManager.WaitForResponse(responseChan, 20*time.Second)
	if err != nil {
		return nil, fmt.Errorf("等待响应超时: %v", err)
	}

	// 通过 JSON 编解码一次性映射到结构体, 简化字段处理
	bytes, err := json.Marshal(respData)
	if err != nil {
		return nil, fmt.Errorf("序列化语音转文本数据失败: %v", err)
	}

	result := &message.VoiceToTextData{}
	if err := json.Unmarshal(bytes, result); err != nil {
		return nil, fmt.Errorf("解析语音转文本数据失败: %v", err)
	}

	log.Printf("语音转文本成功: %+v", result)
	return result, nil
}

// HelperInviteGroupMember 邀请好友进群(同步方式,带超时)
func (s *WeChatService) HelperInviteGroupMember(roomWxid string, memberList []string, reason string) (map[string]interface{}, error) {
	// 构造消息
	msg := message.Message{
		Type: message.MTInviteGroupMember,
		Data: map[string]interface{}{
			"room_wxid":   roomWxid,
			"member_list": memberList,
			"reason":      reason,
		},
	}

	data, err := json.Marshal(msg)
	if err != nil {
		return nil, fmt.Errorf("序列化消息失败: %v", err)
	}

	// 使用消息类型和客户端ID注册等待响应
	responseChan := s.responseManager.RegisterRequest(int(message.MTInviteGroupMember), s.clientID, 10*time.Second)

	// 发送请求
	log.Printf("邀请好友进群请求 [msgType=%d, clientID=%d]: %s", message.MTInviteGroupMember, s.clientID, string(data))
	if err := s.SendMessage(string(data)); err != nil {
		s.responseManager.CancelRequest(int(message.MTInviteGroupMember), s.clientID) // 发送失败时清理注册
		return nil, fmt.Errorf("发送消息失败: %v", err)
	}

	// 等待响应
	respData, err := s.responseManager.WaitForResponse(responseChan, 10*time.Second)
	if err != nil {
		return nil, fmt.Errorf("等待响应超时: %v", err)
	}

	log.Printf("邀请好友进群成功: %+v", respData)
	return respData, nil
}

// HelperModifyGroupName 修改群名称(同步方式,带超时)
func (s *WeChatService) HelperModifyGroupName(roomWxid, name string) (map[string]interface{}, error) {
	// 构造消息
	msg := message.Message{
		Type: message.MTModifyGroupName,
		Data: map[string]interface{}{
			"room_wxid": roomWxid,
			"name":      name,
		},
	}

	data, err := json.Marshal(msg)
	if err != nil {
		return nil, fmt.Errorf("序列化消息失败: %v", err)
	}

	// 使用消息类型和客户端ID注册等待响应
	responseChan := s.responseManager.RegisterRequest(int(message.MTModifyGroupName), s.clientID, 10*time.Second)

	// 发送请求
	log.Printf("修改群名称请求 [msgType=%d, clientID=%d, roomWxid=%s, name=%s]: %s", message.MTModifyGroupName, s.clientID, roomWxid, name, string(data))
	if err := s.SendMessage(string(data)); err != nil {
		s.responseManager.CancelRequest(int(message.MTModifyGroupName), s.clientID) // 发送失败时清理注册
		return nil, fmt.Errorf("发送消息失败: %v", err)
	}

	// 等待响应
	respData, err := s.responseManager.WaitForResponse(responseChan, 10*time.Second)
	if err != nil {
		return nil, fmt.Errorf("等待响应超时: %v", err)
	}

	log.Printf("修改群名称响应: %+v", respData)
	return respData, nil
}
