#!/usr/bin/env bash
set -e

echo "=== OrcAI Setup ==="
echo

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "ERROR: Node.js not found. Install from https://nodejs.org"
    exit 1
fi

echo "Node.js $(node --version) detected"

# Install dependencies
echo "Installing dependencies..."
npm install

# Create global link
echo "Creating global command 'orcai'..."
npm link

# Create config directory
CONFIG_DIR="$HOME/.orcai"
if [ ! -d "$CONFIG_DIR" ]; then
    mkdir -p "$CONFIG_DIR"
    echo "Created config directory: $CONFIG_DIR"
fi

# Check .env
if [ ! -f .env ]; then
    echo
    echo "WARNING: .env file not found. Copy .env.example and fill in your API keys."
    if [ -f .env.example ]; then
        cp .env.example .env
        echo "Copied .env.example → .env"
    fi
fi

echo
echo "=== Setup Complete ==="
echo "Run: orcai --help"
echo "Run: orcai -i  (interactive mode)"
