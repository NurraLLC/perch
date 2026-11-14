@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-helper.ps1" %*
pause
