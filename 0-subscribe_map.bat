@echo off
title Dota 2 Bot - 批量订阅地图
cd /d "%~dp0"
echo 正在启动批量订阅工具...
node commands\subscribe_map.js
pause

