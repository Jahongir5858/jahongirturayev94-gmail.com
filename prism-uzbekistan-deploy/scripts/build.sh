#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="$ROOT_DIR/.prism-src"
UPSTREAM_REF="${PRISM_UPSTREAM_REF:-603710958a025f15507164ccdaa24bc2515b70dc}"

export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=4096}"

rm -rf "$SRC_DIR" "$ROOT_DIR/dist"

echo "[1/7] Fetching WFP PRISM upstream..."
git clone --depth 1 https://github.com/WFP-VAM/prism-app.git "$SRC_DIR"
git -C "$SRC_DIR" checkout "$UPSTREAM_REF"

echo "[2/7] Installing Uzbekistan configuration..."
mkdir -p "$SRC_DIR/frontend/src/config/uzbekistan"
cp "$ROOT_DIR/overlay/uzbekistan/index.ts" "$SRC_DIR/frontend/src/config/uzbekistan/index.ts"
cp "$ROOT_DIR/overlay/uzbekistan/prism.json" "$SRC_DIR/frontend/src/config/uzbekistan/prism.json"
node "$ROOT_DIR/scripts/patch-config.mjs" "$SRC_DIR/frontend/src/config/index.ts"

echo "[3/7] Installing and building PRISM common package..."
cd "$SRC_DIR/common"
npx -y yarn@1.22.22 install --frozen-lockfile --network-timeout 600000
npx -y yarn@1.22.22 build

echo "[4/7] Installing PRISM frontend dependencies..."
cd "$SRC_DIR/frontend"
npx -y yarn@1.22.22 install --frozen-lockfile --network-timeout 600000

echo "[5/7] Building Uzbekistan frontend..."
REACT_APP_COUNTRY=uzbekistan npx -y yarn@1.22.22 build

echo "[6/7] Preparing Cloudflare Pages output..."
cp -a "$SRC_DIR/frontend/build" "$ROOT_DIR/dist"
printf '/* /index.html 200\n' > "$ROOT_DIR/dist/_redirects"
printf '{"country":"uzbekistan","upstream":"%s"}\n' "$UPSTREAM_REF" > "$ROOT_DIR/dist/prism-build-meta.json"

echo "[7/7] Done. Output: $ROOT_DIR/dist"
