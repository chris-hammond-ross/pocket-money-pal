; Custom steps for the NSIS installer (electron-builder's `nsis.include`).
;
; - Always installs for the current user, so auto-updates never need admin rights.
; - Adds a Windows firewall rule so parents' phones can reach the server, asking Windows for
;   admin rights once (UAC) just for that, and removes it on uninstall. The rule covers every
;   network profile but only devices on the local subnet: on PCs with VirtualBox, Hyper-V or VPN
;   adapters, Windows can judge the home network as Public (installation.md).
; - Updates (`--updated`) skip both, so an unattended kiosk never sees a prompt.

!define PMP_RULE "Pocket Money Pal"
!define PMP_PORT "4789"
!define PMP_RUN_KEY "Software\Microsoft\Windows\CurrentVersion\Run"

!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

!macro customInstall
  ${IfNot} ${isUpdated}
    IfSilent +2
      MessageBox MB_OK|MB_ICONINFORMATION "Next, Windows will ask whether to let $\"Network Command Shell$\" make changes.$\r$\n$\r$\nChoose Yes so parents' phones on your home network can connect to Pocket Money Pal."
    DetailPrint "Adding the firewall rule for parents' phones…"
    ; Our rule is the one for this program: a hand-made rule of the same name is left alone.
    ClearErrors
    ExecShellWait "runas" "$SYSDIR\cmd.exe" '/s /c "netsh advfirewall firewall delete rule name="${PMP_RULE}" program="$INSTDIR\${APP_EXECUTABLE_FILENAME}" & netsh advfirewall firewall add rule name="${PMP_RULE}" dir=in action=allow protocol=TCP localport=${PMP_PORT} program="$INSTDIR\${APP_EXECUTABLE_FILENAME}" profile=any remoteip=localsubnet"' SW_HIDE
    ${If} ${Errors}
      DetailPrint "The firewall rule wasn't added."
      IfSilent +2
        MessageBox MB_OK|MB_ICONEXCLAMATION "The firewall rule wasn't added, so parents' phones may not be able to connect.$\r$\n$\r$\nTo add it later, run the installer again, or see $\"Connect parents' phones$\" in the installation guide."
    ${EndIf}
  ${EndIf}
!macroend

!macro customUnInstall
  ${IfNot} ${isUpdated}
    DetailPrint "Removing the firewall rule…"
    ExecShellWait "runas" "$SYSDIR\netsh.exe" 'advfirewall firewall delete rule name="${PMP_RULE}" program="$INSTDIR\${APP_EXECUTABLE_FILENAME}"' SW_HIDE
    ; Start at login (set by the app, main.ts) would otherwise point at a missing program.
    DeleteRegValue HKCU "${PMP_RUN_KEY}" "${PMP_RULE}"
  ${EndIf}
!macroend
