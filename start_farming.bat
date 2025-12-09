@echo off
chcp 65001 >nul
echo ═══════════════════════════════════════════════════════════════
echo   Dota2 挂机车队启动
echo ═══════════════════════════════════════════════════════════════
echo.

cd /d "%~dp0"

REM 可以通过参数指定配置文件
if "%1"=="" (
    set CONFIG=config/config_farming.json
) else (
    set CONFIG=%1
)

echo 配置文件: %CONFIG%
echo.

node src/farming.js --config=%CONFIG%

pause

