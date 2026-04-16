@echo off
title AI Orchestrator v2.1
echo ==========================================
echo  AI Orchestrator v2.1 — Hermes + Orchestrator
echo  Port range: 5000-5004
echo ==========================================
echo.

cd /d E:\DEVELOP\ai-orchestrator

echo [1/4] Starting Docker services...
docker compose up -d
echo.

echo [2/4] Waiting for LiteLLM (:5002)...
:wait_litellm
timeout /t 3 /nobreak >nul
curl -s http://localhost:5002/health -H "Authorization: Bearer sk-master-change-me" >nul 2>&1
if errorlevel 1 (
    echo     LiteLLM starting...
    goto wait_litellm
)
echo     LiteLLM ready!
echo.

echo [3/4] Waiting for Orchestrator API (:5003)...
:wait_orch
timeout /t 2 /nobreak >nul
curl -s http://localhost:5003/health >nul 2>&1
if errorlevel 1 (
    echo     Orchestrator starting...
    goto wait_orch
)
echo     Orchestrator ready!
echo.

echo [4/4] All services running!
echo.
echo ==========================================
echo  SERVICES:
echo  Hermes Brain:     http://localhost:5000
echo  Hermes WebUI:     http://localhost:5001
echo  LiteLLM Gateway:  http://localhost:5002/ui  (admin/admin)
echo  Orchestrator API: http://localhost:5003
echo  Analytics:        http://localhost:5004
echo ==========================================
echo.

echo Opening Hermes...
start http://localhost:5000
echo.
echo Press any key to exit...
pause >nul
