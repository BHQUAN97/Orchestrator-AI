@echo off
title AI Orchestrator — Setup
echo ==========================================
echo  AI Orchestrator — First Time Setup
echo ==========================================
echo.

cd /d E:\DEVELOP\ai-orchestrator

:: Check Docker
echo [1/5] Checking Docker...
docker info >nul 2>&1
if errorlevel 1 (
    echo ERROR: Docker not running! Start Docker Desktop first.
    pause
    exit /b 1
)
echo     Docker OK
echo.

:: Setup .env
echo [2/5] API Keys Setup
if not exist .env copy .env.example .env

echo.
echo Current keys in .env:
findstr /R "API_KEY=" .env | findstr /V "^#"
echo.

echo Opening .env for editing...
echo Fill in at least ONE key (OpenRouter recommended)
echo.
echo Links:
echo   OpenRouter: https://openrouter.ai/keys
echo   Gemini:     https://aistudio.google.com/apikey
echo   Kimi:       https://platform.moonshot.cn/console/api-keys
echo   DeepSeek:   https://platform.deepseek.com/api_keys
echo.
notepad .env

:: Pull images
echo.
echo [3/5] Pulling Docker images (may take a few minutes)...
docker compose pull

:: Start
echo.
echo [4/5] Starting services...
docker compose up -d

:: Verify
echo.
echo [5/5] Verifying...
timeout /t 15 /nobreak >nul

curl -s http://localhost:4001/health -H "Authorization: Bearer sk-master-change-me" >nul 2>&1
if errorlevel 1 (
    echo WARNING: LiteLLM not ready yet. Wait a moment and try start.bat
) else (
    echo LiteLLM: OK
)

curl -s http://localhost:9080 >nul 2>&1
if errorlevel 1 (
    echo WARNING: Dashboard not ready
) else (
    echo Dashboard: OK
)

echo.
echo ==========================================
echo  Setup complete!
echo ==========================================
echo.
echo  Next: Run start.bat to open dashboards
echo  Or:   http://localhost:9080
echo.
pause
