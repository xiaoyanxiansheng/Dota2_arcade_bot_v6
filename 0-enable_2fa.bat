@echo off
chcp 65001 >nul
echo.
echo ════════════════════════════════════════════════════
echo   Steam 手机令牌绑定工具
echo ════════════════════════════════════════════════════
echo.
echo 使用方法: 
echo   node commands/enable_2fa.js 用户名 密码
echo.
echo 示例:
echo   node commands/enable_2fa.js myaccount mypassword
echo.
echo ════════════════════════════════════════════════════
echo.

set /p username=请输入用户名: 
set /p password=请输入密码: 

node commands/enable_2fa.js %username% %password%

pause

