package api

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"time"

	"wxbot-new/internal/config"
	"wxbot-new/internal/service"
)

// Server HTTP API 服务器
type Server struct {
	host       string
	port       int
	httpServer *http.Server
	router     *Router
}

// NewServer 创建 API 服务器
func NewServer(host string, port int, configManager *config.Manager) *Server {
	return &Server{
		host:   host,
		port:   port,
		router: NewRouter(configManager, nil),
	}
}

// SetWeChatService 设置微信服务实例
func (s *Server) SetWeChatService(wechatService *service.WeChatService) {
	s.router.SetWeChatService(wechatService)
}

// Start 启动服务器
func (s *Server) Start() error {
	addr := fmt.Sprintf("%s:%d", s.host, s.port)

	// 创建 HTTP 服务器
	s.httpServer = &http.Server{
		Addr:         addr,
		Handler:      s.router.RegisterRoutes(),
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	log.Printf("HTTP API 服务器启动: %s", addr)

	// 启动服务器
	if err := s.httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		return fmt.Errorf("启动 HTTP 服务器失败: %w", err)
	}

	return nil
}

// Stop 停止服务器
func (s *Server) Stop() error {
	if s.httpServer == nil {
		return nil
	}

	log.Println("正在停止 HTTP API 服务器...")

	// 优雅关闭,最多等待 5 秒
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := s.httpServer.Shutdown(ctx); err != nil {
		return fmt.Errorf("停止 HTTP 服务器失败: %w", err)
	}

	log.Println("HTTP API 服务器已停止")
	return nil
}
