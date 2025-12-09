@echo off
chcp 65001 >nul
echo ═══════════════════════════════════════════════════════════════
echo   Dota2 展示车队启动
echo ═══════════════════════════════════════════════════════════════
echo.

cd /d "%~dp0"

echo 配置文件: config/config_showcase.json
echo.

node src/showcase.js --config=config/config_showcase.json

pause

