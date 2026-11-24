#!/usr/bin/env bash
# 3D Stodsko – sestavení samostatných spustitelných souborů (celý web zabalený uvnitř).
# Výstup: dist/3D-Stodsko-linux, dist/3D-Stodsko-windows.exe, dist/3D-Stodsko-mac-intel, dist/3D-Stodsko-mac-arm
#
# Potřebuje Go 1.22+ (cesta přes proměnnou GO, výchozí „go“):
#   GO=/cesta/k/go/bin/go tools/build_exe.sh
set -euo pipefail
cd "$(dirname "$0")/.."
GO="${GO:-go}"

rm -rf launcher/web dist
mkdir -p dist
# web bez PHP varianty API a bez dat hlášení
rsync -a --exclude 'api/' --exclude '_test.html' web/ launcher/web/

cd launcher
[ -f go.mod ] || "$GO" mod init stodsko >/dev/null 2>&1
build() {
  echo "· $1/$2 → $3"
  CGO_ENABLED=0 GOOS="$1" GOARCH="$2" "$GO" build -trimpath -ldflags "-s -w" -o "../dist/$3" .
}
build linux amd64 3D-Stodsko-linux
build windows amd64 3D-Stodsko-windows.exe
build darwin amd64 3D-Stodsko-mac-intel
build darwin arm64 3D-Stodsko-mac-arm
cd ..
rm -rf launcher/web
ls -lh dist
