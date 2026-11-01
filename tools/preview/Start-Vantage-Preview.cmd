@echo off
setlocal
set "ELECTRON_RUN_AS_NODE="
set "VANTAGE_USER_DATA=%LOCALAPPDATA%\VantageProductivityBrandPreview\0.15.0-brand.1"
set "VANTAGE_AUTH_DIR=%VANTAGE_USER_DATA%\auth"
set "VANTAGE_MAIL_PROFILE=%VANTAGE_USER_DATA%\mail"
set "VANTAGE_ENGINE_TEMP_DIR=%VANTAGE_USER_DATA%\engine-temp"
if not exist "%VANTAGE_USER_DATA%" mkdir "%VANTAGE_USER_DATA%"
if not exist "%VANTAGE_ENGINE_TEMP_DIR%" mkdir "%VANTAGE_ENGINE_TEMP_DIR%"
start "" "%~dp0Vantage Productivity.exe" %*
