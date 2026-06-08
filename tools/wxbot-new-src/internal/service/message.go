package service

import (
	"encoding/json"
	"fmt"
	"log"

	"wxbot-new/internal/message"
)

// HelperSendText 发送普通文本消息
func (s *WeChatService) HelperSendText(wxid, content string) error {
	msg := message.Message{
		Type: message.MTSendText,
		Data: map[string]interface{}{
			"to_wxid": wxid,
			"content": content,
		},
	}

	data, err := json.Marshal(msg)
	if err != nil {
		return fmt.Errorf("序列化消息失败: %v", err)
	}

	log.Printf("发送文本消息: %s", string(data))
	return s.SendMessage(string(data))
}

// HelperSendAtText 发送@消息
func (s *WeChatService) HelperSendAtText(toWxid, content string, atList []string) error {
	msg := message.Message{
		Type: message.MTSendAtText,
		Data: map[string]interface{}{
			"to_wxid": toWxid,
			"content": content,
			"at_list": atList,
		},
	}

	data, err := json.Marshal(msg)
	if err != nil {
		return fmt.Errorf("序列化消息失败: %v", err)
	}

	log.Printf("发送@消息: %s", string(data))
	return s.SendMessage(string(data))
}

// HelperSendCard 发送名片消息
func (s *WeChatService) HelperSendCard(toWxid, cardWxid string) error {
	msg := message.Message{
		Type: message.MTSendCard,
		Data: map[string]interface{}{
			"to_wxid":   toWxid,
			"card_wxid": cardWxid,
		},
	}

	data, err := json.Marshal(msg)
	if err != nil {
		return fmt.Errorf("序列化消息失败: %v", err)
	}

	log.Printf("发送卡片消息: %s", string(data))
	return s.SendMessage(string(data))
}

// HelperSendURL 发送链接消息
func (s *WeChatService) HelperSendURL(toWxid, title, desc, url, imageURL string) error {
	msg := message.Message{
		Type: message.MTSendURL,
		Data: map[string]interface{}{
			"to_wxid":   toWxid,
			"title":     title,
			"desc":      desc,
			"url":       url,
			"image_url": imageURL,
		},
	}

	data, err := json.Marshal(msg)
	if err != nil {
		return fmt.Errorf("序列化消息失败: %v", err)
	}

	log.Printf("发送链接消息: %s", string(data))
	return s.SendMessage(string(data))
}

// HelperSendImage 发送图片消息
func (s *WeChatService) HelperSendImage(toWxid, filePath string) error {
	msg := message.Message{
		Type: message.MTSendImage,
		Data: map[string]interface{}{
			"to_wxid": toWxid,
			"file":    filePath,
		},
	}

	data, err := json.Marshal(msg)
	if err != nil {
		return fmt.Errorf("序列化消息失败: %v", err)
	}

	log.Printf("发送图片消息: %s", string(data))
	return s.SendMessage(string(data))
}

// HelperSendFile 发送文件消息
func (s *WeChatService) HelperSendFile(toWxid, filePath string) error {
	msg := message.Message{
		Type: message.MTSendFile,
		Data: map[string]interface{}{
			"to_wxid": toWxid,
			"file":    filePath,
		},
	}

	data, err := json.Marshal(msg)
	if err != nil {
		return fmt.Errorf("序列化消息失败: %v", err)
	}

	log.Printf("发送文件消息: %s", string(data))
	return s.SendMessage(string(data))
}

// HelperSendVideo 发送视频消息
func (s *WeChatService) HelperSendVideo(toWxid, filePath string) error {
	msg := message.Message{
		Type: message.MTSendVideo,
		Data: map[string]interface{}{
			"to_wxid": toWxid,
			"file":    filePath,
		},
	}

	data, err := json.Marshal(msg)
	if err != nil {
		return fmt.Errorf("序列化消息失败: %v", err)
	}

	log.Printf("发送视频消息: %s", string(data))
	return s.SendMessage(string(data))
}

// HelperSendGif 发送GIF消息
func (s *WeChatService) HelperSendGif(toWxid, filePath string) error {
	msg := message.Message{
		Type: message.MTSendGif,
		Data: map[string]interface{}{
			"to_wxid": toWxid,
			"file":    filePath,
		},
	}

	data, err := json.Marshal(msg)
	if err != nil {
		return fmt.Errorf("序列化消息失败: %v", err)
	}

	log.Printf("发送GIF消息: %s", string(data))
	return s.SendMessage(string(data))
}
