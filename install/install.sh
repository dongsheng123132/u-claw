#!/bin/bash
# U-Claw online installation uses the same portable source and setup as USB.
# Usage: curl -fsSL https://u-claw.org/install.sh | bash
set -euo pipefail

NODE_VERSION="v24.16.0"
SOURCE_URL="https://codeload.github.com/dongsheng123132/u-claw/tar.gz/refs/heads/main"
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

echo "Downloading U-Claw portable source (Node.js $NODE_VERSION)..."
curl -fSL --connect-timeout 20 --max-time 180 --retry 2 --retry-max-time 240 \
    "$SOURCE_URL" -o "$WORK_DIR/source.tar.gz"
tar tzf "$WORK_DIR/source.tar.gz" > "$WORK_DIR/archive.list"
while IFS= read -r entry; do
    case "$entry" in u-claw-main|u-claw-main/*) ;; *)
        echo "Unexpected source archive path: $entry" >&2; exit 1 ;;
    esac
    case "$entry" in /*|../*|*/../*|*/..)
        echo "Unsafe source archive path" >&2; exit 1 ;;
    esac
done < "$WORK_DIR/archive.list"
mkdir "$WORK_DIR/extracted"
tar xzf "$WORK_DIR/source.tar.gz" -C "$WORK_DIR/extracted"
SOURCE_ROOT="$(cd "$WORK_DIR/extracted/u-claw-main" && pwd -P)"
case "$SOURCE_ROOT" in "$WORK_DIR"/extracted/u-claw-main) ;; *)
    echo "Source must remain inside this installation's temporary directory" >&2; exit 1 ;;
esac
SOURCE_PORTABLE="$SOURCE_ROOT/portable"
for required in setup.sh Mac-Install.command OPENCLAW_VERSION default-config.json lib/prepare-wallet.mjs; do
    [ -f "$SOURCE_PORTABLE/$required" ] || { echo "Incomplete portable source: $required" >&2; exit 1; }
done

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
