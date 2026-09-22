@echo off
rem Bullba Hits - script installer. Nothing of ours runs: Windows' own powershell.exe reads install.ps1,
rem so application control has no unsigned program of ours to judge. Optional argument: the game folder.
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
set "BULLBA_RC=%ERRORLEVEL%"
echo.
pause
exit /b %BULLBA_RC%
