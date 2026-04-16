@echo off
chcp 65001 >nul
title AI Orchestrator — Deploy All-in-One
setlocal enabledelayedexpansion

cd /d E:\DEVELOP\ai-orchestrator

echo ==========================================
echo  AI Orchestrator v2.1 — Deploy All-in-One
echo ==========================================
echo.

set ERRORS=0
set LITELLM_P=5002
set ORCH_P=5003
set HERMES_P=5000
set WEBUI_P=5001
set ANALYTICS_P=5004
set GATEWAY_P=5005

:: ============================================
:: [1/7] Prerequisites
:: ============================================
echo [1/7] Kiem tra prerequisites...

:: Check Docker
docker info >nul 2>&1
if errorlevel 1 (
    echo     X Docker chua chay! Mo Docker Desktop truoc.
    pause
    exit /b 1
)
echo     OK Docker

:: Check Node.js
node --version >nul 2>&1
if errorlevel 1 (
    echo     X Node.js chua cai! https://nodejs.org
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('node --version') do echo     OK Node.js %%v

:: Check curl
curl --version >nul 2>&1
if errorlevel 1 (
    echo     X curl khong co!
    pause
    exit /b 1
)
echo     OK curl
echo.

:: ============================================
:: [2/7] Check port conflicts
:: ============================================
echo [2/7] Kiem tra port conflicts...

set PORT_OK=1
for %%P in (%HERMES_P% %WEBUI_P% %LITELLM_P% %ORCH_P% %ANALYTICS_P% %GATEWAY_P%) do (
    netstat -ano 2>nul | findstr "LISTENING" | findstr ":%%P " >nul 2>&1
    if not errorlevel 1 (
        echo     X Port %%P da bi chiem!
        netstat -ano 2>nul | findstr "LISTENING" | findstr ":%%P "
        set PORT_OK=0
    )
)

if "!PORT_OK!"=="0" (
    echo.
    echo     Co port bi conflict. Chon:
    echo     [1] Dung lai — tu fix port
    echo     [2] Tiep tuc — co the la container cu, se restart
    set /p port_choice="     Chon [1/2]: "
    if "!port_choice!"=="1" (
        pause
        exit /b 1
    )
)
if "!PORT_OK!"=="1" echo     OK Ports 5000-5005 trong
echo.

:: ============================================
:: [3/7] Setup .env
:: ============================================
echo [3/7] Kiem tra .env...

if not exist .env (
    copy .env.example .env >nul
    echo     Tao .env tu template
)

:: Validate co it nhat 1 API key
set HAS_KEY=0
for /f "tokens=1,2 delims==" %%a in (.env) do (
    if "%%a"=="OPENROUTER_API_KEY" if not "%%b"=="" set HAS_KEY=1
    if "%%a"=="GEMINI_API_KEY" if not "%%b"=="" set HAS_KEY=1
)

if "!HAS_KEY!"=="0" (
    echo     WARN: Chua co API key nao trong .env!
    echo     Dien it nhat 1 key: OPENROUTER_API_KEY hoac GEMINI_API_KEY
    echo     Mo .env de dien...
    notepad .env
    echo     Da dien key? Nhan phim bat ky de tiep tuc...
    pause >nul
)
echo     OK .env
echo.

:: ============================================
:: [4/7] npm install
:: ============================================
echo [4/7] Cai dat Node dependencies...
call npm install --silent 2>nul
if errorlevel 1 (
    echo     WARN: npm install co loi, thu tiep...
    set /a ERRORS+=1
) else (
    echo     OK npm install
)
echo.

:: ============================================
:: [5/7] Docker pull + start
:: ============================================
echo [5/7] Pull images + khoi dong services...
echo     Pulling images (co the mat vai phut lan dau)...
docker compose pull --quiet 2>nul
echo     Starting containers...
docker compose up -d --remove-orphans 2>nul
echo     OK docker compose up
echo.

:: ============================================
:: [6/7] Health checks
:: ============================================
echo [6/7] Doi services khoi dong...

:: Wait LiteLLM (quan trong nhat, cac service khac depend vao)
echo     Doi LiteLLM (:5002)...
set LITELLM_OK=0
for /L %%i in (1,1,20) do (
    if "!LITELLM_OK!"=="0" (
        timeout /t 3 /nobreak >nul
        curl -s http://localhost:%LITELLM_P%/health -H "Authorization: Bearer sk-master-change-me" >nul 2>&1
        if not errorlevel 1 set LITELLM_OK=1
    )
)
if "!LITELLM_OK!"=="1" (
    echo     OK LiteLLM ready
) else (
    echo     X LiteLLM khong respond sau 60s
    set /a ERRORS+=1
)

:: Wait Orchestrator
echo     Doi Orchestrator (:5003)...
set ORCH_OK=0
for /L %%i in (1,1,10) do (
    if "!ORCH_OK!"=="0" (
        timeout /t 2 /nobreak >nul
        curl -s http://localhost:%ORCH_P%/health >nul 2>&1
        if not errorlevel 1 set ORCH_OK=1
    )
)
if "!ORCH_OK!"=="1" (
    echo     OK Orchestrator ready
) else (
    echo     X Orchestrator khong respond
    set /a ERRORS+=1
)

:: Check Hermes
curl -s http://localhost:%HERMES_P% >nul 2>&1
if not errorlevel 1 (
    echo     OK Hermes ready
) else (
    echo     ~ Hermes chua ready (co the can them thoi gian)
)

:: Check WebUI
curl -s http://localhost:%WEBUI_P% >nul 2>&1
if not errorlevel 1 (
    echo     OK WebUI ready
) else (
    echo     ~ WebUI chua ready (co the can them thoi gian)
)
echo.

:: ============================================
:: [7/7] Smoke test
:: ============================================
echo [7/7] Smoke test...

if "!LITELLM_OK!"=="1" (
    echo     Testing model qua LiteLLM...
    curl -s http://localhost:%LITELLM_P%/v1/chat/completions ^
        -H "Authorization: Bearer sk-master-change-me" ^
        -H "Content-Type: application/json" ^
        -d "{\"model\":\"default\",\"messages\":[{\"role\":\"user\",\"content\":\"Say OK\"}],\"max_tokens\":5}" 2>nul | findstr "content" >nul 2>&1
    if not errorlevel 1 (
        echo     OK Model respond thanh cong
    ) else (
        echo     X Model khong respond — kiem tra API keys trong .env
        set /a ERRORS+=1
    )
) else (
    echo     SKIP — LiteLLM chua ready
)
echo.

:: ============================================
:: [8/8] Gateway + Tunnel
:: ============================================
echo [8/8] Gateway + Tunnel...

:: Check gateway
curl -s http://localhost:%GATEWAY_P%/login >nul 2>&1
if not errorlevel 1 (
    echo     OK Gateway ready (:5005)
) else (
    echo     ~ Gateway chua ready
)

:: Check tunnel token
set HAS_TUNNEL=0
for /f "tokens=1,2 delims==" %%a in (.env) do (
    if "%%a"=="CLOUDFLARE_TUNNEL_TOKEN" if not "%%b"=="" set HAS_TUNNEL=1
)
if "!HAS_TUNNEL!"=="1" (
    echo     Khoi dong Cloudflare Tunnel...
    docker compose --profile tunnel up -d tunnel 2>nul
    timeout /t 5 /nobreak >nul
    docker logs orcai-tunnel --tail 3 2>&1 | findstr /i "registered\|connected\|INF" >nul 2>&1
    if not errorlevel 1 (
        echo     OK Tunnel connected — https://ai.remoteterminal.online
    ) else (
        echo     ~ Tunnel dang ket noi...
    )
) else (
    echo     SKIP Tunnel — chua co CLOUDFLARE_TUNNEL_TOKEN
    echo     Setup: scripts\tunnel-setup.bat
)
echo.

:: ============================================
:: Summary
:: ============================================
echo ==========================================
if "!ERRORS!"=="0" (
    echo  DEPLOY THANH CONG!
) else (
    echo  DEPLOY XONG — !ERRORS! warnings
)
echo ==========================================
echo.
echo  Local:
echo    Gateway Portal:   http://localhost:%GATEWAY_P%
echo    Hermes Brain:     http://localhost:%HERMES_P%
echo    WebUI:            http://localhost:%WEBUI_P%
echo    LiteLLM Gateway:  http://localhost:%LITELLM_P%/ui  (admin/admin)
echo    Orchestrator API: http://localhost:%ORCH_P%
echo    Analytics:        http://localhost:%ANALYTICS_P%
echo.
if "!HAS_TUNNEL!"=="1" (
echo  Public:
echo    Portal:           https://ai.remoteterminal.online
echo    Login:            https://ai.remoteterminal.online/login
echo.
)
echo  Commands:
echo    Logs:    docker compose logs -f
echo    Stop:    scripts\stop.bat
echo    Test:    scripts\test.bat
echo    Tunnel:  scripts\tunnel-setup.bat
echo    Manager: scripts\orchestrator.bat
echo.
pause
