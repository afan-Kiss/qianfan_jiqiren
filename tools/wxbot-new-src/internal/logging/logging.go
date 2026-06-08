package logging

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// dailyFileWriter 是一个按天切换日志文件的 Writer:
// - 文件名: <prefix>-YYYY-MM-DD.log
// - 路径:   <dir>/<filename>
// - 在首次写入新的一天日志时自动切换文件
type dailyFileWriter struct {
	mu          sync.Mutex
	dir         string
	prefix      string
	currentDate string
	file        *os.File
}

// newDailyFileWriter 创建一个按天切换日志文件的 Writer。
func newDailyFileWriter(dir, prefix string) (*dailyFileWriter, error) {
	if err := os.MkdirAll(dir, 0755); err != nil {
		return nil, err
	}

	w := &dailyFileWriter{
		dir:    dir,
		prefix: prefix,
	}

	if err := w.rotateIfNeeded(); err != nil {
		return nil, err
	}

	return w, nil
}

// rotateIfNeeded 检查当前日期是否变化, 如已跨天则切换到新文件。
func (w *dailyFileWriter) rotateIfNeeded() error {
	date := time.Now().Format("2006-01-02")

	if w.file != nil && date == w.currentDate {
		return nil
	}

	if w.file != nil {
		_ = w.file.Close()
		w.file = nil
	}

	filename := fmt.Sprintf("%s-%s.log", w.prefix, date)
	logPath := filepath.Join(w.dir, filename)

	file, err := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0644)
	if err != nil {
		return err
	}

	w.file = file
	w.currentDate = date

	return nil
}

// Write 实现 io.Writer 接口, 在写入前保证文件已按当前日期切换。
func (w *dailyFileWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()

	if err := w.rotateIfNeeded(); err != nil {
		return 0, err
	}

	return w.file.Write(p)
}

// Init 初始化全局日志配置:
// - 日志格式: 日期、时间、短文件名
// - 输出位置: ./logs/wxbot-YYYY-MM-DD.log
// - 每天自动切换新的日志文件
func Init() error {
	log.SetFlags(log.Ldate | log.Ltime | log.Lshortfile)

	writer, err := newDailyFileWriter("logs", "wxbot")
	if err != nil {
		return err
	}

	log.SetOutput(writer)

	return nil
}
