@echo off
rem ============================================================
rem  Full Page Capture - one-time updater setup (per PC)
rem  Registers a tiny local "native messaging host" so the
rem  extension's "Update now" button can run git pull + reload.
rem ============================================================
setlocal
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
set "HOSTBAT=%ROOT%\updater\fpc-update-host.bat"
set "MANIFEST=%ROOT%\updater\com.fpc.updater.json"

if not exist "%HOSTBAT%" (
  echo ERROR: %HOSTBAT% not found. Run this from inside the extension folder.
  pause
  exit /b 1
)

rem Write the native-host manifest as valid JSON (PowerShell handles quoting/escaping).
powershell -NoProfile -ExecutionPolicy Bypass -Command "$m=[ordered]@{name='com.fpc.updater';description='Full Page Capture updater';path=$env:HOSTBAT;type='stdio';allowed_origins=@('chrome-extension://eogbgpkhkkaaclemedgcdoaihnjnhnpb/')}; ($m|ConvertTo-Json -Depth 4) | Set-Content -Encoding ASCII -Path $env:MANIFEST"

rem Point Chrome (and Edge) at that manifest.
reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.fpc.updater" /ve /t REG_SZ /d "%MANIFEST%" /f >nul
reg add "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.fpc.updater" /ve /t REG_SZ /d "%MANIFEST%" /f >nul

echo.
echo ============================================================
echo   Done! The "Update now" button in the popup now works.
echo   If Chrome/Edge is open, fully quit and reopen it once.
echo ============================================================
echo.
pause
