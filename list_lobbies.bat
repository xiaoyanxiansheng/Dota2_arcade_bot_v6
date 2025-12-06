@echo off
cd /d "%~dp0"
chcp 65001 >nul 2>&1

echo ============================================
echo   Dota 2 游廊房间查询工具
echo ============================================
echo.
echo 用法:
echo   list_lobbies.bat          - 查询所有游廊游戏的房间
echo   list_lobbies.bat all      - 同上
echo   list_lobbies.bat [游戏ID] - 只查询指定游戏的房间
echo.
echo ============================================
echo.

node commands/list_lobbies.js %*

echo.
echo 按任意键退出...
pause >nul
