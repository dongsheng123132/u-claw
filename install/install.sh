#!/bin/bash
# U-Claw online installation uses the same portable source and setup as USB.
# Usage: curl -fsSL https://u-claw.org/install.sh | bash
#        bash install/install.sh --dry-run   # download + verify, install nothing
#
# The source archive is pinned to a released tag and its SHA-256 is checked
# before anything is unpacked, so this script never follows a mutable branch.
# Release checklist: install/README.md -> "发版时如何更新固定版本与校验和".
set -euo pipefail

NODE_VERSION="v24.22.1"

# --- Pinned install source -------------------------------------------------
# PINNED_UCLAW_VERSION  released tag the installer downloads.
# PINNED_UCLAW_SHA256   SHA-256 of the tar.gz behind that tag, i.e. of
#   https://codeload.github.com/OWNER/u-claw/tar.gz/refs/tags/<version>
# Both constants are updated together when a release is cut:
#   scripts/print-install-pins.sh <tag>
# UCLAW_VERSION may be overridden from the environment, but the digest is
# still enforced: an override without its own UCLAW_SHA256 fails closed below.
PINNED_UCLAW_VERSION="v2.4.3"
PINNED_UCLAW_SHA256="794cf4eba79b906564b15bba2de4e55cbe360648f50beb1733ba9f5206f974ed"
UCLAW_VERSION="${UCLAW_VERSION:-$PINNED_UCLAW_VERSION}"
UCLAW_SHA256="${UCLAW_SHA256:-$PINNED_UCLAW_SHA256}"
SOURCE_URL="https://codeload.github.com/dongsheng123132/u-claw/tar.gz/refs/tags/${UCLAW_VERSION}"

DRY_RUN="${UCLAW_DRY_RUN:-0}"
for arg in "$@"; do
    case "$arg" in
        --dry-run) DRY_RUN=1 ;;
        -h|--help)
            echo "Usage: bash install.sh [--dry-run]"
            echo "  --dry-run  download and verify the pinned archive, then stop before installing."
            exit 0
            ;;
        *) echo "Unknown argument: $arg" >&2; exit 2 ;;
    esac
done

OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS:$ARCH" in
    Darwin:arm64|Darwin:x86_64) ;;
    Linux:x86_64|Linux:aarch64|Linux:arm64) ;;
    *) echo "Unsupported system: $OS $ARCH" >&2; exit 1 ;;
esac
for tool in curl tar mktemp; do
    command -v "$tool" >/dev/null || { echo "Required command: $tool" >&2; exit 1; }
done

# A version override must carry its own digest, otherwise a local override
# would silently install unverified code.
if [ "$UCLAW_VERSION" != "$PINNED_UCLAW_VERSION" ] && [ "$UCLAW_SHA256" = "$PINNED_UCLAW_SHA256" ]; then
    echo "UCLAW_VERSION=$UCLAW_VERSION was overridden but UCLAW_SHA256 was not." >&2
    echo "Refusing to install an unverified archive. Print the digest for that tag with:" >&2
    echo "  scripts/print-install-pins.sh $UCLAW_VERSION" >&2
    exit 1
fi

sha256_of() {
    # Portable SHA-256 for the archive: sha256sum (Linux), shasum (macOS), openssl.
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | awk '{print $1}'
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$1" | awk '{print $1}'
    elif command -v openssl >/dev/null 2>&1; then
        openssl dgst -sha256 "$1" | awk '{print $NF}'
    else
        return 1
    fi
}

TEMP_ROOT="$(cd "${TMPDIR:-/tmp}" && pwd -P)"
WORK_DIR="$(mktemp -d "${TEMP_ROOT%/}/uclaw-source.XXXXXX")"
WORK_DIR="$(cd "$WORK_DIR" && pwd -P)"
cleanup_source() {
    # Only remove this invocation's verified directory inside the temp root.
    case "$WORK_DIR" in "$TEMP_ROOT"/uclaw-source.*)
        if [ -d "$WORK_DIR" ] && [ ! -L "$WORK_DIR" ] &&
           [ "$(cd "$WORK_DIR" && pwd -P)" = "$WORK_DIR" ]; then
            rm -rf -- "$WORK_DIR"
        fi
        ;;
    esac
}
trap cleanup_source EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo "Downloading U-Claw portable source $UCLAW_VERSION (Node.js $NODE_VERSION)..."
curl -fSL --connect-timeout 20 --max-time 180 --retry 2 --retry-max-time 240 \
    "$SOURCE_URL" -o "$WORK_DIR/source.tar.gz"

# Verify the digest before anything parses or unpacks the archive.
if ! ACTUAL_SHA256="$(sha256_of "$WORK_DIR/source.tar.gz")"; then
    echo "Cannot compute SHA-256: no sha256sum, shasum or openssl found." >&2
    exit 1
fi
if [ "$ACTUAL_SHA256" != "$UCLAW_SHA256" ]; then
    echo "Checksum mismatch: refusing to unpack the source archive." >&2
    echo "  source:   $SOURCE_URL" >&2
    echo "  expected: $UCLAW_SHA256" >&2
    echo "  actual:   $ACTUAL_SHA256" >&2
    echo "Nothing was installed. The download was corrupted or tampered with;" >&2
    echo "retry, and if it keeps failing the release pin has to be updated." >&2
    exit 1
fi
echo "Checksum verified: $UCLAW_SHA256"

# codeload names the archive root after the tag without its leading "v".
ARCHIVE_ROOT="u-claw-${UCLAW_VERSION#v}"
tar tzf "$WORK_DIR/source.tar.gz" > "$WORK_DIR/archive.list"
[ -s "$WORK_DIR/archive.list" ] || { echo "Empty source archive" >&2; exit 1; }
while IFS= read -r entry; do
    case "$entry" in /*)
        echo "Unsafe source archive path: $entry" >&2; exit 1 ;;
    esac
    entry="${entry%/}"
    [ -n "$entry" ] || continue
    IFS=/ read -r -a parts <<< "$entry"
    for part in "${parts[@]}"; do
        case "$part" in ''|.|..)
            echo "Unsafe source archive path: $entry" >&2; exit 1 ;;
        esac
    done
    [ "${parts[0]}" = "$ARCHIVE_ROOT" ] ||
        { echo "Unexpected source archive path: $entry (expected root $ARCHIVE_ROOT)" >&2; exit 1; }
done < "$WORK_DIR/archive.list"
mkdir "$WORK_DIR/extracted"
tar xzf "$WORK_DIR/source.tar.gz" -C "$WORK_DIR/extracted"
SOURCE_ROOT="$(cd "$WORK_DIR/extracted/$ARCHIVE_ROOT" && pwd -P)"
case "$SOURCE_ROOT" in "$WORK_DIR"/extracted/"$ARCHIVE_ROOT") ;; *)
    echo "Source must remain inside this installation's temporary directory" >&2; exit 1 ;;
esac
SOURCE_PORTABLE="$SOURCE_ROOT/portable"
for required in setup.sh Mac-Install.command OPENCLAW_VERSION default-config.json lib/prepare-wallet.mjs; do
    [ -f "$SOURCE_PORTABLE/$required" ] || { echo "Incomplete portable source: $required" >&2; exit 1; }
done

# Verification path only: used by the release checklist and by CI smoke tests.
if [ "$DRY_RUN" = "1" ]; then
    echo "Dry run: archive verified and unpacked, nothing installed."
    echo "  tag:      $UCLAW_VERSION"
    echo "  sha256:   $UCLAW_SHA256"
    echo "  root:     $ARCHIVE_ROOT"
    echo "  portable: $SOURCE_PORTABLE"
    echo "  contents: $(ls -A "$SOURCE_PORTABLE" | tr '\n' ' ')"
    exit 0
fi

if [ "$OS" = "Darwin" ]; then
    # The portable installer owns backup, local copy and startup for Mac.
    if [ -r /dev/tty ] && ( : < /dev/tty ) 2>/dev/null; then
        bash "$SOURCE_PORTABLE/Mac-Install.command" < /dev/tty
    else
        printf 'y\n\n' | bash "$SOURCE_PORTABLE/Mac-Install.command"
    fi
    exit 0
fi

# Linux keeps the full portable layout and shares the runtime/config actions.
HOME_ROOT="$(cd "$HOME" && pwd -P)"
INSTALL_TARGET="$HOME_ROOT/.uclaw"
[ ! -L "$INSTALL_TARGET" ] || { echo "Installation directory cannot be a symlink" >&2; exit 1; }
mkdir -p "$INSTALL_TARGET"
[ "$(cd "$INSTALL_TARGET" && pwd -P)" = "$HOME_ROOT/.uclaw" ] ||
    { echo "Unsafe installation directory" >&2; exit 1; }
BACKUP_DIR="$INSTALL_TARGET/data/backups/online-$(date +%Y%m%d-%H%M%S)-$$"
mkdir -p "$BACKUP_DIR"
for name in app core runtime; do
    if [ -e "$INSTALL_TARGET/$name" ]; then
        [ ! -L "$INSTALL_TARGET/$name" ] || { echo "Program directory cannot be a symlink: $name" >&2; exit 1; }
        mv -- "$INSTALL_TARGET/$name" "$BACKUP_DIR/$name"
    fi
done
for source in "$SOURCE_PORTABLE"/* "$SOURCE_PORTABLE"/.[!.]* "$SOURCE_PORTABLE"/..?*; do
    [ -e "$source" ] || continue
    name="${source##*/}"
    case "$name" in app|data) continue ;; esac
    if [ -e "$INSTALL_TARGET/$name" ]; then
        [ ! -L "$INSTALL_TARGET/$name" ] || { echo "Program file cannot be a symlink: $name" >&2; exit 1; }
        mv -- "$INSTALL_TARGET/$name" "$BACKUP_DIR/$name"
    fi
    cp -R -- "$source" "$INSTALL_TARGET/"
done
if [ -e "$INSTALL_TARGET/start.sh" ]; then
    mv -- "$INSTALL_TARGET/start.sh" "$BACKUP_DIR/start.sh"
fi
bash "$INSTALL_TARGET/setup.sh"

cat > "$INSTALL_TARGET/start.sh" << 'LINUX_START'
#!/bin/bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd -P)"
case "$(uname -m)" in
    x86_64) NODE_DIR="$DIR/app/runtime/node-linux-x64" ;;
    aarch64|arm64) NODE_DIR="$DIR/app/runtime/node-linux-arm64" ;;
    *) echo "Unsupported Linux architecture" >&2; exit 1 ;;
esac
NODE_BIN="$NODE_DIR/bin/node"
STATE_DIR="$DIR/data/.openclaw"
mkdir -p "$STATE_DIR"
export PATH="$NODE_DIR/bin:$PATH"
[ -x "$NODE_BIN" ] || bash "$DIR/setup.sh"

INSTANCE_STATUS=""
INSTANCE_PORT=""
while IFS='=' read -r key value; do
    case "$key" in
        UCLAW_INSTANCE_STATUS) INSTANCE_STATUS="$value" ;;
        UCLAW_INSTANCE_PORT) INSTANCE_PORT="$value" ;;
    esac
done < <("$NODE_BIN" "$DIR/lib/portable-instance-lock.mjs" acquire "$STATE_DIR" "$STATE_DIR" "$$")
if [ "$INSTANCE_STATUS" = "existing" ] || [ "$INSTANCE_STATUS" = "busy" ]; then
    echo "U-Claw is already running${INSTANCE_PORT:+ on port $INSTANCE_PORT}."
    exit 0
fi
CONFIG_PID=""
GW_PID=""
cleanup() {
    [ -z "$GW_PID" ] || kill "$GW_PID" 2>/dev/null || true
    [ -z "$CONFIG_PID" ] || kill "$CONFIG_PID" 2>/dev/null || true
    "$NODE_BIN" "$DIR/lib/portable-instance-lock.mjs" release "$STATE_DIR" "$STATE_DIR" "$$" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

REQUIREMENTS="$("$NODE_BIN" "$DIR/lib/runtime-requirements.mjs" "$DIR")"
if [ "$REQUIREMENTS" != "UCLAW_SETUP_NEEDED=0" ]; then
    bash "$DIR/setup.sh"
    [ "$("$NODE_BIN" "$DIR/lib/runtime-requirements.mjs" "$DIR")" = "UCLAW_SETUP_NEEDED=0" ] ||
        { echo "Runtime requirements are not satisfied" >&2; exit 1; }
fi
"$NODE_BIN" "$DIR/lib/prepare-wallet.mjs" "$DIR" "$STATE_DIR"
STRIP_ENV="$("$NODE_BIN" "$DIR/lib/strip-provider-env.mjs")"
STRIP_ENV="${STRIP_ENV#UCLAW_STRIP_ENV=}"
for name in ${STRIP_ENV//,/ }; do unset "$name"; done
export OPENCLAW_HOME="$DIR/data"
export OPENCLAW_STATE_DIR="$STATE_DIR"
export OPENCLAW_CONFIG_PATH="$STATE_DIR/openclaw.json"
export OPENCLAW_DISABLE_BONJOUR=1
export OPENCLAW_NO_AUTO_UPDATE=1
while IFS='=' read -r key value; do
    case "$key" in
        UCLAW_COMPILE_CACHE_DIR) export NODE_COMPILE_CACHE="$value" ;;
        UCLAW_MANAGED_BROWSER_DIR) export OPENCLAW_MANAGED_BROWSER_DIR="$value" ;;
    esac
done < <("$NODE_BIN" "$DIR/lib/portable-cache.mjs" "$STATE_DIR" "$DIR" 2>/dev/null)
NO_PROXY_LINE="$("$NODE_BIN" "$DIR/lib/resolve-no-proxy.mjs" "$OPENCLAW_CONFIG_PATH")"
case "$NO_PROXY_LINE" in UCLAW_NO_PROXY=*)
    export NO_PROXY="${NO_PROXY_LINE#UCLAW_NO_PROXY=}"
    export no_proxy="$NO_PROXY"
esac

rm -f -- "$STATE_DIR/runtime.json"
"$NODE_BIN" "$DIR/config-server/server.js" &
CONFIG_PID=$!
for attempt in {1..50}; do
    [ ! -f "$STATE_DIR/runtime.json" ] || break
    kill -0 "$CONFIG_PID" 2>/dev/null || { echo "Config server failed" >&2; exit 1; }
    sleep 0.2
done
[ -f "$STATE_DIR/runtime.json" ] || { echo "Config server startup timed out" >&2; exit 1; }
PORT="$("$NODE_BIN" -e '
const net = require("node:net");
function probe(port) {
  if (port > 18799) { console.error("No free gateway port"); process.exitCode = 1; return; }
  const server = net.createServer();
  server.once("error", () => probe(port + 1));
  server.listen(port, "127.0.0.1", () => server.close(() => console.log(port)));
}
probe(18789);
')"
"$NODE_BIN" "$DIR/lib/portable-instance-lock.mjs" publish "$STATE_DIR" "$STATE_DIR" "$$" "$PORT"
"$NODE_BIN" "$DIR/lib/runtime-ports.mjs" publish "$STATE_DIR" gateway "$PORT"
"$NODE_BIN" "$DIR/lib/clean-stale-lock.mjs" "$OPENCLAW_CONFIG_PATH" || true
"$NODE_BIN" "$DIR/lib/official-provider-guard.mjs" "$OPENCLAW_CONFIG_PATH" || true
cd "$DIR/app/core"
"$NODE_BIN" node_modules/openclaw/openclaw.mjs gateway run --allow-unconfigured --port "$PORT" &
GW_PID=$!
echo "Dashboard: http://127.0.0.1:$PORT/#token=uclaw"
echo "Open the Xiapan wallet in the dashboard sidebar to configure the model."
"$NODE_BIN" "$DIR/lib/prewarm.mjs" "$PORT" uclaw >/dev/null 2>&1 &
wait "$GW_PID"
LINUX_START
chmod +x "$INSTALL_TARGET/start.sh"
case "$ARCH" in x86_64) NODE_DIR_NAME="node-linux-x64" ;; *) NODE_DIR_NAME="node-linux-arm64" ;; esac
"$INSTALL_TARGET/app/runtime/$NODE_DIR_NAME/bin/node" \
    "$INSTALL_TARGET/lib/prepare-wallet.mjs" "$INSTALL_TARGET" "$INSTALL_TARGET/data/.openclaw"
echo "Installed: $INSTALL_TARGET"
echo "Previous program backup: $BACKUP_DIR"
echo "Start: bash \"$INSTALL_TARGET/start.sh\""
