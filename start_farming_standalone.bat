@echo off
chcp 65001 >nul
title 挂机车队 (独立模式)

echo ═══════════════════════════════════════════════════════
echo    挂机车队 - 独立模式 (无Web服务器)
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

:: 列出可用配置
echo [可用配置]
for /d %%i in (config\farm\config_*) do (
    echo   %%~ni
)
echo.

:: 输入配置编号
set /p configNum="请输入配置编号 (如 000、001，默认000): "

:: 默认值
if "%configNum%"=="" set configNum=000

:: 补齐3位
set configNum=00%configNum%
set configNum=%configNum:~-3%

:: 检查配置是否存在
set configName=config_%configNum%
if not exist "config\farm\%configName%\followers.txt" (
    echo [错误] 配置不存在: %configName%
    pause
    exit /b 1
)

echo.
echo 启动配置: %configName%
echo.

:: 启动，传递配置名称
node src/farming.js --config=%configName%

echo.
echo 挂机车队已停止
pause
