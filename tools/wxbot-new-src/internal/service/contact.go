package service

import (
	"encoding/json"
	"fmt"
	"log"
	"time"

	"wxbot-new/internal/message"
)

// HelperGetFriendList 获取好友列表（同步方式, 带超时）
func (s *WeChatService) HelperGetFriendList() ([]*message.FriendInfo, error) {
	// 构造消息
	msg := message.Message{
		Type: message.MTFriendList,
		Data: make(map[string]interface{}),
	}

	data, err := json.Marshal(msg)
	if err != nil {
		return nil, fmt.Errorf("序列化消息失败: %v", err)
	}

	// 使用消息类型和客户端ID注册等待响应
	responseChan := s.responseManager.RegisterRequest(int(message.MTFriendList), s.clientID, 10*time.Second)

	// 发送请求
	log.Printf("获取好友列表请求 [msgType=%d, clientID=%d]: %s", message.MTFriendList, s.clientID, string(data))
	if err := s.SendMessage(string(data)); err != nil {
		s.responseManager.CancelRequest(int(message.MTFriendList), s.clientID)
		return nil, fmt.Errorf("发送消息失败: %v", err)
	}

	// 等待响应
	respData, err := s.responseManager.WaitForResponse(responseChan, 10*time.Second)
	if err != nil {
		return nil, fmt.Errorf("等待响应超时: %v", err)
	}
	// 解析响应数据中的好友数组
	friends := make([]*message.FriendInfo, 0)

	rawList, ok := respData["data"].([]interface{})
	if !ok {
		log.Printf("好友列表数据格式不正确: %v", respData)
		return friends, nil
	}

	for _, item := range rawList {
		m, ok := item.(map[string]interface{})
		if !ok {
			continue
		}

		// 通过 JSON 编解码一次性映射到结构体, 简化字段处理
		bytes, err := json.Marshal(m)
		if err != nil {
			log.Printf("序列化好友数据失败: %v, data=%v", err, m)
			continue
		}

		var friend message.FriendInfo
		if err := json.Unmarshal(bytes, &friend); err != nil {
			log.Printf("解析好友数据失败: %v, json=%s", err, string(bytes))
			continue
		}

		friends = append(friends, &friend)
	}

	log.Printf("获取好友列表成功, 总数: %d", len(friends))
	return friends, nil
}

// HelperGetGroupList 获取群列表（同步方式, 带超时）
func (s *WeChatService) HelperGetGroupList(detail int) ([]*message.GroupInfo, error) {
	// 构造消息
	msg := message.Message{
		Type: message.MTGroupList,
		Data: map[string]interface{}{
			"detail": detail,
		},
	}

	data, err := json.Marshal(msg)
	if err != nil {
		return nil, fmt.Errorf("序列化消息失败: %v", err)
	}

	// 使用消息类型和客户端ID注册等待响应
	responseChan := s.responseManager.RegisterRequest(int(message.MTGroupList), s.clientID, 10*time.Second)

	// 发送请求
	log.Printf("获取群列表请求 [msgType=%d, clientID=%d, detail=%d]: %s", message.MTGroupList, s.clientID, detail, string(data))
	if err := s.SendMessage(string(data)); err != nil {
		s.responseManager.CancelRequest(int(message.MTGroupList), s.clientID)
		return nil, fmt.Errorf("发送消息失败: %v", err)
	}

	// 等待响应
	respData, err := s.responseManager.WaitForResponse(responseChan, 10*time.Second)
	if err != nil {
		return nil, fmt.Errorf("等待响应超时: %v", err)
	}

	groups := make([]*message.GroupInfo, 0)

	rawList, ok := respData["data"].([]interface{})
	if !ok {
		log.Printf("群列表数据格式不正确: %v", respData)
		return groups, nil
	}

	for _, item := range rawList {
		m, ok := item.(map[string]interface{})
		if !ok {
			continue
		}

		bytes, err := json.Marshal(m)
		if err != nil {
			log.Printf("序列化群数据失败: %v, data=%v", err, m)
			continue
		}

		var group message.GroupInfo
		if err := json.Unmarshal(bytes, &group); err != nil {
			log.Printf("解析群数据失败: %v, json=%s", err, string(bytes))
			continue
		}

		groups = append(groups, &group)
	}

	log.Printf("获取群列表成功, 总数: %d", len(groups))
	return groups, nil
}

// HelperGetGroupMemberList 获取群成员列表（同步方式, 带超时）
func (s *WeChatService) HelperGetGroupMemberList(roomWxid string) (*message.GroupMemberListData, error) {
	// 构造消息
	msg := message.Message{
		Type: message.MTGroupMemberList,
		Data: map[string]interface{}{
			"room_wxid": roomWxid,
		},
	}

	data, err := json.Marshal(msg)
	if err != nil {
		return nil, fmt.Errorf("序列化消息失败: %v", err)
	}

	// 使用消息类型和客户端ID注册等待响应
	responseChan := s.responseManager.RegisterRequest(int(message.MTGroupMemberList), s.clientID, 10*time.Second)

	// 发送请求
	log.Printf("获取群成员列表请求 [msgType=%d, clientID=%d, roomWxid=%s]: %s", message.MTGroupMemberList, s.clientID, roomWxid, string(data))
	if err := s.SendMessage(string(data)); err != nil {
		s.responseManager.CancelRequest(int(message.MTGroupMemberList), s.clientID)
		return nil, fmt.Errorf("发送消息失败: %v", err)
	}

	// 等待响应
	respData, err := s.responseManager.WaitForResponse(responseChan, 10*time.Second)
	if err != nil {
		return nil, fmt.Errorf("等待响应超时: %v", err)
	}

	// respData 为包含 extend/group_wxid/member_list/total 的对象
	bytes, err := json.Marshal(respData)
	if err != nil {
		return nil, fmt.Errorf("序列化群成员列表数据失败: %v", err)
	}

	result := &message.GroupMemberListData{}
	if err := json.Unmarshal(bytes, result); err != nil {
		return nil, fmt.Errorf("解析群成员列表数据失败: %v", err)
	}

	log.Printf("获取群成员列表成功, group_wxid=%s, total=%d", result.GroupWxid, result.Total)
	return result, nil
}

// HelperGetFriendInfo 获取指定好友信息（同步方式, 带超时）
func (s *WeChatService) HelperGetFriendInfo(wxid string) (*message.FriendInfo, error) {
	// 构造消息
	msg := message.Message{
		Type: message.MTFriendInfo,
		Data: map[string]interface{}{
			"wxid": wxid,
		},
	}

	data, err := json.Marshal(msg)
	if err != nil {
		return nil, fmt.Errorf("序列化消息失败: %v", err)
	}

	// 使用消息类型和客户端ID注册等待响应
	responseChan := s.responseManager.RegisterRequest(int(message.MTFriendInfo), s.clientID, 10*time.Second)

	// 发送请求
	log.Printf("获取好友信息请求 [msgType=%d, clientID=%d, wxid=%s]: %s", message.MTFriendInfo, s.clientID, wxid, string(data))
	if err := s.SendMessage(string(data)); err != nil {
		s.responseManager.CancelRequest(int(message.MTFriendInfo), s.clientID)
		return nil, fmt.Errorf("发送消息失败: %v", err)
	}

	// 等待响应
	respData, err := s.responseManager.WaitForResponse(responseChan, 10*time.Second)
	if err != nil {
		return nil, fmt.Errorf("等待响应超时: %v", err)
	}
	// respData 即为好友详细信息字段集合
	bytes, err := json.Marshal(respData)
	if err != nil {
		return nil, fmt.Errorf("序列化好友信息失败: %v", err)
	}

	friend := &message.FriendInfo{}
	if err := json.Unmarshal(bytes, friend); err != nil {
		return nil, fmt.Errorf("解析好友信息失败: %v", err)
	}

	log.Printf("获取好友信息成功: %+v", friend)
	return friend, nil
}
