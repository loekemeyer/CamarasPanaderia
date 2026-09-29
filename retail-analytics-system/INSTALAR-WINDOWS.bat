@echo off
chcp 65001 >nul
title Instalador - Analitica de camaras
echo.
echo  Instalando el sistema de analitica de camaras...
echo  (Windows puede pedir permiso de administrador)
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\instalar.ps1"
echo.
pause
