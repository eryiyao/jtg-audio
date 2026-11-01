#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [[ "$(git branch --show-current)" != main || -n "$(git status --porcelain)" ]]; then
  echo 'Update requires a clean main branch.' >&2
  exit 1
fi
git pull --ff-only origin main
npm ci --omit=dev --no-audit --no-fund
npm test
sudo systemctl restart jtg-audio
for attempt in {1..15}; do
  if curl --fail --silent http://127.0.0.1:4300/healthz >/dev/null; then
    echo "JTG Audio updated to $(git rev-parse --short HEAD)"
    exit 0
  fi
  sleep 1
done
echo 'Service did not become ready; inspect journalctl -u jtg-audio.' >&2
exit 1
