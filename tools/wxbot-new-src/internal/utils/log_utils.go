package utils

import (
	"fmt"
	"log"
)

// LogBothln 在日志文件和控制台同时输出一行日志
func LogBothln(v ...interface{}) {
	log.Println(v...)
	fmt.Println(v...)
}

// LogBothf 在日志文件和控制台同时输出格式化日志
func LogBothf(format string, v ...interface{}) {
	log.Printf(format, v...)
	fmt.Printf(format+"\n", v...)
}
