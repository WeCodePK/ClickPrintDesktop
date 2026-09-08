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
