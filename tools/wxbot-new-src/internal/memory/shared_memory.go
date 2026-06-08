package memory

import (
	"fmt"
	"syscall"
	"unsafe"
)

const (
	PageReadWrite      = 0x04
	FileMapAllAccess   = 0x000F001F
	InvalidHandleValue = ^uintptr(0)
	SharedMemSize      = 33
	SharedMemName      = "windows_shell_global__"
	SharedMemKey       = "3101b223dca7715b0154924f0eeeee20"
)

var (
	kernel32 = syscall.NewLazyDLL("kernel32.dll")
	ntdll    = syscall.NewLazyDLL("ntdll.dll")

	procCreateFileMappingA = kernel32.NewProc("CreateFileMappingA")
	procMapViewOfFile      = kernel32.NewProc("MapViewOfFile")
	procUnmapViewOfFile    = kernel32.NewProc("UnmapViewOfFile")
	procCloseHandle        = kernel32.NewProc("CloseHandle")
	procMemmove            = ntdll.NewProc("memmove")
)

// SharedMemoryManager 共享内存管理器
type SharedMemoryManager struct {
	hMap     uintptr
	dataAddr uintptr
}

// NewSharedMemoryManager 创建共享内存管理器
func NewSharedMemoryManager() *SharedMemoryManager {
	return &SharedMemoryManager{}
}

// CreateAndWriteSharedMemory 创建并写入共享内存
func (m *SharedMemoryManager) CreateAndWriteSharedMemory() error {
	// 1. 创建共享内存（33字节）
	hMap, _, err := procCreateFileMappingA.Call(
		InvalidHandleValue,
		0,
		PageReadWrite,
		0,
		SharedMemSize,
		uintptr(unsafe.Pointer(syscall.StringBytePtr(SharedMemName))),
	)

	if hMap == 0 || hMap == InvalidHandleValue {
		return fmt.Errorf("创建映射文件失败: %v", err)
	}

	m.hMap = hMap

	// 2. 映射到内存
	dataAddr, _, err := procMapViewOfFile.Call(
		hMap,
		FileMapAllAccess,
		0,
		0,
		0,
	)

	if dataAddr == 0 {
		m.Close()
		return fmt.Errorf("映射到内存失败: %v", err)
	}

	m.dataAddr = dataAddr

	// 3. 准备并写入数据
	keyBytes := []byte(SharedMemKey)
	if len(keyBytes) == 32 {
		keyBytes = append(keyBytes, 0x00)
	}

	if len(keyBytes) != SharedMemSize {
		m.Close()
		return fmt.Errorf("数据长度错误，应为%d字节，实际为%d字节", SharedMemSize, len(keyBytes))
	}

	// 4. 写入共享内存
	procMemmove.Call(
		dataAddr,
		uintptr(unsafe.Pointer(&keyBytes[0])),
		uintptr(len(keyBytes)),
	)

	return nil
}

// Close 关闭共享内存
func (m *SharedMemoryManager) Close() error {
	if m.dataAddr != 0 {
		procUnmapViewOfFile.Call(m.dataAddr)
		m.dataAddr = 0
	}

	if m.hMap != 0 {
		procCloseHandle.Call(m.hMap)
		m.hMap = 0
	}

	return nil
}
