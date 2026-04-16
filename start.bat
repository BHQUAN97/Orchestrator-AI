@echo off
title AI Orchestrator
echo ==========================================
echo  AI Orchestrator — Start All Services
echo ==========================================
echo.

cd /d E:\DEVELOP\ai-orchestrator

echo [1/3] Starting Docker services...
docker compose up -d litellm dashboard trust-graph hermes
echo.

echo [2/3] Waiting for LiteLLM...
:wait_loop
timeout /t 3 /nobreak >nul
curl -s http://localhost:4001/health -H "Authorization: Bearer sk-master-change-me" >nul 2>&1
if errorlevel 1 (
    echo     Still starting...
    goto wait_loop
)
echo     LiteLLM ready!
echo.

echo [3/3] Opening dashboards...
start http://localhost:9080
start http://localhost:4001/ui
echo.

echo ==========================================
echo  All services running!
echo ==========================================
echo.
echo  Dashboard:  http://localhost:9080
echo  LiteLLM:    http://localhost:4001/ui  (admin/admin)
echo  Hermes:     http://localhost:3000
echo.
echo  Press any key to open setup page...
pause >nul
start http://localhost:9080#tab-settings
