@echo off
title OPPO Firewall Setup
echo.
echo ====================================================
echo  Opening ports 3000 and 3443 for OPPO Photobooth
echo ====================================================
echo.

netsh advfirewall firewall delete rule name="OPPO HTTP 3000" >nul 2>&1
netsh advfirewall firewall delete rule name="OPPO HTTPS 3443" >nul 2>&1

netsh advfirewall firewall add rule name="OPPO HTTP 3000" dir=in action=allow protocol=TCP localport=3000
netsh advfirewall firewall add rule name="OPPO HTTPS 3443" dir=in action=allow protocol=TCP localport=3443

echo.
if %ERRORLEVEL% EQU 0 (
    echo  SUCCESS! Ports are now open.
) else (
    echo  ERROR! Could not open ports. Try right-clicking and "Run as administrator".
)
echo.
pause
