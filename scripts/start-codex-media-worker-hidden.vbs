Option Explicit

Dim shell, fso, scriptDir, projectRoot, lifeBaseUrl, command
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
projectRoot = fso.GetParentFolderName(scriptDir)
lifeBaseUrl = "http://127.0.0.1:8080"

If WScript.Arguments.Count >= 1 Then
    lifeBaseUrl = WScript.Arguments.Item(0)
End If

command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ _
    & projectRoot & "\scripts\start-codex-media-worker.ps1"" -LifeBaseUrl """ _
    & lifeBaseUrl & """ -ProjectRoot """ & projectRoot & """"

shell.Run command, 0, False
