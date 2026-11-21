@echo off
chcp 65001 >/dev/null
cd /d %~dp0
echo ============================================
echo   半全场实验室 · 一键更新
echo ============================================
node scripts\update.mjs
echo.
echo 按任意键关闭...
pause >/dev/null
