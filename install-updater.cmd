@echo off
rem ============================================================
rem  Full Page Capture - one-time updater setup (per PC)
rem  Registers a tiny local "native messaging host" so the
rem  extension's "Update now" button can update this folder.
rem ============================================================
setlocal
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
set "HOSTBAT=%ROOT%\updater\fpc-update-host.bat"
set "MANIFEST=%ROOT%\updater\com.fpc.updater.json"
set "WRITER=%ROOT%\updater\write-host-manifest.ps1"
set "EXTID=eogbgpkhkkaaclemedgcdoaihnjnhnpb"

if not exist "%HOSTBAT%" (
  echo ERROR: %HOSTBAT% not found. Run this from inside the extension folder.
  pause
  exit /b 1
)
if not exist "%WRITER%" (
  echo ERROR: %WRITER% not found. Run this from inside the extension folder.
  pause
  exit /b 1
)

rem Write the native-host manifest (pure-ASCII JSON, so accented paths survive).
powershell -NoProfile -ExecutionPolicy Bypass -File "%WRITER%" -HostBat "%HOSTBAT%" -OutFile "%MANIFEST%" -ExtensionId "%EXTID%"
if errorlevel 1 goto :failed
if not exist "%MANIFEST%" goto :failed

rem Point Chrome (and Edge) at that manifest.
reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.fpc.updater" /ve /t REG_SZ /d "%MANIFEST%" /f >nul
if errorlevel 1 goto :failed
reg add "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.fpc.updater" /ve /t REG_SZ /d "%MANIFEST%" /f >nul

echo.
echo ============================================================
echo   Done! The "Update now" button in the popup now works.
echo   If Chrome/Edge is open, fully quit and reopen it once.
echo ============================================================
echo.
pause
exit /b 0

:failed
echo.
echo ============================================================
echo   SETUP FAILED - the updater was NOT registered.
echo   Nothing was half-installed; you can just run this again.
echo   If it keeps failing, use update.cmd to update instead.
echo ============================================================
echo.
pause
exit /b 1
