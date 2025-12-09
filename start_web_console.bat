@echo off
chcp 65001 >nul
echo ===============================================================
echo   Dota2 Bot Web Console
echo ===============================================================
echo.
echo   Starting Web Server...
echo   URL: http://localhost:3000
echo.

cd /d "%~dp0"
node web/server.js

pause

