@echo off
rem Vantage Productivity addition (2026): compatible CLI on this fork's runtime/profile.
setlocal
if exist "%~dp0..\..\Vantage Productivity.exe" goto packaged
if exist "%~dp0..\dist\vantage.cjs" goto source
>&2 echo Vantage Productivity CLI is not built. Build the CLI first, or use the launcher shipped with the app.
exit /b 1

:packaged
set "ELECTRON_RUN_AS_NODE=1"
set "VANTAGE_APP_BIN=%~dp0..\..\Vantage Productivity.exe"
if not defined VANTAGE_USER_DATA set "VANTAGE_USER_DATA=%APPDATA%\VantageProductivity"
set "VANTAGE_RECOVERY_ROOT=%VANTAGE_USER_DATA%\recovery"
set "VANTAGE_RECOVERY_EXCLUDE_ROOT=%VANTAGE_USER_DATA%"
"%~dp0..\..\Vantage Productivity.exe" "%~dp0vantage.cjs" %*
exit /b %errorlevel%

:source
set "ELECTRON_RUN_AS_NODE="
node "%~dp0..\dist\vantage.cjs" %*
exit /b %errorlevel%
