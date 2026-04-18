@echo off
chcp 65001 >nul
title AI Orchestrator

:menu
cls
echo ==========================================
echo        AI Orchestrator Manager
echo ==========================================
echo.
echo  [1] Start all services
echo  [2] Stop all services
echo  [3] Test all models
echo  [4] Edit API keys (.env)
echo  [5] Edit model config (litellm_config.yaml)
echo  [6] View logs
echo  [7] Open Dashboard (browser)
echo  [8] Open LiteLLM UI (browser)
echo  [9] Open Hermes (browser)
echo  [0] Status check
echo  [A] Cost Analytics (browser)
echo  [C] Setup Roo Code (all projects)
echo  [R] Restart LiteLLM (after config change)
echo  [T] Tunnel — Start/Stop Cloudflare Tunnel
echo  [G] Gateway Portal (browser)
echo  [Q] Quit
echo.
echo ==========================================

set /p choice="Chon [0-9/A/C/R/T/G/Q]: "

if /i "%choice%"=="1" goto start_all
if /i "%choice%"=="2" goto stop_all
if /i "%choice%"=="3" goto test_models
if /i "%choice%"=="4" goto edit_env
if /i "%choice%"=="5" goto edit_config
if /i "%choice%"=="6" goto view_logs
if /i "%choice%"=="7" goto open_dashboard
if /i "%choice%"=="8" goto open_litellm
if /i "%choice%"=="9" goto open_hermes
if /i "%choice%"=="0" goto status
if /i "%choice%"=="A" goto open_analytics
if /i "%choice%"=="C" goto setup_roocode
if /i "%choice%"=="R" goto restart_litellm
if /i "%choice%"=="T" goto toggle_tunnel
if /i "%choice%"=="G" goto open_gateway
if /i "%choice%"=="Q" goto quit
goto menu

:start_all
echo.
echo Starting services...
cd /d E:\DEVELOP\ai-orchestrator
docker compose up -d
echo.
echo Waiting for LiteLLM (15s)...
timeout /t 15 /nobreak >nul
echo.
echo Services:
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" 2>nul | findstr /i "litellm hermes orch trust"
echo.
pause
goto menu

:stop_all
echo.
echo Stopping...
cd /d E:\DEVELOP\ai-orchestrator
docker compose down
echo Done.
pause
goto menu

:test_models
echo.
echo Testing models through LiteLLM proxy...
echo.

set PROXY=http://localhost:5002
set KEY=sk-master-change-me

echo [1] default (Kimi K2.5)...
curl -s %PROXY%/v1/chat/completions -H "Authorization: Bearer %KEY%" -H "Content-Type: application/json" -d "{\"model\":\"default\",\"messages\":[{\"role\":\"user\",\"content\":\"Noi xin chao bang tieng Viet, 1 cau\"}],\"max_tokens\":30}" 2>&1
echo.
echo.

echo [2] cheap (DeepSeek)...
curl -s %PROXY%/v1/chat/completions -H "Authorization: Bearer %KEY%" -H "Content-Type: application/json" -d "{\"model\":\"cheap\",\"messages\":[{\"role\":\"user\",\"content\":\"1+1=? Chi tra loi 1 so\"}],\"max_tokens\":5}" 2>&1
echo.
echo.

echo [3] fast (Gemini)...
curl -s %PROXY%/v1/chat/completions -H "Authorization: Bearer %KEY%" -H "Content-Type: application/json" -d "{\"model\":\"fast\",\"messages\":[{\"role\":\"user\",\"content\":\"Say OK\"}],\"max_tokens\":5}" 2>&1
echo.
echo.

echo [4] Smart Router...
cd /d E:\DEVELOP\ai-orchestrator
node -e "const{SmartRouter:S}=require('./router/smart-router');const r=new S({availableModels:['gemini-flash','kimi-k2.5','deepseek','opus']});[['Fix button','build',['c.tsx']],['Add API','build',['s.service.ts']],['Review','review',['a.ts']],['Design','spec',[]]].forEach(([p,t,f])=>{const m=r.route({task:t,files:f,prompt:p});console.log('  '+p.padEnd(15)+' -> '+m.model+' ('+m.litellm_name+')')})"
echo.
pause
goto menu

:edit_env
echo.
echo Opening .env...
notepad E:\DEVELOP\ai-orchestrator\.env
echo.
echo Doi .env xong? Restart LiteLLM de ap dung:
echo   docker compose restart litellm
echo.
set /p restart_yn="Restart ngay? [Y/n]: "
if /i "%restart_yn%"=="n" goto menu
cd /d E:\DEVELOP\ai-orchestrator
docker compose up -d --force-recreate litellm
echo Restarted! Doi 15s...
timeout /t 15 /nobreak >nul
goto menu

:edit_config
echo.
echo Opening litellm_config.yaml...
notepad E:\DEVELOP\ai-orchestrator\litellm_config.yaml
echo.
set /p restart_yn="Restart LiteLLM? [Y/n]: "
if /i "%restart_yn%"=="n" goto menu
cd /d E:\DEVELOP\ai-orchestrator
docker compose restart litellm
echo Restarted!
timeout /t 15 /nobreak >nul
goto menu

:view_logs
echo.
echo Showing last 50 lines of LiteLLM logs...
echo (Ctrl+C to stop)
echo.
docker logs litellm-proxy --tail 50 -f
goto menu

:open_dashboard
start http://localhost:5004
goto menu

:open_litellm
start http://localhost:5002/ui
goto menu

:open_hermes
start http://localhost:5000
goto menu

:status
echo.
echo === Docker Containers ===
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" 2>nul | findstr /i "litellm hermes orch trust gateway auth tunnel"
echo.
echo === LiteLLM Health ===
curl -s http://localhost:5002/health -H "Authorization: Bearer sk-master-change-me" 2>nul | findstr "healthy_count"
echo.
echo === API Keys ===
findstr /R "API_KEY=" E:\DEVELOP\ai-orchestrator\.env | findstr /V "^#" | findstr /V "MASTER"
echo.
echo === Local Ports ===
echo  Gateway Portal:   http://localhost:5005
echo  Hermes Brain:     http://localhost:5000
echo  WebUI:            http://localhost:5001
echo  LiteLLM:          http://localhost:5002/ui
echo  Orchestrator API: http://localhost:5003
echo  Analytics:        http://localhost:5004
echo.
echo === Tunnel ===
docker ps --format "{{.Status}}" 2>nul | findstr /i "tunnel" >nul 2>&1
if not errorlevel 1 (
    echo  Tunnel: RUNNING — https://ai.remoteterminal.online
) else (
    echo  Tunnel: STOPPED
)
echo.
pause
goto menu

:open_analytics
start http://localhost:5004
goto menu

:setup_roocode
echo.
echo Setting up Roo Code for all projects...
call E:\DEVELOP\ai-orchestrator\setup-roocode.bat
goto menu

:restart_litellm
echo.
echo Restarting LiteLLM with force-recreate...
cd /d E:\DEVELOP\ai-orchestrator
docker compose up -d --force-recreate litellm
echo Waiting 15s...
timeout /t 15 /nobreak >nul
echo Done.
pause
goto menu

:toggle_tunnel
echo.
cd /d E:\DEVELOP\ai-orchestrator
docker ps --format "{{.Names}}" 2>nul | findstr "orcai-tunnel" >nul 2>&1
if not errorlevel 1 (
    echo Tunnel dang chay. Dung tunnel...
    docker compose --profile tunnel stop tunnel
    echo Done.
) else (
    echo Khoi dong tunnel...
    docker compose --profile tunnel up -d tunnel
    timeout /t 5 /nobreak >nul
    echo Done. Check: https://ai.remoteterminal.online
)
pause
goto menu

:open_gateway
start http://localhost:5005
goto menu

:quit
exit
