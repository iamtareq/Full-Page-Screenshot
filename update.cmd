@echo off
::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::
::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::
::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::
::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::
::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::
::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::
::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::
::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::
:: The block of colons above is deliberate - do not tidy it away.
:: update.cmd up to v1.2.x ran "git pull", which replaces this very file while cmd.exe is
:: still running it; cmd then carries on reading the NEW file at the same byte offset
:: (176 / 183). Every byte it can land on up there belongs to a ":::" label line, which cmd
:: skips, so an old update.cmd falls through to here instead of running half a command.
::
:: This script never runs from the extension folder itself: it copies itself to %TEMP%
:: and runs the copy, so the reset below can rewrite update.cmd (or anything else) safely.
if /i "%~1"=="--run" goto :run
REM The copy goes into a folder of its own. cmd seeds %RANDOM% from the clock in whole
REM seconds, so two updates started in the same second draw the same numbers; mkdir is
REM atomic, so only one of them can create a given folder and the other draws again.
set /a FPC_TRY=0
:newdir
set /a FPC_TRY+=1
set "FPC_DIR=%TEMP%\fpc-update-%RANDOM%%RANDOM%"
mkdir "%FPC_DIR%" 2>nul && goto :copyself
if %FPC_TRY% lss 20 goto :newdir
echo   Could not start the updater: the Windows temp folder is not writable. Nothing changed.
pause
exit /b 1
:copyself
set "FPC_RUN=%FPC_DIR%\update.cmd"
copy /y "%~f0" "%FPC_RUN%" >nul
if errorlevel 1 (
  echo   Could not start the updater: the Windows temp folder is not writable. Nothing changed.
  pause
  exit /b 1
)
"%FPC_RUN%" --run "%~dp0."

:run
REM The folder is opened BEFORE delayed expansion is switched on: with it on, cmd drops
REM every "!" from the name. No ( ) block here either, so a ")" in a name such as
REM "Program Files (x86)" cannot end one early.
set "FOLDER=%~2"
cd /d "%~2"
if not errorlevel 1 goto :infolder
echo   Could not open the extension folder "%FOLDER%". Nothing changed.
goto :end
:infolder
setlocal enabledelayedexpansion
title Full Page Capture  -  Update

echo ============================================
echo    Full Page Capture  -  Update
echo ============================================
echo.

where git >nul 2>&1
if errorlevel 1 (
  echo   Git was not found on this PC. Install Git for Windows ^(git-scm.com^),
  echo   then run this again.
  goto :end
)

REM The same steps as the popup's "Update now" (updater\fpc-update-host.ps1), so the two
REM never disagree: fetch, refuse local edits, then make this folder exactly what is on
REM GitHub. The old "git pull" merged instead - and a merge fails for good if the history
REM on GitHub is ever re-written, while this still said "click Reload".
set "BRANCH="
for /f "delims=" %%B in ('git rev-parse --abbrev-ref HEAD 2^>nul') do set "BRANCH=%%B"
if not defined BRANCH set "BRANCH=main"
if /i "!BRANCH!"=="HEAD" set "BRANCH=main"

echo   Checking GitHub for a newer version...
echo.
git fetch --prune --tags --force origin
if errorlevel 1 (
  echo.
  echo   Could not reach GitHub. Check your connection and try again. Nothing changed.
  goto :end
)

REM "HEAD:" is the root folder of that commit - comparing folders, not commit ids, tells a
REM real update apart from a history that was only re-written with the same files.
set "HERE=" & set "THERE="
for /f "delims=" %%H in ('git rev-parse HEAD: 2^>nul') do set "HERE=%%H"
for /f "delims=" %%H in ('git rev-parse origin/!BRANCH!: 2^>nul') do set "THERE=%%H"
if not defined THERE (
  echo.
  echo   GitHub has no "!BRANCH!" branch. Nothing changed.
  goto :end
)

REM Local edits are checked only now, after the fetch: an old update.cmd's "git pull" may
REM already have brought this folder up to date and kept an edit, and then the true answer
REM is "you have the newest version", not "nothing changed".
REM A previous update that was interrupted (antivirus / OneDrive / power loss) leaves this
REM journal file behind; its half-written files are our own debris, not the user's edits.
set "RECOVER="
if exist ".git\fpc-update-in-progress" set "RECOVER=1"
set "DIRTY="
if not defined RECOVER for /f "delims=" %%D in ('git status --porcelain --untracked-files^=no') do set "DIRTY=1"
if defined DIRTY goto :dirty

type nul > ".git\fpc-update-in-progress"
git reset --hard "origin/!BRANCH!" >nul
REM A locked file - antivirus, OneDrive, an open editor - fails the checkout. Those handles
REM are usually gone a moment later, so try once more. No brackets in these REM lines: one
REM inside a ( ) block would close it.
if errorlevel 1 (
  ping -n 3 127.0.0.1 >nul
  git reset --hard "origin/!BRANCH!" >nul
)
if errorlevel 1 (
  echo.
  echo   A program is holding one of the extension files open ^(antivirus, OneDrive sync,
  echo   or an open editor^). Close it, then run update.cmd again.
  goto :end
)
del ".git\fpc-update-in-progress" >nul 2>&1

set "VER="
for /f "delims=" %%V in ('powershell -NoProfile -Command "(Get-Content -Raw manifest.json | ConvertFrom-Json).version" 2^>nul') do set "VER=%%V"
REM A repaired interrupted update rewrote files even when the commit itself did not move.
if defined RECOVER set "HERE=recovered"
echo.
echo --------------------------------------------
if "!HERE!"=="!THERE!" (
  echo   You have the newest version ^(v!VER!^).
  echo.
  echo   If the popup footer still shows an older version, open  chrome://extensions
  echo   and click the round Reload arrow on "Full Page Capture".
) else (
  echo   Updated to v!VER!.
  echo.
  echo   Last step: open  chrome://extensions  and click the round Reload arrow
  echo   on "Full Page Capture"  ^(or just restart Chrome^).
)
echo --------------------------------------------
goto :end

:dirty
set "VER="
for /f "delims=" %%V in ('powershell -NoProfile -Command "(Get-Content -Raw manifest.json | ConvertFrom-Json).version" 2^>nul') do set "VER=%%V"
echo.
echo   You have local edits to the extension files:
echo.
git status --short --untracked-files=no
echo.
if "!HERE!"=="!THERE!" (
  echo   Apart from those edits you already have the newest version ^(v!VER!^), and the
  echo   edits were kept. If the popup footer still shows an older version, open
  echo   chrome://extensions  and click the round Reload arrow on "Full Page Capture".
) else (
  echo   Updating would throw them away, so this script stops here. Nothing changed.
  echo   Save or undo them first ^(undo everything: git checkout -- . ^).
)

:end
echo.
pause
endlocal
if /i not "%~1"=="--run" exit /b
REM The copy in %TEMP% removes itself, then its folder. "(goto)" ends this script first, so
REM cmd never goes looking for the next line of a file that is already gone; "rd" without /s
REM removes only an empty folder, so it can never take anything else with it.
(goto) 2>nul & del "%~f0" & rd "%~dp0."
