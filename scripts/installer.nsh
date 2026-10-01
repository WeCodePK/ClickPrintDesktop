; Always install for the current user only (skips the "all users / only for me"
; page). Updates install silently with nobody at the machine; a per-machine
; install lives in Program Files and every update would stop on a UAC prompt
; with the app already closed. Silent updates of an EXISTING per-machine install
; are unaffected by this (the installer follows the registry there) — the app
; detects that case itself and falls back to installing on quit.
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

; The app registers itself for launch-at-sign-in via Electron's login-item API,
; which writes an HKCU Run value keyed on the app name. electron-builder's
; uninstaller doesn't know about it, so remove it here — otherwise Windows keeps
; trying to start a deleted executable at every sign-in.
; Both casings are cleared because the value name follows app.getName(), which
; differs between the package name and the product name across builds.
!macro customUnInstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "clickprintdesktop"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "ClickPrintDesktop"
!macroend
