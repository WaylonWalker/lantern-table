#!/bin/sh
# Lantern Bridge release installer. Published at https://dnd.waylonwalker.com/run
set -eu
umask 077
REPO="WaylonWalker/lantern-table"
VERSION="${LANTERN_VERSION:-latest}"
case "$(uname -s)" in
  Linux) OS=linux ;;
  Darwin) OS=darwin ;;
  *) echo 'Unsupported OS: use a Linux or macOS terminal.' >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64|amd64) ARCH=amd64 ;;
  arm64|aarch64) ARCH=arm64 ;;
  *) echo 'Unsupported CPU architecture.' >&2; exit 1 ;;
esac
ASSET="lantern-${OS}-${ARCH}.tar.gz"
if [ "$VERSION" = latest ]; then
  BASE="https://github.com/$REPO/releases/latest/download"
else
  case "$VERSION" in lantern-v[0-9]*|v[0-9]*) : ;; *) echo 'Invalid release tag' >&2; exit 1;; esac
  BASE="https://github.com/$REPO/releases/download/$VERSION"
fi
INSTALL_DIR="${LANTERN_INSTALL_DIR:-${HOME}/.local/share/lantern}"
BIN_DIR="${LANTERN_BIN_DIR:-${HOME}/.local/bin}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT HUP INT TERM
fetch() { curl --fail --location --silent --show-error --proto '=https' --tlsv1.2 "$1" -o "$2"; }
if ! fetch "$BASE/$ASSET" "$TMP/$ASSET"; then
  printf '%s\n' 'Lantern companion binary is not available yet for this platform.' >&2
  printf '%s\n' 'Check releases: https://github.com/WaylonWalker/lantern-table/releases' >&2
  printf '%s\n' 'Already have the source? Run: just tui (Go 1.26+ and uv required).' >&2
  exit 1
fi
if ! fetch "$BASE/SHA256SUMS" "$TMP/SHA256SUMS"; then
  echo 'Lantern release is missing SHA256SUMS; refusing to install unverified binaries.' >&2
  exit 1
fi
EXPECTED="$(grep "  $ASSET\$" "$TMP/SHA256SUMS" | head -n 1 | cut -d ' ' -f1)"
if [ -z "$EXPECTED" ]; then echo 'Release checksum not found' >&2; exit 1; fi
if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL="$(sha256sum "$TMP/$ASSET" | cut -d ' ' -f1)"
else
  ACTUAL="$(shasum -a 256 "$TMP/$ASSET" | cut -d ' ' -f1)"
fi
if [ "$ACTUAL" != "$EXPECTED" ]; then echo 'SHA256 verification failed' >&2; exit 1; fi
mkdir -p "$TMP/extracted" "$BIN_DIR"
tar -xzf "$TMP/$ASSET" -C "$TMP/extracted"
# Keep runtime and launcher in one versioned installation, update atomically.
DEST="$INSTALL_DIR"
mkdir -p "$(dirname "$DEST")"
rm -rf "$DEST.next"
mv "$TMP/extracted" "$DEST.next"
if [ -d "$DEST" ]; then rm -rf "$DEST.old"; mv "$DEST" "$DEST.old"; fi
mv "$DEST.next" "$DEST"
ln -sfn "$DEST/lantern" "$BIN_DIR/lantern"
printf 'Lantern installed to %s\n' "$DEST"
printf 'Run: %s/lantern\n' "$BIN_DIR"
case ":$PATH:" in *":$BIN_DIR:"*) : ;; *) printf 'Add %s to your PATH to use the lantern command.\n' "$BIN_DIR" ;; esac