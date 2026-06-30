Dim fso, root, ps1
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
ps1 = root & "\scripts\Launch-PackagedApp.ps1"
CreateObject("WScript.Shell").Environment("PROCESS")("QIANFAN_BOT_ROOT") = root & "\"
CreateObject("WScript.Shell").Run "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & ps1 & """", 0, False
