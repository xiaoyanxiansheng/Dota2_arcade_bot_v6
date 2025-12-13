@echo off
chcp 65001 >nul
title 挂机车队

:: 列出可用配置
echo [可用配置]
for /d %%i in (config\farm\config_*) do echo   %%~ni
echo.

:: 输入配置编号
set /p num="输入编号 (000/001/002...): "

:: 启动
node src/farming.js --config=config_%num%
pause
