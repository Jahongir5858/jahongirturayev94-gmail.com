#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="$ROOT_DIR/.prism-src"
UPSTREAM_REF="${PRISM_UPSTREAM_REF:-603710958a025f15507164ccdaa24bc2515b70dc}"

export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=4096}"

rm -rf "$SRC_DIR" "$ROOT_DIR/dist"

echo "[1/6] Fetching WFP PRISM upstream..."
git clone --depth 1 https://github.com/WFP-VAM/prism-app.git "$SRC_DIR"
git -C "$SRC_DIR" checkout "$UPSTREAM_REF"

echo "[2/6] Installing and building PRISM common package..."
cd "$SRC_DIR/common"
npx -y yarn@1.22.22 install --frozen-lockfile --network-timeout 600000
npx -y yarn@1.22.22 build

echo "[3/6] Installing PRISM frontend dependencies..."
cd "$SRC_DIR/frontend"
npx -y yarn@1.22.22 install --frozen-lockfile --network-timeout 600000

echo "[4/6] Building official universal PRISM frontend..."
REACT_APP_COUNTRY=universal npx -y yarn@1.22.22 build

echo "[5/6] Preparing Uzbekistan static output..."
cp -a "$SRC_DIR/frontend/build" "$ROOT_DIR/dist"
printf '/* /index.html 200\n' > "$ROOT_DIR/dist/_redirects"
printf '{"country":"universal","iso3":"UZB","upstream":"%s"}\n' "$UPSTREAM_REF" > "$ROOT_DIR/dist/prism-build-meta.json"

node - "$ROOT_DIR/dist/index.html" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
let html = fs.readFileSync(file, 'utf8');
const redirect = `<script>if(location.pathname==='/'||location.pathname===''){history.replaceState(null,'','/country/UZB'+location.search+location.hash)}</script>`;
html = html.replace('<title>PRISM</title>', '<title>PRISM Uzbekistan</title>' + redirect);
fs.writeFileSync(file, html);
NODE

echo "[6/6] Done. Output: $ROOT_DIR/dist"
