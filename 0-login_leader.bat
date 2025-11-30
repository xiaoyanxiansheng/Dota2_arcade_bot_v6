@echo off
chcp 65001 >nul
REM Leader 登录验证工具
REM 用法: 0-login_leader.bat [主号编号]
REM 例如: 0-login_leader.bat 1   (登录第1个主号)
REM 例如: 0-login_leader.bat 2   (登录第2个主号)

if "%1"=="" (
    echo ========================================
    echo        Leader 登录验证工具
    echo ========================================
    echo.
    set /p leader_num=请输入主号编号 ^(例如: 1 或 2^): 
) else (
    set leader_num=%1
)

echo.
echo 正在登录主号 %leader_num% ...
echo.

cd commands
node login_leader.js %leader_num%
pause

