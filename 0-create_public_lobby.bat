@echo off
chcp 65001 >nul 2>&1
title 公开房间创建工具

echo.
echo ============================================================
echo    公开房间创建工具
echo    用途: 让指定大号创建一个无密码的公开房间
echo ============================================================
echo.

cd /d "%~dp0"

set /p LEADER_NUM="请输入要使用的大号编号 (默认 1): "

if "%LEADER_NUM%"=="" set LEADER_NUM=1

echo.
echo 正在使用大号 #%LEADER_NUM% 创建公开房间...
echo.

node commands/create_public_lobby.js %LEADER_NUM%

pause

