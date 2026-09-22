@echo off
cd /d "%~dp0"
setlocal enabledelayedexpansion
title Full Page Capture  -  go back to an earlier version

echo ============================================
echo    Full Page Capture  -  Rollback
echo ============================================
echo.
echo   Use this if a new version misbehaves and you need the previous one back
echo   while it is being fixed.
echo.

where git >nul 2>&1
if errorlevel 1 (
  echo   Git was not found on this PC. Install Git for Windows ^(git-scm.com^),
  echo   then run this again.
  echo.
  pause & exit /b
)

REM Local edits would be destroyed by the reset below: refuse instead.
for /f "delims=" %%D in ('git status --porcelain --untracked-files^=no') do set "DIRTY=1"
if defined DIRTY (
  echo   You have local edits to the extension files:
  echo.
  git status --short
  echo.
  echo   Rolling back would throw them away, so this script stops here.
  echo   Save or undo them first ^(undo everything: git checkout -- . ^).
  echo.
  pause & exit /b
)

for /f "delims=" %%V in ('git describe --tags --exact-match 2^>nul') do set "NOW=%%V"
if not defined NOW for /f "delims=" %%V in ('git rev-parse --short HEAD') do set "NOW=%%V (not a released version)"

echo   Fetching the list of released versions...
git fetch --tags -f --prune origin >nul 2>&1

echo.
echo   You are on:  !NOW!
echo.
echo   Released versions, oldest first:
echo.
for /f "delims=" %%T in ('git tag --sort^=version:refname') do echo       %%T
echo       latest        ^<- the newest version on GitHub
echo.
set "PICK="
set /p PICK="   Type a version (e.g. v1.1.7), or 'latest', or press Enter to cancel: "

if "!PICK!"=="" echo   Cancelled - nothing changed. & pause & exit /b

if /i "!PICK!"=="latest" (
  echo.
  echo   Returning to the newest version...
  git reset --hard origin/main
  if errorlevel 1 echo   Could not reach GitHub. Check your connection and try again. & pause & exit /b
  goto :done
)

REM No "^{commit}" suffix here: ^ is cmd's escape character, so it would reach git as
REM "v1.1.7{commit}" and every version would be rejected as unknown. The bare tag name
REM verifies just as well, and "reset --hard <tag>" resolves an annotated tag itself.
git rev-parse --verify "!PICK!" >nul 2>&1
if errorlevel 1 (
  echo.
  echo   "!PICK!" is not one of the versions listed above. Nothing changed.
  echo.
  pause & exit /b
)

echo.
echo   Going back to !PICK! ...
REM reset --hard on the branch, NOT "checkout <tag>". A detached HEAD would break the
REM one-click updater: its host reads the branch with rev-parse --abbrev-ref HEAD, which
REM returns "HEAD" when detached, and it would then reset to origin/HEAD - silently
REM pulling you forward again with no warning. Staying on main keeps that honest.
git checkout main >nul 2>&1
git reset --hard "!PICK!"
if errorlevel 1 echo   Rollback failed - nothing changed. & pause & exit /b

:done
echo.
echo --------------------------------------------
for /f "delims=" %%V in ('git describe --tags --exact-match 2^>nul') do set "NEW=%%V"
echo   You are now on: !NEW!
echo.
echo   Last step: open  chrome://extensions  and click the round Reload arrow
echo   on "Full Page Capture". The files on disk have changed, but Chrome keeps
echo   running the old ones until you reload.
echo.
echo   Check it worked: open the popup - the version in the footer should read !NEW!
echo.
echo   TO COME FORWARD AGAIN, use either of these - both work from any version:
echo       - click "Update now" in the popup, or
echo       - double-click  update.cmd
echo   then Reload at chrome://extensions again.
echo.
echo   (This script only exists from v1.2.0 onward, so after rolling back to an
echo    older version it is not on disk any more - which is why the two above are
echo    the ones to remember.)
echo --------------------------------------------
echo.
pause
