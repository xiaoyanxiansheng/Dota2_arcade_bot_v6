@echo off
chcp 65001 >nul
cd /d "%~dp0"

:loop
echo ═══════════════════════════════════════════════════════════════
echo   Dota2 展示车队启动（兜底：异常退出后60秒重启）
echo ═══════════════════════════════════════════════════════════════
echo.
echo 配置文件: config/config_showcase.json
echo.

node src/showcase.js --config=config/config_showcase.json

echo.
echo [%date% %time%] showcase exited, code=%errorlevel%
echo 60秒后重启...
timeout /t 60 /nobreak >nul
goto loop

