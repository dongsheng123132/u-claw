#!/bin/bash
# portable-cache-env.sh — portable-cache.mjs 的 shell 调用层（唯一解析器的出口）
#
# 用法（source，导出到当前 shell，供随后启动的子进程继承）：
#   . portable-cache-env.sh <STATE_DIR> <USB_ROOT> [NODE_BIN]
#   source portable-cache-env.sh <STATE_DIR> <USB_ROOT> [NODE_BIN]
# 单一契约：只认这三个位置参数（bash 的 source 支持传参）；NODE_BIN 未给时用 $NODE_BIN，
# 再缺则报错。不要另设环境变量输入通道。
#
# 成功：export 编译缓存 / npm 缓存 / 临时目录 / 日志目录 / 受管浏览器目录，返回 0。
# 失败（没有可写本机缓存）：清掉旧缓存变量、export NODE_DISABLE_COMPILE_CACHE=1、
# 向 stderr 打印错误，返回 1——调用方（Start/CLI/Doctor）据此中止，绝不回落 U 盘。
#
# 安全：绝不 eval 输出；逐行 KEY=VALUE 用 case 解析；node 的 stderr 不改道（自然可见）。

_uclaw_cache_env_run() {
    local state="$1"
    local usb="$2"
    local nodebin="${3:-${NODE_BIN:-}}"
    local dir
    dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

    if [ -z "$state" ] || [ -z "$nodebin" ]; then
        printf '  [portable-cache] usage: portable-cache-env.sh STATE_DIR USB_ROOT [NODE_BIN]\n' >&2
        unset NODE_COMPILE_CACHE npm_config_cache OPENCLAW_MANAGED_BROWSER_DIR UCLAW_CACHE_ROOT UCLAW_LOG_DIR UCLAW_TEMP_DIR
        export NODE_DISABLE_COMPILE_CACHE=1
        return 1
    fi

    # stdout+stderr 一起按行解析；非 KEY 行（即 node 的 stderr 警告）原样转到本 shell 的
    # stderr，绝不吞掉。是否成功只看 UCLAW_LOCAL_CACHE_AVAILABLE=1。
    local out
    out="$("$nodebin" "$dir/portable-cache.mjs" "$state" "$usb" 2>&1)"

    local avail=0 root='' compile='' npm='' tmp='' logs='' browser='' k v
    while IFS='=' read -r k v; do
        [ -n "$k" ] || continue
        case "$k" in
            UCLAW_CACHE_ROOT) root="$v" ;;
            UCLAW_COMPILE_CACHE_DIR) compile="$v" ;;
            UCLAW_NPM_CACHE_DIR) npm="$v" ;;
            UCLAW_TEMP_DIR) tmp="$v" ;;
            UCLAW_LOG_DIR) logs="$v" ;;
            UCLAW_MANAGED_BROWSER_DIR) browser="$v" ;;
            UCLAW_LOCAL_CACHE_AVAILABLE) [ "$v" = "1" ] && avail=1 ;;
            *) printf '  [portable-cache] %s\n' "$k" >&2 ;;
        esac
    done <<< "$out"

    if [ "$avail" != "1" ]; then
        printf '  [ERROR] no writable local cache directory (无可写本机缓存目录); refusing to fall back to the portable drive.\n' >&2
        unset NODE_COMPILE_CACHE npm_config_cache OPENCLAW_MANAGED_BROWSER_DIR UCLAW_CACHE_ROOT UCLAW_LOG_DIR UCLAW_TEMP_DIR
        export NODE_DISABLE_COMPILE_CACHE=1
        return 1
    fi

    export NODE_COMPILE_CACHE="$compile"
    export npm_config_cache="$npm"
    export TEMP="$tmp"
    export TMP="$tmp"
    export TMPDIR="$tmp"
    export SQLITE_TMPDIR="$tmp"
    export OPENCLAW_MANAGED_BROWSER_DIR="$browser"
    export UCLAW_CACHE_ROOT="$root"
    export UCLAW_LOG_DIR="$logs"
    export UCLAW_TEMP_DIR="$tmp"
    unset NODE_DISABLE_COMPILE_CACHE
    return 0
}

_uclaw_cache_env_run "$@"
_uclaw_cache_env_rc=$?
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
    return "$_uclaw_cache_env_rc"
else
    exit "$_uclaw_cache_env_rc"
fi
