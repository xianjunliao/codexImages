Option Explicit

Dim shell, fso, scriptDir, projectRoot, lifeBaseUrl, command
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
projectRoot = fso.GetParentFolderName(scriptDir)
lifeBaseUrl = ""

If WScript.Arguments.Count >= 1 Then
    lifeBaseUrl = WScript.Arguments.Item(0)
End If

command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ _
    & projectRoot & "\scripts\start-local-services.ps1"" -ProjectRoot """ & projectRoot & """"

If Len(lifeBaseUrl) > 0 Then
    command = command & " -LifeBaseUrl """ & lifeBaseUrl & """"
End If

shell.Run command, 0, False
