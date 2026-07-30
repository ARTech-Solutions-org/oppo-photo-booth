@echo off
title OPPO Photobooth Launcher
color 0A
cls

cd /d "%~dp0"

:: Kill old node process if running
taskkill /f /im node.exe >nul 2>&1
timeout /t 1 /nobreak >nul

echo.
echo  =====================================================
echo   OPPO PHOTOBOOTH - Starting Server...
echo  =====================================================
echo.

:: Start server in new window
start "OPPO Server" cmd /k "color 0A && title OPPO Server && node server/index.js"

:: Wait 2 seconds for server boot
timeout /t 2 /nobreak >nul

:: Detect local IP
for /f "tokens=*" %%i in ('node -e "const os=require('os');const ifaces=os.networkInterfaces();let ip='localhost';for(const n of Object.keys(ifaces)){for(const i of ifaces[n]){if(i.family==='IPv4'&&!i.internal&&i.address.startsWith('10.')){ip=i.address;break;}}}console.log(ip);"') do set LOCAL_IP=%%i

:: Generate a simple test room ID
set ROOM_ID=oppo_test_01

echo.
echo  =====================================================
echo   LINKS FOR TESTING (ROOM: %ROOM_ID%)
echo  =====================================================
echo.
echo   [1] Display Screen (Open on PC):
echo       https://localhost:3443/display?room=%ROOM_ID%
echo.
echo   [2] Mobile Capture (Open on Phone):
echo       https://%LOCAL_IP%:3443/capture?room=%ROOM_ID%
echo.
echo  =====================================================
echo   IMPORTANT:
echo   - If the browser shows a security warning, click
echo     "Advanced" -^> "Proceed to site".
echo   - Allow Camera permissions on the phone!
echo  =====================================================
echo.

:: Open Display screen in default browser
start "" "https://localhost:3443/display?room=%ROOM_ID%"

pause
