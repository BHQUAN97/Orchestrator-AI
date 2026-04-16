#!/bin/bash
# ============================================
# Test Gemini qua tat ca model names trong LiteLLM
# Chay: bash test-gemini.sh
# ============================================

PROXY="http://localhost:4001"
KEY="sk-master-change-me"

echo "=========================================="
echo " Test Gemini qua LiteLLM Proxy"
echo "=========================================="

# Test health
echo ""
echo "[1/5] Health check..."
HEALTH=$(curl -s "$PROXY/health" 2>&1)
if echo "$HEALTH" | grep -q "healthy"; then
    echo "✅ LiteLLM proxy healthy"
else
    echo "❌ LiteLLM proxy not responding: $HEALTH"
    echo "   Chay: docker compose up -d"
    exit 1
fi

# Test model: default (Gemini Flash)
echo ""
echo "[2/5] Test model 'default' (Gemini 2.5 Flash)..."
RESP=$(curl -s "$PROXY/v1/chat/completions" \
    -H "Authorization: Bearer $KEY" \
    -H "Content-Type: application/json" \
    -d '{
        "model": "default",
        "messages": [{"role": "user", "content": "Noi hello bang tieng Viet, 1 cau ngan"}],
        "max_tokens": 50
    }' 2>&1)

if echo "$RESP" | grep -q "choices"; then
    MSG=$(echo "$RESP" | grep -o '"content":"[^"]*"' | head -1)
    echo "✅ default OK — $MSG"
else
    echo "❌ default FAIL — $RESP" | head -5
fi

# Test model: smart (Gemini Pro)
echo ""
echo "[3/5] Test model 'smart' (Gemini 2.5 Pro)..."
RESP=$(curl -s "$PROXY/v1/chat/completions" \
    -H "Authorization: Bearer $KEY" \
    -H "Content-Type: application/json" \
    -d '{
        "model": "smart",
        "messages": [{"role": "user", "content": "1+1=?"}],
        "max_tokens": 10
    }' 2>&1)

if echo "$RESP" | grep -q "choices"; then
    echo "✅ smart OK"
else
    echo "❌ smart FAIL — $RESP" | head -3
fi

# Test model: fast
echo ""
echo "[4/5] Test model 'fast' (Gemini 2.5 Flash)..."
RESP=$(curl -s "$PROXY/v1/chat/completions" \
    -H "Authorization: Bearer $KEY" \
    -H "Content-Type: application/json" \
    -d '{
        "model": "fast",
        "messages": [{"role": "user", "content": "Say OK"}],
        "max_tokens": 5
    }' 2>&1)

if echo "$RESP" | grep -q "choices"; then
    echo "✅ fast OK"
else
    echo "❌ fast FAIL"
fi

# Test model: cheap
echo ""
echo "[5/5] Test model 'cheap' (Gemini 2.5 Flash)..."
RESP=$(curl -s "$PROXY/v1/chat/completions" \
    -H "Authorization: Bearer $KEY" \
    -H "Content-Type: application/json" \
    -d '{
        "model": "cheap",
        "messages": [{"role": "user", "content": "Hi"}],
        "max_tokens": 5
    }' 2>&1)

if echo "$RESP" | grep -q "choices"; then
    echo "✅ cheap OK"
else
    echo "❌ cheap FAIL"
fi

# Cost check
echo ""
echo "=========================================="
echo " Ket qua"
echo "=========================================="
echo ""
echo " Models: default, smart, fast, cheap — tat ca dung Gemini"
echo ""
echo " Dashboard:     http://localhost:4001/ui"
echo " Orchestrator:  http://localhost:8080"
echo " Hermes:        http://localhost:3000"
echo ""

# Fetch spend
SPEND=$(curl -s "$PROXY/spend/logs" -H "Authorization: Bearer $KEY" 2>&1)
echo " Token usage log: $PROXY/spend/logs"
