' Ortak — tek tıkla başlat. Sunucuyu gizli başlatır (zaten açıksa dokunmaz) ve arayüzü açar.
'   wscript Ortak.vbs          başlat / aç
'   wscript Ortak.vbs stop     arka plandaki sunucuyu kapat
' Kısayolları oluşturmak için: npm run kisayol
' (Bu dosya UTF-16 LE kaydedilmeli; Windows Script Host UTF-8'i okuyamaz.)
Option Explicit
Dim sh, fso, dir, rc, script
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir

script = "launch.mjs"
If WScript.Arguments.Count > 0 Then
  If LCase(WScript.Arguments(0)) = "stop" Then script = "stop.mjs"
End If

On Error Resume Next
rc = sh.Run("node """ & dir & "\scripts\" & script & """", 0, True)
If Err.Number <> 0 Then
  MsgBox "Node.js bulunamadı. https://nodejs.org adresinden kurup tekrar deneyin.", vbCritical, "Ortak"
  WScript.Quit 1
End If
On Error GoTo 0

If script = "stop.mjs" Then
  If rc = 0 Then
    MsgBox "Ortak kapatıldı.", vbInformation, "Ortak"
  ElseIf rc = 2 Then
    MsgBox "Ortak zaten çalışmıyor.", vbInformation, "Ortak"
  Else
    MsgBox "Ortak kapatılamadı.", vbExclamation, "Ortak"
  End If
ElseIf rc <> 0 Then
  MsgBox "Ortak başlatılamadı." & vbCrLf & vbCrLf & "Ayrıntılar: " & dir & "\data\server.log", vbExclamation, "Ortak"
End If
