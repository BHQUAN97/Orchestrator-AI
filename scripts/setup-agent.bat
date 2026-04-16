@echo off
echo === OrcAI Setup ===
echo.

REM Check Node.js
node --version >nul 2>&1
if errorlevel 1 (
    echo ERROR: Node.js not found. Install from https://nodejs.org
    exit /b 1
)

REM Install dependencies
echo Installing dependencies...
call npm install

REM Create global link
echo Creating global command 'orcai'...
call npm link

REM Create config directory
if not exist "%USERPROFILE%\.orcai" mkdir "%USERPROFILE%\.orcai"

REM Check .env
if not exist .env (
    echo.
    echo WARNING: .env file not found. Copy .env.example and fill in your API keys.
    copy .env.example .env 2>nul
)

echo.
echo === Setup Complete ===
echo Run: orcai --help
echo Run: orcai -i  (interactive mode)
pause
