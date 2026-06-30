# 启动 dist 目录下最新打包的千帆客服台机器人（无控制台窗口）
$ErrorActionPreference = 'Stop'

$appExeName = '千帆客服台机器人.exe'
$portableSuffix = '-便携版.exe'

function Get-ProjectRoot {
  $fromEnv = [string]$env:QIANFAN_BOT_ROOT
  if ($fromEnv) {
    return $fromEnv.TrimEnd('\')
  }
  return (Split-Path $PSScriptRoot -Parent)
}

function Get-LatestPackagedExe {
  param([string]$DistDir)

  $candidates = @()

  $unpacked = Join-Path (Join-Path $DistDir 'win-unpacked') $appExeName
  if (Test-Path -LiteralPath $unpacked) {
    $candidates += Get-Item -LiteralPath $unpacked
  }

  if (Test-Path -LiteralPath $DistDir) {
    $portables = Get-ChildItem -LiteralPath $DistDir -File -Filter "*$portableSuffix" -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -like "*$appExeName*" }
    if ($portables) {
      $candidates += $portables
    }
  }

  if (-not $candidates.Count) {
    return $null
  }

  return ($candidates | Sort-Object LastWriteTime -Descending | Select-Object -First 1)
}

$root = Get-ProjectRoot
$dist = Join-Path $root 'dist'
$exe = Get-LatestPackagedExe -DistDir $dist

if (-not $exe) {
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.MessageBox]::Show(
    "未找到打包程序，请先在本项目目录执行：`n`n  npm run build`n`n查找目录：`n  $dist",
    '千帆客服台机器人',
    [System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Windows.Forms.MessageBoxIcon]::Error
  ) | Out-Null
  exit 1
}

Start-Process -FilePath $exe.FullName -WorkingDirectory $exe.DirectoryName
exit 0
