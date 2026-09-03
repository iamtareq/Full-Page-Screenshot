@echo off
rem Chrome native-messaging launcher - hands stdin/stdout to the PowerShell host.
rem Must not print anything itself (that would corrupt the binary protocol).
rem -NoLogo: without it a failed script launch can emit the PS banner on stdout,
rem which Chrome would read as a garbage 4-byte length prefix.
powershell.exe -NoLogo -ExecutionPolicy Bypass -NoProfile -NonInteractive -File "%~dp0fpc-update-host.ps1"
