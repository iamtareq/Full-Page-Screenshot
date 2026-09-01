@echo off
rem Chrome native-messaging launcher — hands stdin/stdout to the PowerShell host.
rem Must not print anything itself (that would corrupt the binary protocol).
powershell.exe -ExecutionPolicy Bypass -NoProfile -NonInteractive -File "%~dp0fpc-update-host.ps1"
