#!/usr/bin/env bash
# One-shot bootstrap for brix.money chart server.
#
# Usage on a fresh Ubuntu/Debian host (e.g. Hetzner Cloud):
#   curl -fsSL https://raw.githubusercontent.com/gokhanseckin/brix/main/bootstrap.sh \
#     | ETHERSCAN_API_KEY=xxxxxxxx bash
#
# Override the branch with BRIX_BRANCH=foo if needed.
#
# What it does:
#   1. Installs Node 20 + git if missing (via apt + NodeSource).
#   2. Clones the brix repo at the chart branch into ~/brix-charts.
#   3. Writes .env with the supplied ETHERSCAN_API_KEY.
#   4. Runs the daily-history fetch (Etherscan v2 -> web/snapshots.json).
#   5. Serves ./web on port 8080 in the foreground (Ctrl-C to stop).

set -euo pipefail

if [[ -z "${ETHERSCAN_API_KEY:-}" ]]; then
  echo "ETHERSCAN_API_KEY is required. Example:" >&2
  echo "  curl ... | ETHERSCAN_API_KEY=YOURKEY bash" >&2
  exit 1
fi

REPO_URL="https://github.com/gokhanseckin/brix.git"
BRANCH="${BRIX_BRANCH:-main}"
DEST="${HOME}/brix-charts"
PORT="${PORT:-8080}"

if ! command -v node >/dev/null || ! node -e 'process.exit(parseInt(process.versions.node) >= 20 ? 0 : 1)'; then
  echo "==> Installing Node 20 + git"
  if ! command -v sudo >/dev/null; then
    SUDO=""
  else
    SUDO="sudo"
  fi
  curl -fsSL https://deb.nodesource.com/setup_20.x | $SUDO -E bash -
  $SUDO apt-get install -y nodejs git
fi

if [[ ! -d "$DEST/.git" ]]; then
  echo "==> Cloning $REPO_URL"
  git clone --branch "$BRANCH" --depth 1 "$REPO_URL" "$DEST"
else
  echo "==> Updating existing checkout in $DEST"
  git -C "$DEST" fetch --depth 1 origin "$BRANCH"
  git -C "$DEST" checkout "$BRANCH"
  git -C "$DEST" reset --hard "origin/$BRANCH"
fi

cd "$DEST"
printf 'ETHERSCAN_API_KEY=%s\n' "$ETHERSCAN_API_KEY" > .env
chmod 600 .env

echo "==> Fetching on-chain data (this can take a few minutes the first time)"
node scripts/fetch-data.mjs

PUBLIC_IP="$(curl -fsS --max-time 3 https://ifconfig.me 2>/dev/null || echo "<vps-ip>")"
echo
echo "==> Done. Serving ./web on http://0.0.0.0:${PORT}"
echo "    Open this on your phone: http://${PUBLIC_IP}:${PORT}"
echo "    (Make sure ${PORT}/tcp is open in Hetzner Cloud Firewall.)"
echo
exec npx --yes serve web -l "$PORT"
