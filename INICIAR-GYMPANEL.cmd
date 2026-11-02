@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Gympanel - Vista local
echo.
echo GYMPANEL - Iniciar en esta computadora
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo Primero instala Node.js 24 desde https://nodejs.org/
  pause
  exit /b 1
)
node -e "process.exit(process.versions.node.split('.')[0] === '24' ? 0 : 1)"
if errorlevel 1 (
  echo Necesitas Node.js version 24. Version detectada:
  node --version
  pause
  exit /b 1
)
if not exist node_modules\express\package.json (
  echo Instalando los componentes. La primera vez requiere Internet...
  call npm ci --no-audit --no-fund
  if errorlevel 1 (
    echo No se pudo completar la instalacion. Copia el error para revisarlo.
    pause
    exit /b 1
  )
)
echo.
echo Cuando aparezca "Gympanel iniciado", abri http://localhost:3000
echo Deja esta ventana abierta mientras usas el panel.
echo Para detenerlo: Ctrl + C.
echo.
call npm start
if errorlevel 1 pause
