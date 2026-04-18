@echo off
title AI Orchestrator — Test All Models
echo ==========================================
echo  Testing all models through LiteLLM
echo ==========================================
echo.

set PROXY=http://localhost:5002
set KEY=sk-master-change-me

echo [1/4] default (Kimi K2.5)...
curl -s %PROXY%/v1/chat/completions -H "Authorization: Bearer %KEY%" -H "Content-Type: application/json" -d "{\"model\":\"default\",\"messages\":[{\"role\":\"user\",\"content\":\"Say OK\"}],\"max_tokens\":5}" 2>&1 | findstr "content"
echo.

echo [2/4] cheap (DeepSeek)...
curl -s %PROXY%/v1/chat/completions -H "Authorization: Bearer %KEY%" -H "Content-Type: application/json" -d "{\"model\":\"cheap\",\"messages\":[{\"role\":\"user\",\"content\":\"Say OK\"}],\"max_tokens\":5}" 2>&1 | findstr "content"
echo.

echo [3/4] fast (Gemini)...
curl -s %PROXY%/v1/chat/completions -H "Authorization: Bearer %KEY%" -H "Content-Type: application/json" -d "{\"model\":\"fast\",\"messages\":[{\"role\":\"user\",\"content\":\"Say OK\"}],\"max_tokens\":5}" 2>&1 | findstr "content"
echo.

echo [4/4] Smart Router test...
cd /d E:\DEVELOP\ai-orchestrator
node -e "const{SmartRouter}=require('./router/smart-router');const r=new SmartRouter({availableModels:['gemini-flash','kimi-k2.5','deepseek','opus']});[{t:'build',f:['src/c.tsx'],p:'Fix button'},{t:'build',f:['src/s.service.ts'],p:'Add API'},{t:'review',f:['src/a.ts'],p:'Review code'},{t:'spec',f:[],p:'Design feature'}].forEach(x=>{const m=r.route({task:x.t,files:x.f,prompt:x.p});console.log(x.p.padEnd(20)+' -> '+m.model)})"
echo.

echo ==========================================
echo  Done!
echo ==========================================
pause
