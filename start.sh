#!/bin/bash
# geminicli-bridge 啟動腳本
# 用法: ./start.sh        (前景執行)
#       ./start.sh daemon  (背景執行)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PIDFILE="$SCRIPT_DIR/geminicli-bridge.pid"
LOGFILE="$SCRIPT_DIR/geminicli-bridge.log"

# ─── Configuration (override via .env or environment) ───
if [ -f "$SCRIPT_DIR/.env" ]; then
    set -a
    source "$SCRIPT_DIR/.env"
    set +a
fi

export GEMINI_MODEL="${GEMINI_MODEL:-gemini-3-flash-preview}"
export GEMINI_APPROVAL_MODE="${GEMINI_APPROVAL_MODE:-yolo}"
export BRIDGE_PORT="${BRIDGE_PORT:-18791}"

# Check if already running
if [ -f "$PIDFILE" ]; then
    OLD_PID=$(cat "$PIDFILE")
    if kill -0 "$OLD_PID" 2>/dev/null; then
        echo "geminicli-bridge is already running (PID $OLD_PID)"
        exit 0
    else
        rm -f "$PIDFILE"
    fi
fi

# Verify gemini CLI is available
if ! command -v gemini &>/dev/null; then
    echo "✗ Error: 'gemini' CLI not found in PATH"
    echo "  Install: npm install -g @anthropic-ai/gemini-cli"
    echo "  Or set GEMINI_BIN to the path of the gemini binary"
    exit 1
fi

echo "╔═══════════════════════════════════════════════════════╗"
echo "║         geminicli-bridge v1.0.0                      ║"
echo "╠═══════════════════════════════════════════════════════╣"
echo "║  Model:    ${GEMINI_MODEL}"
echo "║  Port:     ${BRIDGE_PORT}"
echo "║  Approval: ${GEMINI_APPROVAL_MODE}"
echo "║  Gemini:   $(which gemini) (v$(gemini --version 2>/dev/null || echo 'unknown'))"
echo "╚═══════════════════════════════════════════════════════╝"

if [ "$1" = "daemon" ]; then
    # Background mode
    echo "Starting geminicli-bridge in background..."
    nohup node "$SCRIPT_DIR/geminicli-bridge.mjs" >> "$LOGFILE" 2>&1 &
    echo $! > "$PIDFILE"
    echo "geminicli-bridge started (PID $(cat "$PIDFILE"))"
    echo "Log: $LOGFILE"
    sleep 2
    if kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
        echo "✓ Health check: $(curl -s http://127.0.0.1:${BRIDGE_PORT}/health)"
    else
        echo "✗ Failed to start. Check $LOGFILE"
        exit 1
    fi
else
    # Foreground mode
    exec node "$SCRIPT_DIR/geminicli-bridge.mjs"
fi
