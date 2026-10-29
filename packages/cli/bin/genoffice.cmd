@echo off
rem Aster Office modification (2026): compatibility alias for the independent Aster runtime.
setlocal
call "%~dp0aster.cmd" %*
exit /b %errorlevel%
