; Custom install step. build/installer.nsh is electron-builder's default nsis.include.
;
; An update keeps the shortcuts (--keep-shortcuts) and moves the old installation into the
; uninstaller's temporary folder (%TEMP%\nsXXXX.tmp\old-install) before it extracts the new files.
; Opening the Start menu or desktop shortcut in that gap makes Windows link tracking rewrite the
; shortcut to that temporary path. The installer's own "run after update" opens the Start menu
; shortcut, so the new version would never start, and every later launch would reach the temporary
; copy that is being deleted. Point the shortcuts that still exist back at the installed executable.
; A shortcut the user deleted is not recreated.
!macro customInstall
  SetOutPath $INSTDIR
  ${if} ${FileExists} "$newStartMenuLink"
    CreateShortCut "$newStartMenuLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
    ClearErrors
    WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
  ${endIf}
  ${if} ${FileExists} "$newDesktopLink"
    CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
    ClearErrors
    WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
  ${endIf}
!macroend
