#!/bin/bash
# engine-host.sh - resolve the OpenClaw engine location for the portable build (macOS/Linux).
#
# Mirrors lib/engine-host.ps1:
#   auto (default) : ~/Library/Caches/U-Claw/<slot>/engine/<version>, fall back to the stick
#   host           : local cache only
#   drive          : <root>/engine/<version> (self-contained stick)
#   usb / legacy   : run from the stick's loose app/ tree (old layout, or when no archive ships)
#
# Prints KEY=VALUE lines for Mac-Start.command. Never exits non-zero: worst case it
# reports the legacy layout so the customer can still start.

set -u

ROOT_IN="${1:-}"
if [ -z "$ROOT_IN" ]; then
  echo "[engine] usage: engine-host.sh <portable-root>" >&2
  exit 0
fi

ROOT=$(cd "$ROOT_IN" 2>/dev/null && pwd -P) || ROOT="$ROOT_IN"
ROOT="${ROOT%/}"

emit() { printf '%s=%s\n' "$1" "$2"; }
note() { printf '[engine] %s\n' "$*" >&2; }

VERSION=""
if [ -f "$ROOT/OPENCLAW_VERSION" ]; then
  VERSION=$(tr -d '[:space:]' < "$ROOT/OPENCLAW_VERSION")
fi
ARCHIVE=""
[ -n "$VERSION" ] && ARCHIVE="$ROOT/engine-$VERSION.tar.gz"

if [ -z "$VERSION" ] || [ ! -f "$ARCHIVE" ]; then
  emit UCLAW_ENGINE_SOURCE legacy
  emit UCLAW_ENGINE_ROOT "$ROOT"
  exit 0
fi

MODE="${UCLAW_ENGINE_MODE:-auto}"
MODE=$(printf '%s' "$MODE" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')
case "$MODE" in
  host|drive|auto) : ;;
  usb|legacy)
    emit UCLAW_ENGINE_SOURCE usb
    emit UCLAW_ENGINE_ROOT "$ROOT"
    exit 0
    ;;
  *) MODE=auto ;;
esac

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    printf 'unknown'
  fi
}

SLOT=$(printf '%s' "$ROOT" | tr '[:upper:]' '[:lower:]' | sha256_of /dev/stdin | cut -c1-16)
[ -z "$SLOT" ] && SLOT="default"

CACHE_BASE="${UCLAW_CACHE_BASE:-$HOME/Library/Caches}"
if [ ! -d "$CACHE_BASE" ]; then CACHE_BASE="${TMPDIR:-/tmp}"; fi
HOST_DIR="$CACHE_BASE/U-Claw/$SLOT/engine/$VERSION"
DRIVE_DIR="$ROOT/engine/$VERSION"

engine_ok() {
  local dir="$1"
  [ -f "$dir/manifest.json" ] || return 1
  [ -x "$dir/app/runtime/node-mac-arm64/bin/node" ] || return 1
  [ -f "$dir/app/core/node_modules/openclaw/openclaw.mjs" ] || return 1
  return 0
}

test_archive() {
  local sidecar="$ARCHIVE.sha256"
  [ -f "$sidecar" ] || return 0
  local expected actual
  expected=$(awk '{print $1}' "$sidecar" | tr '[:upper:]' '[:lower:]' | head -1)
  actual=$(sha256_of "$ARCHIVE" | tr '[:upper:]' '[:lower:]')
  if [ "$expected" != "$actual" ]; then
    note "engine archive checksum mismatch (expected ${expected%????????}, got ${actual%????????})"
    return 1
  fi
  return 0
}

install_engine() {
  test_archive || return 1
  local target="$1"
  local parent tmp lock
  parent=$(dirname "$target")
  mkdir -p "$parent" 2>/dev/null || { note "cannot create $parent"; return 1; }

  # Free-space precheck (~3.5x archive).
  local need_mb free_kb
  need_mb=$(( ($(wc -c < "$ARCHIVE") / 1048576) * 7 / 2 + 1 ))
  free_kb=$(df -Pk "$parent" 2>/dev/null | awk 'NR==2 {print $4}')
  if [ -n "${free_kb:-}" ] && [ "$free_kb" -lt $((need_mb * 1024)) ]; then
    note "not enough space on $parent: need ${need_mb}MB"
    return 1
  fi

  lock="$target.lock"
  if ! mkdir "$lock" 2>/dev/null; then
    note "another process is installing the engine; using the stick for this run"
    return 1
  fi

  tmp="$target.tmp-$$"
  rm -rf "$tmp" 2>/dev/null
  mkdir -p "$tmp" 2>/dev/null || { rmdir "$lock" 2>/dev/null; return 1; }
  if ! tar -xzf "$ARCHIVE" -C "$tmp" 2>/dev/null; then
    note "tar extraction failed"
    rm -rf "$tmp" 2>/dev/null; rmdir "$lock" 2>/dev/null
    return 1
  fi
  cat > "$tmp/manifest.json" <<JSON
{"schemaVersion":1,"product":"u-claw","version":"$VERSION","archive":"$(basename "$ARCHIVE")","installedAt":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"}
JSON
  printf '%s' "$VERSION" > "$tmp/OPENCLAW_VERSION"
  rm -rf "$target" 2>/dev/null
  if ! mv "$tmp" "$target" 2>/dev/null; then
    note "cannot move engine into place"
    rm -rf "$tmp" 2>/dev/null; rmdir "$lock" 2>/dev/null
    return 1
  fi
  rmdir "$lock" 2>/dev/null
  return 0
}

TARGET="$HOST_DIR"
SOURCE="existing"
[ "$MODE" = "drive" ] && TARGET="$DRIVE_DIR"

if ! engine_ok "$TARGET"; then
  if install_engine "$TARGET"; then
    SOURCE="installed"
  elif [ "$MODE" != "drive" ]; then
    TARGET="$DRIVE_DIR"
    if engine_ok "$TARGET" || install_engine "$TARGET"; then
      SOURCE="drive"
    else
      # The archive is right there but unusable (truncated / bad checksum). Falling
      # back to the loose tree would silently send the customer to an online setup,
      # so say it plainly and let the launcher stop with a real message.
      emit UCLAW_ENGINE_SOURCE broken
      emit UCLAW_ENGINE_ARCHIVE "$ARCHIVE"
      exit 0
    fi
  else
    emit UCLAW_ENGINE_SOURCE usb
    emit UCLAW_ENGINE_ROOT "$ROOT"
    exit 0
  fi
fi

emit UCLAW_ENGINE_SOURCE "$SOURCE"
emit UCLAW_ENGINE_MODE "$MODE"
emit UCLAW_ENGINE_ROOT "$TARGET"
emit UCLAW_NODE_BIN "$TARGET/app/runtime/node-mac-arm64/bin/node"
emit UCLAW_CORE_DIR "$TARGET/app/core"
emit UCLAW_APP_DIR "$TARGET/app"
exit 0
