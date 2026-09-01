@echo off
cd /d "%~dp0"
echo ============================================
echo    Full Page Capture  -  Update
echo ============================================
echo.
git pull
echo.
echo --------------------------------------------
echo If it says "Already up to date" you already have the latest.
echo Otherwise: open  chrome://extensions  and click  Reload
echo on "Full Page Capture"  (or just restart Chrome).
echo --------------------------------------------
echo.
pause
