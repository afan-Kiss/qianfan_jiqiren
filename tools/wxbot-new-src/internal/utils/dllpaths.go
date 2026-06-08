package utils

import (
	"errors"
	"os"
)

type dllPair struct {
	Loader string
	Helper string
}

// 优先级：NoveLoader/NoveHelper（正确名）→ vcruntime140/msvcp140（旧源码）→ NovelLoader/NovelHelper（可选）
var dllCandidates = []dllPair{
	{Loader: "./NoveLoader.dll", Helper: "./NoveHelper.dll"},
	{Loader: "./vcruntime140.dll", Helper: "./msvcp140.dll"},
	{Loader: "./NovelLoader.dll", Helper: "./NovelHelper.dll"},
}

func fileExists(path string) bool {
	if path == "" {
		return false
	}
	_, err := os.Stat(path)
	return err == nil
}

// ResolveDllPaths 按优先级或环境变量 WXBOT_LOADER_DLL / WXBOT_HELPER_DLL 解析 DLL 路径。
func ResolveDllPaths() (loaderPath, helperPath string, err error) {
	loaderPath = os.Getenv("WXBOT_LOADER_DLL")
	helperPath = os.Getenv("WXBOT_HELPER_DLL")

	if loaderPath != "" && helperPath != "" {
		return loaderPath, helperPath, nil
	}

	for _, c := range dllCandidates {
		if !fileExists(c.Loader) || !fileExists(c.Helper) {
			continue
		}
		if loaderPath == "" {
			loaderPath = c.Loader
		}
		if helperPath == "" {
			helperPath = c.Helper
		}
		break
	}

	if loaderPath == "" || helperPath == "" {
		return "", "", errors.New("未找到 wxbot-new 所需 DLL，请把 NoveLoader.dll 和 NoveHelper.dll 放到 wxbot.exe 同目录。")
	}
	return loaderPath, helperPath, nil
}
