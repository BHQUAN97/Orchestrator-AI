#!/bin/bash
# ============================================
# AI Orchestrator — Setup Script
# Chay: bash setup.sh
# ============================================

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "=========================================="
echo " AI Orchestrator Setup"
echo " Hermes Agent + LiteLLM + GitNexus"
echo "=========================================="
echo ""

# --- Step 1: Check Docker ---
echo "[1/5] Kiem tra Docker..."
if ! command -v docker &> /dev/null; then
    echo "❌ Docker chua cai. Cai Docker Desktop truoc: https://docker.com"
    exit 1
fi

if ! docker info &> /dev/null; then
    echo "❌ Docker chua chay. Mo Docker Desktop truoc."
    exit 1
fi
echo "✅ Docker OK"

# --- Step 2: Setup .env ---
echo ""
echo "[2/5] Cau hinh API keys..."
if [ ! -f .env ]; then
    cp .env.example .env
    echo "📝 Tao .env tu template"
fi

# Check neu chua co key nao
if ! grep -q "OPENROUTER_API_KEY=sk-" .env 2>/dev/null && \
   ! grep -q "KIMI_API_KEY=." .env 2>/dev/null; then
    echo ""
    echo "⚠️  Chua co API key nao!"
    echo "Cach nhanh nhat: dang ky OpenRouter (free) tai https://openrouter.ai/keys"
    echo ""
    read -p "Nhap OpenRouter API key (hoac Enter de skip): " OR_KEY
    if [ -n "$OR_KEY" ]; then
        sed -i "s|^OPENROUTER_API_KEY=.*|OPENROUTER_API_KEY=$OR_KEY|" .env
        echo "✅ OpenRouter key da luu"
    else
        echo "⏭️  Skip — ban co the dien sau trong .env"
    fi
fi

# --- Step 3: Pull images ---
echo ""
echo "[3/5] Pull Docker images (co the mat vai phut)..."
docker compose pull

# --- Step 4: Start services ---
echo ""
echo "[4/5] Khoi dong services..."
docker compose up -d

# --- Step 5: Health check ---
echo ""
echo "[5/5] Kiem tra services..."
sleep 5

echo ""
echo "=========================================="
echo " ✅ Setup hoan tat!"
echo "=========================================="
echo ""
echo " 📊 LiteLLM Dashboard:  http://localhost:4001/ui"
echo "    Login: admin / admin"
echo ""
echo " 🤖 Hermes Agent:       http://localhost:3000"
echo " 🌐 Hermes WebUI:       http://localhost:3002"
echo ""
echo " 📝 Config files:"
echo "    API keys:     $SCRIPT_DIR/.env"
echo "    LiteLLM:      $SCRIPT_DIR/litellm_config.yaml"
echo "    Hermes:        $SCRIPT_DIR/hermes_config.yaml"
echo ""
echo " ⚡ Commands:"
echo "    Xem logs:      docker compose logs -f"
echo "    Restart:       docker compose restart"
echo "    Stop:          docker compose down"
echo "    Hermes setup:  docker compose exec hermes hermes setup"
echo ""

# Check if any API keys configured
if grep -q "OPENROUTER_API_KEY=$" .env; then
    echo " ⚠️  Nho dien API key vao .env roi restart:"
    echo "    1. Mo file: $SCRIPT_DIR/.env"
    echo "    2. Dien it nhat 1 key (khuyen nghi: OpenRouter)"
    echo "    3. Chay: docker compose restart"
fi
