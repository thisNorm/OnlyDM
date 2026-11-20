@echo off
setlocal
if not defined SystemRoot set "SystemRoot=%windir%"
if not defined SystemRoot set "SystemRoot=C:\Windows"
set "PSModulePath=%SystemRoot%\System32\WindowsPowerShell\v1.0\Modules"
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0OnlyDM.Command.ps1" %*
exit /b %errorlevel%
