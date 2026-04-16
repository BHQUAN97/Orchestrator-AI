@echo off
chcp 65001 >nul
title AI Orchestrator — Cloudflare Tunnel Setup
setlocal enabledelayedexpansion

echo ==========================================
echo  Cloudflare Tunnel Setup
echo  Domain: ai.remoteterminal.online
echo ==========================================
echo.

cd /d E:\DEVELOP\ai-orchestrator

:: ============================================
:: Buoc 1: Kiem tra cloudflared CLI
:: ============================================
echo [1/4] Kiem tra cloudflared...
cloudflared --version >nul 2>&1
if errorlevel 1 (
    echo     cloudflared chua cai!
    echo.
    echo     Cach cai:
    echo       winget install Cloudflare.cloudflared
    echo       hoac: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
    echo.
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('cloudflared --version 2^>^&1') do echo     OK %%v
echo.

:: ============================================
:: Buoc 2: Huong dan tao tunnel tren dashboard
:: ============================================
echo [2/4] Tao tunnel tren Cloudflare Dashboard
echo.
echo  1. Mo: https://one.dash.cloudflare.com
echo  2. Vao: Networks ^> Tunnels
echo  3. Click "Create a tunnel"
echo  4. Chon "Cloudflared" connector
echo  5. Dat ten: orcai
echo  6. Copy TUNNEL_TOKEN (chuoi dai bat dau bang eyJ...)
echo.
echo  7. Them Public Hostnames:
echo     +--------------------------+----------+-----------+------+
echo     ^| Public hostname          ^| Type     ^| URL       ^| Port ^|
echo     +--------------------------+----------+-----------+------+
echo     ^| ai.remoteterminal.online ^| HTTP     ^| gateway   ^| 80   ^|
echo     +--------------------------+----------+-----------+------+
echo.
echo  Luu y: URL "gateway" la ten container Docker
echo         Cloudflared chay cung Docker network
echo.

set /p TUNNEL_TOKEN="Paste TUNNEL_TOKEN: "

if "!TUNNEL_TOKEN!"=="" (
    echo     SKIP — khong co token
    echo     Ban co the dien sau trong .env: CLOUDFLARE_TUNNEL_TOKEN=...
    pause
    exit /b 0
)

:: ============================================
:: Buoc 3: Luu token vao .env
:: ============================================
echo.
echo [3/4] Luu token vao .env...

:: Check neu da co CLOUDFLARE_TUNNEL_TOKEN trong .env
findstr /C:"CLOUDFLARE_TUNNEL_TOKEN=" .env >nul 2>&1
if errorlevel 1 (
    echo CLOUDFLARE_TUNNEL_TOKEN=!TUNNEL_TOKEN!>> .env
) else (
    :: Thay the dong cu
    powershell -Command "(Get-Content .env) -replace '^CLOUDFLARE_TUNNEL_TOKEN=.*', 'CLOUDFLARE_TUNNEL_TOKEN=!TUNNEL_TOKEN!' | Set-Content .env"
)
echo     OK Token da luu vao .env
echo.

:: ============================================
:: Buoc 4: Khoi dong tunnel
:: ============================================
echo [4/4] Khoi dong tunnel...
echo.
echo  Chay: docker compose --profile tunnel up -d
echo.
set /p start_yn="Khoi dong ngay? [Y/n]: "
if /i "!start_yn!"=="n" goto done

docker compose --profile tunnel up -d tunnel
echo.

:: Verify
echo Doi tunnel ket noi (10s)...
timeout /t 10 /nobreak >nul

docker logs orcai-tunnel --tail 5 2>&1 | findstr /i "registered\|connected\|INF" >nul 2>&1
if not errorlevel 1 (
    echo     OK Tunnel connected!
    echo.
    echo  Portal: https://ai.remoteterminal.online
    echo  Login:  https://ai.remoteterminal.online/login
) else (
    echo     Tunnel dang ket noi... Kiem tra logs:
    echo     docker logs orcai-tunnel --tail 20
)

:done
echo.
echo ==========================================
echo  Setup xong!
echo ==========================================
echo.
echo  Commands:
echo    Start tunnel:  docker compose --profile tunnel up -d tunnel
echo    Stop tunnel:   docker compose --profile tunnel stop tunnel
echo    Logs:          docker logs orcai-tunnel -f
echo    Full deploy:   scripts\deploy.bat
echo.
echo  Tham khao:
echo    LeQuyDon:    lqd.remoteterminal.online
echo    FashionEcom: shop.remoteterminal.online
echo    OrcAI:       ai.remoteterminal.online
echo.
pause
