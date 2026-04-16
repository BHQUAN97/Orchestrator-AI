@echo off
title AI Orchestrator — Stop
echo Stopping all services...
cd /d E:\DEVELOP\ai-orchestrator
docker compose down
echo.
echo All services stopped.
pause
