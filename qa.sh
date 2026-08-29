#!/bin/bash
set -euo pipefail
cd ~/pawspace-tech-platform
git fetch origin
git switch "$1" 2>/dev/null || git switch -c "$1" "origin/$1"
lsof -ti:5173 | xargs kill -9 2>/dev/null || true
nohup npm run dev > /tmp/pawspace-dev.log 2>&1 &
echo "waiting for server..."
for i in $(seq 1 30); do curl -s -o /dev/null http://localhost:5173 && break; sleep 1; done
npx playwright test 2>&1 | tail -40
