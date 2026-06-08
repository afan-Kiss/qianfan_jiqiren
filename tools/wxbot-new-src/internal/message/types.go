package message

// MessageType 消息类型常量
type MessageType int

const (
	MTDebugLog          MessageType = 11024 // 调试日志
	MTUserLogin         MessageType = 11025 // 用户登录
	MTUserLogout        MessageType = 11026 // 用户登出
	MTCurrentLoginInfo  MessageType = 11028 // 当前登录信息
	MTInviteGroupMember MessageType = 11069 // 邀请好友进群
	MTModifyGroupName   MessageType = 11072 // 修改群名称
	MTVoiceToText       MessageType = 11112 // 语音转文本
	MTMiniProgramCode   MessageType = 11136 // 获取小程序code
	MTFriendInfo        MessageType = 11029 // 指定好友信息
	MTFriendList        MessageType = 11030 // 好友列表
	MTGroupList         MessageType = 11031 // 群列表
	MTGroupMemberList   MessageType = 11032 // 群成员列表
	MTSendText          MessageType = 11036 // 发送文本消息
	MTSendAtText        MessageType = 11037 // 发送@消息
	MTSendCard          MessageType = 11038 // 发送卡片
	MTSendURL           MessageType = 11039 // 发送链接
	MTSendImage         MessageType = 11040 // 发送图片
	MTSendFile          MessageType = 11041 // 发送文件
	MTSendVideo         MessageType = 11042 // 发送视频
	MTSendGif           MessageType = 11043 // 发送GIF
	MTChatMessage       MessageType = 11046 // 聊天消息
	MTLogoutCurrent     MessageType = 11104 // 注销当前微信账号
	MTRefreshQRCode     MessageType = 11087 // 刷新二维码
)

// Message 消息结构
type Message struct {
	Type MessageType            `json:"type"`
	Data map[string]interface{} `json:"data"`
}

// SendTextData 发送文本消息数据
type SendTextData struct {
	ToWxid  string `json:"to_wxid"`
	Content string `json:"content"`
}

// SendAtTextData 发送@消息数据
type SendAtTextData struct {
	ToWxid  string   `json:"to_wxid"`
	Content string   `json:"content"`
	AtList  []string `json:"at_list"`
}

// SendCardData 发送卡片数据
type SendCardData struct {
	ToWxid   string `json:"to_wxid"`
	CardWxid string `json:"card_wxid"`
}

// SendURLData 发送链接数据
type SendURLData struct {
	ToWxid   string `json:"to_wxid"`
	Title    string `json:"title"`
	Desc     string `json:"desc"`
	URL      string `json:"url"`
	ImageURL string `json:"image_url"`
}

// SendFileData 发送文件数据
type SendFileData struct {
	ToWxid string `json:"to_wxid"`
	File   string `json:"file"`
}

// CurrentLoginInfoData 当前登录信息数据
type CurrentLoginInfoData struct {
	Account  string `json:"account"`
	Avatar   string `json:"avatar"`
	Nickname string `json:"nickname"`
	Wxid     string `json:"wxid"`
}

// RefreshQRCodeData 刷新二维码响应数据
type RefreshQRCodeData struct {
	File   string `json:"file"`
	QRCode string `json:"qrcode"`
	PID    int    `json:"pid"`
}

// MiniProgramCodeData 获取小程序code响应数据
type MiniProgramCodeData struct {
	AppIconURL     string   `json:"appIconUrl"`
	AppName        string   `json:"appName"`
	Code           string   `json:"code"`
	LiftSpan       int      `json:"liftSpan"`
	OpenID         string   `json:"openId"`
	ScopeList      []string `json:"scopeList"`
	SessionKey     string   `json:"sessionKey"`
	SessionTicket  string   `json:"sessionTicket"`
	Signature      string   `json:"signature"`
	State          string   `json:"state"`
	BaseResponse   any      `json:"baseResponse"`
	JSAPIBaseReply any      `json:"jsApiBaseResponse"`
}

// VoiceToTextData 语音转文本响应数据
type VoiceToTextData struct {
	FromWxid string `json:"from_wxid"`
	MsgID    string `json:"msgid"`
	RoomWxid string `json:"room_wxid"`
	Status   int    `json:"status"`
	Text     string `json:"text"`
	ToWxid   string `json:"to_wxid"`
	WxType   int    `json:"wx_type"`
}

// FriendInfo 好友信息
type FriendInfo struct {
	Account  string `json:"account"`
	Avatar   string `json:"avatar"`
	City     string `json:"city"`
	Country  string `json:"country"`
	Nickname string `json:"nickname"`
	Province string `json:"province"`
	Remark   string `json:"remark"`
	Sex      int    `json:"sex"`  // 性别 1男 2女 0保密
	Wxid     string `json:"wxid"` // wxid
}

// GroupInfo 群信息
type GroupInfo struct {
	Avatar      string   `json:"avatar"`
	IsManager   int      `json:"is_manager"`
	ManagerWxid string   `json:"manager_wxid"`
	Nickname    string   `json:"nickname"`
	TotalMember int      `json:"total_member"`
	Wxid        string   `json:"wxid"`
	MemberList  []string `json:"member_list,omitempty"`
}

// GroupMemberInfo 群成员信息
type GroupMemberInfo struct {
	Account     string `json:"account"`
	Avatar      string `json:"avatar"`
	City        string `json:"city"`
	Country     string `json:"country"`
	DisplayName string `json:"display_name"` // 群内昵称
	Nickname    string `json:"nickname"`
	Province    string `json:"province"`
	Remark      string `json:"remark"`
	Sex         int    `json:"sex"`
	Wxid        string `json:"wxid"`
}

// GroupMemberListData 群成员列表响应数据
type GroupMemberListData struct {
	Extend     string            `json:"extend"`
	GroupWxid  string            `json:"group_wxid"`
	MemberList []GroupMemberInfo `json:"member_list"`
	Total      int               `json:"total"`
}
