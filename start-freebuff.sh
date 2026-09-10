#!/usr/bin/env bash
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROXY_DIR="$DIR/scripts/freebuff-proxy"
cd "$PROXY_DIR"

PORT=${PORT:-9187}
LOG_FILE="/tmp/freebuff_proxy.log"

echo "🚀 [Freebuff Engine] Memeriksa instance lama pada port $PORT..."
fuser -k "$PORT/tcp" 2>/dev/null || true
sleep 1

echo "🌟 [Freebuff Engine] Menjalankan Proxy Engine pada http://127.0.0.1:$PORT..."
echo "📄 [Freebuff Engine] Log output: $LOG_FILE"

LISTEN_ADDR="0.0.0.0:$PORT" PORT="$PORT" NODE_ENV="production" setsid node "$PROXY_DIR/dist/cli.js" > "$LOG_FILE" 2>&1 &
PROXY_PID=$!

sleep 3
if ps -p "$PROXY_PID" > /dev/null 2>&1 || fuser "$PORT/tcp" >/dev/null 2>&1; then
  echo "✅ [Freebuff Engine] Berhasil berjalan! (PID: $PROXY_PID)"
  echo "👉 Proxy Endpoint: http://127.0.0.1:$PORT/v1"
  echo "👉 Tail Log: tail -f $LOG_FILE"
else
  echo "❌ [Freebuff Engine] Gagal dijalankan. Cek log:"
  tail -n 20 "$LOG_FILE"
fi
