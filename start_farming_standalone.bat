@echo off
chcp 65001 >nul
title 挂机车队 (独立模式)

echo ═══════════════════════════════════════════════════════
echo    挂机车队 - 独立模式 (无Web服务器)
echo    用于分布式部署在其他电脑上
echo ═══════════════════════════════════════════════════════
echo.

:: 检查 Node.js
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [错误] 未找到 Node.js，请先安装
    pause
    exit /b 1
)

:: 检查配置文件
if not exist "config\config_leaders.json" (
    echo [错误] 未找到 config\config_leaders.json
    pause
    exit /b 1
)

echo [提示] 独立模式：只运行挂机车队，不启动Web服务器
echo [提示] 展示车队的"结算"功能将不会影响此实例
echo.
echo 按任意键启动挂机车队...
pause >nul

node src/farming.js

echo.
echo 挂机车队已停止
pause

