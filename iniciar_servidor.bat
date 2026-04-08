@echo off
echo ==========================================
echo    Diagnostico de Inicio - WA Sender
echo ==========================================
echo.
echo 1. Comprobando Node.js...
node -v
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] No se encontro Node.js. Por favor instalalo desde nodejs.org
    pause
    exit
)

echo 2. Comprobando carpetas...
if not exist "backend\node_modules" (
    echo [ERROR] No se encontro la carpeta node_modules en backend. 
    echo Intenta ejecutar 'npm install' dentro de la carpeta 'backend'.
    pause
    exit
)

echo 3. Iniciando servidor en puerto 3005...
cd backend
node server.js
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] El servidor se cerro inesperadamente.
    echo Revisa los mensajes de arriba.
)
pause
