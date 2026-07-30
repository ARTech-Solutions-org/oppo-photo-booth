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
echo   OPPO PHOTOBOOTH - Starting HTTPS Server...
echo  =====================================================
echo.

:: Start server in new window
start "OPPO Server" cmd /k "color 0A && title OPPO Server && node server/index.js"

:: Wait 3 seconds for server boot
timeout /t 3 /nobreak >nul

:: Detect local IP
for /f "tokens=*" %%i in ('node -e "const os=require('os');const ifaces=os.networkInterfaces();let ip='localhost';for(const n of Object.keys(ifaces)){for(const i of ifaces[n]){if(i.family==='IPv4'&&!i.internal&&i.address.startsWith('10.')){ip=i.address;break;}}}console.log(ip);"') do set LOCAL_IP=%%i

:: Open Display screen and Mobile Capture in default browser
start "" "https://localhost:3000/display"
start "" "https://%LOCAL_IP%:3000/capture"

echo.
echo  =====================================================
echo   HTTPS LINKS (Open on each device):
echo  =====================================================
echo.
echo   Display Screen  ^>  https://localhost:3000/display
echo   Mobile Capture  ^>  https://%LOCAL_IP%:3000/capture
echo.
echo  =====================================================
echo   IMPORTANT ON MOBILE PHONE:
echo  =====================================================
echo   1. Open the Mobile Capture link on your phone
echo   2. You will see a security warning (self-signed cert)
echo   3. Tap "Advanced" then "Proceed" / "Continue to site"
echo   4. Allow Camera permission when prompted!
echo  =====================================================
echo.
pause
