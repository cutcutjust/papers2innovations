!macro NSIS_HOOK_POSTINSTALL
  !if "${STARTMENUFOLDER}" != ""
    CreateDirectory "$SMPROGRAMS\$AppStartMenuFolder"
    CreateShortcut "$SMPROGRAMS\$AppStartMenuFolder\Uninstall ${PRODUCTNAME}.lnk" "$INSTDIR\uninstall.exe"
  !else
    CreateShortcut "$SMPROGRAMS\Uninstall ${PRODUCTNAME}.lnk" "$INSTDIR\uninstall.exe"
  !endif
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !if "${STARTMENUFOLDER}" != ""
    Delete "$SMPROGRAMS\$AppStartMenuFolder\Uninstall ${PRODUCTNAME}.lnk"
  !else
    Delete "$SMPROGRAMS\Uninstall ${PRODUCTNAME}.lnk"
  !endif
!macroend
