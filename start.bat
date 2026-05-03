@echo off
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-ui.ps1"
set "CODE=%ERRORLEVEL%"
echo.
if "%CODE%"=="0" (
  echo Finished.
) else (
  echo Finished with error code %CODE%.
)
echo Output files are in: "%~dp0output"
echo You can scroll now. Press Q to close this window.
choice /c Q /n /m ""
exit /b %CODE%
