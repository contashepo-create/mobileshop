; ----------------------------------------------------------------------------
; Custom early steps for the MobileShopERP NSIS installer.
;
; electron-builder includes this file into the generated script (nsis.include)
; and exposes extension-point macros. The two used here:
;
;   customPageAfterChangeDir  — runs after the install-directory page. We add a
;                               page that asks where the shop wants business data.
;   customInstall             — runs after the files are copied. We write the
;                               chosen data folder to <INSTDIR>\db_settings.json.
;
; The database is USER DATA, so it must never live inside the app install
; directory: a per-machine install lands under Program Files, which a normal
; login cannot write to, and a per-user install directory is replaced wholesale
; on every update. The install dir is for the program; a separate data dir is
; for the shop.
;
; The app (src/main/database/connection.ts) reads this choice on first launch
; from <INSTDIR>\db_settings.json. Where no page value was captured (silent
; installs, upgrades), the app falls back to its own writable default.
; ----------------------------------------------------------------------------

!include "nsDialogs.nsh"
!include "LogicLib.nsh"

; The whole page+install block below is installer-only. The uninstaller build
; (electron-builder compiles a second script with BUILD_UNINSTALLER defined)
; never includes customPageAfterChangeDir/customInstall, so declaring these
; functions there would trip NSIS warning 6010 (unreferenced), which
; electron-builder escalates to an error. Guarding on BUILD_UNINSTALLER keeps
; them out of the uninstaller script entirely.
!ifndef BUILD_UNINSTALLER

var DbDataDir          ; the chosen data directory ('' = let the app default)
var DbDataDirHwnd      ; directory textbox control handle
var DbDataDirBrowse    ; Browse button control handle

; ---------------------------------------------------------------------------
; customPageAfterChangeDir — one page: "أين تحفظ بيانات المحل؟"
; An editable directory textbox with a Browse button.
; ---------------------------------------------------------------------------
!macro customPageAfterChangeDir
  Page custom DbDataDir_OnCreate DbDataDir_OnLeave
!macroend

Function DbDataDir_OnCreate
  ${If} $DbDataDir == ""
    ; Default: per-user roaming, which is writable on every install mode.
    StrCpy $DbDataDir "$APPDATA\MobileShopERP"
  ${EndIf}

  ${NSD_CreateLabel}  0 8u 100% 20u "مسار مجلد بيانات النظام (قاعدة البيانات):"
  Pop $0

  ${NSD_CreateDirRequest} 0 30u 72% 14u "$DbDataDir"
  Pop $DbDataDirHwnd
  ${NSD_OnChange} $DbDataDirHwnd DbDataDir_OnChange

  ${NSD_CreateBrowseButton} 74% 29u 24% 16u "استعراض…"
  Pop $DbDataDirBrowse
  ${NSD_OnClick} $DbDataDirBrowse DbDataDir_OnBrowse

  ${NSD_CreateLabel} 0 46u 100% 40u "تُحفظ هنا قواعد البيانات (العملاء، الفواتير، الأرصدة، المستودع). لن تُحذف عند تحديث البرنامج أو إعادة تثبيته."
  Pop $0
FunctionEnd

; Remembers the text the user typed, so it survives a browse round-trip.
Function DbDataDir_OnChange
  ${NSD_GetText} $DbDataDirHwnd $DbDataDir
FunctionEnd

Function DbDataDir_OnBrowse
  Push $0
  nsDialogs::SelectFolderDialog "اختر مجلد بيانات النظام" "$DbDataDir"
  Pop $0
  ${If} $0 != "error"
    StrCpy $DbDataDir "$0"
    ; Update both the stored value and the text on screen.
    ${NSD_SetText} $DbDataDirHwnd "$0"
  ${EndIf}
  Pop $0
FunctionEnd

Function DbDataDir_OnLeave
  ${NSD_GetText} $DbDataDirHwnd $DbDataDir
  ${If} $DbDataDir == ""
    MessageBox MB_ICONINFORMATION|MB_TOPMOST "يرجى اختيار مجلد بيانات النظام." IDOK
    Abort
  ${EndIf}
FunctionEnd

; ---------------------------------------------------------------------------
; customInstall — write the chosen data folder for the app's first launch.
; connection.ts reads this exact file from <INSTDIR>\db_settings.json and
; decodes it as UTF-16LE (FileWriteUTF16LE) — the installer is a Unicode NSIS
; build, and the app's reader is BOM-aware to accept either encoding.
;
; BACKSLASH ESCAPING: JSON requires backslashes in string values to be
; doubled (\\). The NSIS FileWriteUTF16LE writes the string literally, so
; we must replace every \ with \\ before embedding the path in the JSON.
; Without this, the app sees "Bad escaped character" and silently ignores
; the configured path.
; ---------------------------------------------------------------------------
!macro customInstall
  ${If} $DbDataDir != ""
    CreateDirectory "$DbDataDir"
    ; Escape backslashes for valid JSON
    StrCpy $1 "$DbDataDir"
    StrCpy $2 ""
    StrCpy $3 0
    loop_start:
      StrCpy $4 $1 1 $3
      ${If} $4 == ""
        Goto loop_end
      ${EndIf}
      ${If} $4 == "\"
        StrCpy $2 "$2\\"
      ${Else}
        StrCpy $2 "$2$4"
      ${EndIf}
      IntOp $3 $3 + 1
      Goto loop_start
    loop_end:
    ClearErrors
    FileOpen $0 "$INSTDIR\db_settings.json" w
    FileWriteUTF16LE $0 '{"dbPath":"$2\\mobile_shop.db"}'
    FileClose $0
  ${EndIf}
!macroend

!endif ; !ifndef BUILD_UNINSTALLER