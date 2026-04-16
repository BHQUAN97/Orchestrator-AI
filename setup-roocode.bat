@echo off
chcp 65001 >nul
title Setup Roo Code for All Projects

echo ==========================================
echo   Roo Code — Setup cho tat ca projects
echo ==========================================
echo.

set TEMPLATE_DIR=E:\DEVELOP\ai-orchestrator\roo-templates
set PROJECTS=LeQuyDon FashionEcom VietNet2026 WebPhoto RemoteTerminal VIETNET ai-orchestrator

for %%P in (%PROJECTS%) do (
    echo [+] Setting up E:\DEVELOP\%%P ...

    REM Tao .roo directories
    if not exist "E:\DEVELOP\%%P\.roo\rules" mkdir "E:\DEVELOP\%%P\.roo\rules"
    if not exist "E:\DEVELOP\%%P\.roo\rules-spec" mkdir "E:\DEVELOP\%%P\.roo\rules-spec"
    if not exist "E:\DEVELOP\%%P\.roo\rules-build" mkdir "E:\DEVELOP\%%P\.roo\rules-build"
    if not exist "E:\DEVELOP\%%P\.roo\rules-review" mkdir "E:\DEVELOP\%%P\.roo\rules-review"

    REM Copy .roomodes neu chua co
    if not exist "E:\DEVELOP\%%P\.roomodes" (
        copy "%TEMPLATE_DIR%\base.roomodes" "E:\DEVELOP\%%P\.roomodes" >nul
        echo     [v] Created .roomodes
    ) else (
        echo     [-] .roomodes da ton tai, skip
    )

    REM Copy global rules
    copy "%TEMPLATE_DIR%\rules\01-conventions.md" "E:\DEVELOP\%%P\.roo\rules\01-conventions.md" >nul
    echo     [v] Updated rules
)

echo.
echo ==========================================
echo   Done! Roo Code config cho %PROJECTS%
echo ==========================================
echo.
echo Buoc tiep:
echo   1. Mo VS Code
echo   2. Mo Roo Code panel (Ctrl+Shift+P ^> "Roo Code")
echo   3. Settings ^> API Provider ^> LiteLLM
echo   4. Base URL: http://localhost:4001
echo   5. API Key: sk-master-change-me
echo   6. Chon model cho tung mode
echo.
pause
