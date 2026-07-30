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
echo   OPPO PHOTOBOOTH - Starting Local Server...
echo  =====================================================
echo.

:: Start server in new window
start "OPPO Server" cmd /k "color 0A && title OPPO Server && node server/index.js"

:: Wait 2 seconds for server boot
timeout /t 2 /nobreak >nul

:: Detect local IP
for /f "tokens=*" %%i in ('node -e "const os=require('os');const ifaces=os.networkInterfaces();let ip='localhost';for(const n of Object.keys(ifaces)){for(const i of ifaces[n]){if(i.family==='IPv4'&&!i.internal&&i.address.startsWith('10.')){ip=i.address;break;}}}console.log(ip);"') do set LOCAL_IP=%%i

echo.
echo  =====================================================
echo   LOCAL NETWORK LINKS (10.10 IP):
echo  =====================================================
echo.
echo   [1] Display Screen (PC):
echo       https://%LOCAL_IP%:3000/display
echo.
echo   [2] Mobile Capture (Phone):
echo       https://%LOCAL_IP%:3000/capture
echo.
echo  =====================================================
echo   IMPORTANT:
echo   - Open both links on the respective devices.
echo   - If you see a security warning on phone or PC,
echo     tap "Advanced" then "Proceed".
echo   - Allow Camera permission on phone!
echo  =====================================================
echo.

:: Open Display screen in default browser using the 10.10 IP
start "" "https://%LOCAL_IP%:3000/display"

pause

