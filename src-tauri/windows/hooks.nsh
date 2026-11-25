; Hook dell'installer NSIS (bundle.windows.nsis.installerHooks in tauri.conf.json).
;
; Fino alla 1.3.0 l'app si chiamava "Xtream Player". Per l'installer NSIS il nome è il prodotto:
; cartella d'installazione, voce in "App installate" e collegamenti dipendono da lì, quindi il
; primo aggiornamento a "Lime Player" metterebbe una seconda copia accanto a quella vecchia.
; Dopo l'installazione si disinstalla in silenzio la copia "Xtream Player". Playlist, password e
; cache restano: l'identificatore (com.xtreamplayer.desktop) non cambia e il disinstallatore
; silenzioso non cancella le cartelle dei dati. Negli aggiornamenti automatici l'installer non
; crea collegamenti, quindi si rifanno col nuovo nome quelli che c'erano.

!define OLD_PRODUCTNAME "Xtream Player"
!define OLD_MAINBINARY "xtream-player.exe"
!define OLD_UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${OLD_PRODUCTNAME}"
!define OLD_MANUKEY "Software\xtreamplayer"
!define OLD_MANUPRODUCTKEY "${OLD_MANUKEY}\${OLD_PRODUCTNAME}"

!macro NSIS_HOOK_POSTINSTALL
  ; cartella della vecchia installazione, salvata dall'installer di Xtream Player
  ReadRegStr $R5 SHCTX "${OLD_MANUPRODUCTKEY}" ""
  ${If} $R5 != ""
    DetailPrint "Rimozione di ${OLD_PRODUCTNAME} da $R5"

    ${If} $UpdateMode = 1
      ${If} ${FileExists} "$SMPROGRAMS\${OLD_PRODUCTNAME}.lnk"
      ${AndIfNot} ${FileExists} "$SMPROGRAMS\${PRODUCTNAME}.lnk"
        CreateShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
        !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\${PRODUCTNAME}.lnk"
      ${EndIf}
      ${If} ${FileExists} "$DESKTOP\${OLD_PRODUCTNAME}.lnk"
      ${AndIfNot} ${FileExists} "$DESKTOP\${PRODUCTNAME}.lnk"
        CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
        !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"
      ${EndIf}
    ${EndIf}

    ${If} $R5 != $INSTDIR
    ${AndIf} ${FileExists} "$R5\uninstall.exe"
      ; /S: nessuna domanda, dati conservati; _?= fa aspettare la fine (niente copia temporanea)
      ExecWait '"$R5\uninstall.exe" /S _?=$R5'
      Delete "$R5\uninstall.exe"
      RMDir "$R5"
    ${Else}
      ; stessa cartella o disinstallatore mancante: si tolgono solo i resti col vecchio nome
      ${If} $R5 == $INSTDIR
        Delete "$INSTDIR\${OLD_MAINBINARY}"
      ${EndIf}
      Delete "$SMPROGRAMS\${OLD_PRODUCTNAME}.lnk"
      Delete "$DESKTOP\${OLD_PRODUCTNAME}.lnk"
      DeleteRegKey SHCTX "${OLD_UNINSTKEY}"
    ${EndIf}

    DeleteRegKey SHCTX "${OLD_MANUPRODUCTKEY}"
    DeleteRegKey /ifempty SHCTX "${OLD_MANUKEY}"
  ${EndIf}
!macroend
