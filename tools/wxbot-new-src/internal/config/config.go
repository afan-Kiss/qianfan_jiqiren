package config

import (
	"encoding/json"
	"fmt"
	"os"
	"sync"
)

// AuthUser 认证用户
type AuthUser struct {
	Username string `json:"username"` // 用户名
	Password string `json:"password"` // 密码
}

// Config 配置结构
type Config struct {
	Host            string     `json:"host"`                        // 服务地址
	Port            int        `json:"port"`                        // 服务端口
	Auth            []AuthUser `json:"auth,omitempty"`              // HTTP Basic 认证用户列表
	LogRecvCallback int        `json:"log_recv_callback,omitempty"` // 是否输出接收消息回调日志(1=输出,0=关闭)
	CallbackURLs    []string   `json:"callback_urls,omitempty"`     // 消息回调地址列表
}

// Manager 配置管理器
type Manager struct {
	filePath string
	config   *Config
	mu       sync.RWMutex
}

// NewManager 创建配置管理器
func NewManager(filePath string) *Manager {
	return &Manager{
		filePath: filePath,
		config:   getDefaultConfig(),
	}
}

// getDefaultConfig 获取默认配置
func getDefaultConfig() *Config {
	return &Config{
		Host:            "0.0.0.0",
		Port:            5000,
		Auth:            []AuthUser{}, // 默认空数组,不启用认证
		LogRecvCallback: 0,            // 默认开启接收消息回调日志
		CallbackURLs:    []string{},   // 默认无回调地址
	}
}

// Load 加载配置文件
func (m *Manager) Load() error {
	m.mu.Lock()
	defer m.mu.Unlock()

	// 如果文件不存在,使用默认配置并保存
	if _, err := os.Stat(m.filePath); os.IsNotExist(err) {
		m.config = getDefaultConfig()
		return m.saveUnsafe()
	}

	// 读取文件
	data, err := os.ReadFile(m.filePath)
	if err != nil {
		return fmt.Errorf("读取配置文件失败: %w", err)
	}

	// 使用默认配置作为基础, 解析 JSON 覆盖已有字段
	cfg := getDefaultConfig()
	if err := json.Unmarshal(data, cfg); err != nil {
		return fmt.Errorf("解析配置文件失败: %w", err)
	}

	m.config = cfg
	return nil
}

// Get 获取完整配置
func (m *Manager) Get() *Config {
	m.mu.RLock()
	defer m.mu.RUnlock()

	// 返回副本避免外部修改
	authCopy := make([]AuthUser, len(m.config.Auth))
	copy(authCopy, m.config.Auth)

	callbackURLsCopy := make([]string, len(m.config.CallbackURLs))
	copy(callbackURLsCopy, m.config.CallbackURLs)

	return &Config{
		Host:            m.config.Host,
		Port:            m.config.Port,
		Auth:            authCopy,
		LogRecvCallback: m.config.LogRecvCallback,
		CallbackURLs:    callbackURLsCopy,
	}
}

// GetValue 获取指定配置项
func (m *Manager) GetValue(key string) (interface{}, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	switch key {
	case "host":
		return m.config.Host, nil
	case "port":
		return m.config.Port, nil
	case "auth":
		authCopy := make([]AuthUser, len(m.config.Auth))
		copy(authCopy, m.config.Auth)
		return authCopy, nil
	case "log_recv_callback":
		return m.config.LogRecvCallback, nil
	case "callback_urls":
		callbackURLsCopy := make([]string, len(m.config.CallbackURLs))
		copy(callbackURLsCopy, m.config.CallbackURLs)
		return callbackURLsCopy, nil
	default:
		return nil, fmt.Errorf("未知的配置项: %s", key)
	}
}

// Update 更新完整配置
func (m *Manager) Update(cfg *Config) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	// 验证配置
	if err := validateConfig(cfg); err != nil {
		return err
	}

	m.config = cfg
	return m.saveUnsafe()
}

// UpdateValue 更新指定配置项
func (m *Manager) UpdateValue(key string, value interface{}) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	switch key {
	case "host":
		if host, ok := value.(string); ok {
			m.config.Host = host
		} else {
			return fmt.Errorf("host 必须是字符串类型")
		}
	case "port":
		// 支持 int 和 float64 (JSON 数字默认是 float64)
		switch v := value.(type) {
		case int:
			m.config.Port = v
		case float64:
			m.config.Port = int(v)
		default:
			return fmt.Errorf("port 必须是数字类型")
		}
	case "auth":
		// 解析 auth 数组
		authUsers, err := parseAuthUsers(value)
		if err != nil {
			return err
		}
		m.config.Auth = authUsers
	case "log_recv_callback":
		// 支持 int 和 float64 (JSON 数字默认是 float64)
		switch v := value.(type) {
		case int:
			m.config.LogRecvCallback = v
		case float64:
			m.config.LogRecvCallback = int(v)
		default:
			return fmt.Errorf("log_recv_callback 必须是数字类型")
		}
	case "callback_urls":
		// value 可能是 []interface{}
		arr, ok := value.([]interface{})
		if !ok {
			return fmt.Errorf("callback_urls 必须是数组类型")
		}
		urls := make([]string, 0, len(arr))
		for i, item := range arr {
			str, ok := item.(string)
			if !ok {
				return fmt.Errorf("callback_urls[%d] 必须是字符串类型", i)
			}
			if str == "" {
				continue
			}
			urls = append(urls, str)
		}
		m.config.CallbackURLs = urls
	default:
		return fmt.Errorf("未知的配置项: %s", key)
	}

	// 验证配置
	if err := validateConfig(m.config); err != nil {
		return err
	}

	return m.saveUnsafe()
}

// parseAuthUsers 解析认证用户列表
func parseAuthUsers(value interface{}) ([]AuthUser, error) {
	// value 可能是 []interface{} (从 JSON 解析来的)
	arr, ok := value.([]interface{})
	if !ok {
		return nil, fmt.Errorf("auth 必须是数组类型")
	}

	users := make([]AuthUser, 0, len(arr))
	for i, item := range arr {
		userMap, ok := item.(map[string]interface{})
		if !ok {
			return nil, fmt.Errorf("auth[%d] 必须是对象类型", i)
		}

		username, ok := userMap["username"].(string)
		if !ok || username == "" {
			return nil, fmt.Errorf("auth[%d].username 必须是非空字符串", i)
		}

		password, ok := userMap["password"].(string)
		if !ok || password == "" {
			return nil, fmt.Errorf("auth[%d].password 必须是非空字符串", i)
		}

		users = append(users, AuthUser{
			Username: username,
			Password: password,
		})
	}

	return users, nil
}

// Delete 删除配置文件(恢复默认值)
func (m *Manager) Delete() error {
	m.mu.Lock()
	defer m.mu.Unlock()

	// 删除文件
	if err := os.Remove(m.filePath); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("删除配置文件失败: %w", err)
	}

	// 恢复默认配置
	m.config = getDefaultConfig()
	return m.saveUnsafe()
}

// saveUnsafe 保存配置(不加锁,内部使用)
func (m *Manager) saveUnsafe() error {
	data, err := json.MarshalIndent(m.config, "", "  ")
	if err != nil {
		return fmt.Errorf("序列化配置失败: %w", err)
	}

	if err := os.WriteFile(m.filePath, data, 0644); err != nil {
		return fmt.Errorf("写入配置文件失败: %w", err)
	}

	return nil
}

// validateConfig 验证配置合法性
func validateConfig(cfg *Config) error {
	if cfg.Host == "" {
		return fmt.Errorf("host 不能为空")
	}
	if cfg.Port <= 0 || cfg.Port > 65535 {
		return fmt.Errorf("port 必须在 1-65535 之间")
	}
	if cfg.LogRecvCallback != 0 && cfg.LogRecvCallback != 1 {
		return fmt.Errorf("log_recv_callback 必须是 0 或 1")
	}
	return nil
}
