@echo off
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-ui.ps1"
set "CODE=%ERRORLEVEL%"
echo.
if "%CODE%"=="0" (
  echo Zakonczono.
) else (
  echo Zakonczono z kodem bledu %CODE%.
)
echo Pliki wynikowe sa w: "%~dp0output"
echo Mozesz przewinac wyniki. Nacisnij Q, aby zamknac okno.
choice /c Q /n /m ""
exit /b %CODE%
