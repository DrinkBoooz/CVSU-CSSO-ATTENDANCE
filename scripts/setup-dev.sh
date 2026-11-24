#!/usr/bin/env bash
set -euo pipefail

WITH_CLASP=0
SKIP_TESTS=0
for arg in "$@"; do
  case "$arg" in
    --with-clasp) WITH_CLASP=1 ;;
    --skip-tests) SKIP_TESTS=1 ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done

echo "=== CvSU CSSO Attendance - One-Click Dev Setup ==="

for cmd in git node npm; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Error: '$cmd' is required. Please install Git and Node.js 22+ first." >&2
    exit 1
  fi
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "[1/4] Installing npm dependencies (npm ci)..."
npm ci

echo "[2/4] Installing Playwright Chromium..."
npx playwright install chromium

if [ "$WITH_CLASP" -eq 1 ]; then
  echo "[3/4] Installing @google/clasp globally..."
  npm install -g @google/clasp
  echo "Run 'clasp login' and update .clasp.json with your Script ID to push via CLI."
else
  echo "[3/4] Skipping @google/clasp (pass --with-clasp to install)."
fi

if [ "$SKIP_TESTS" -eq 0 ]; then
  echo "[4/4] Running full verification suite (npm test)..."
  npm test
fi

echo "[DONE] Developer environment is ready!"
