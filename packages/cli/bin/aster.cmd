@echo off
rem Aster Office addition (2026): compatible CLI on this fork's runtime/profile.
setlocal
if exist "%~dp0..\..\Aster Office.exe" goto packaged
if exist "%~dp0..\dist\genoffice.cjs" goto source
>&2 echo Aster Office CLI is not built. Build the CLI first, or use the launcher shipped with the app.
exit /b 1

:packaged
set "ELECTRON_RUN_AS_NODE=1"
set "GENOFFICE_APP_BIN=%~dp0..\..\Aster Office.exe"
if defined ASTER_USER_DATA (
  set "GENOFFICE_USER_DATA=%ASTER_USER_DATA%"
) else (
  set "GENOFFICE_USER_DATA=%APPDATA%\AsterOffice"
)
set "ASTER_RECOVERY_ROOT=%GENOFFICE_USER_DATA%\recovery"
set "ASTER_RECOVERY_EXCLUDE_ROOT=%GENOFFICE_USER_DATA%"
"%~dp0..\..\Aster Office.exe" "%~dp0genoffice.cjs" %*
exit /b %errorlevel%

:source
set "ELECTRON_RUN_AS_NODE="
if defined ASTER_USER_DATA set "GENOFFICE_USER_DATA=%ASTER_USER_DATA%"
node "%~dp0..\dist\genoffice.cjs" %*
exit /b %errorlevel%
