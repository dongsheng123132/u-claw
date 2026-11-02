#!/bin/bash
# Print the install-source pins for a commit, ready to paste into the two
# online installers. Run this after a change lands on main; see install/README.md.
#
#   scripts/print-install-pins.sh             # HEAD of this checkout
#   scripts/print-install-pins.sh <commit>    # an explicit immutable commit
#
# The two digests are computed separately on purpose: install.sh installs the
# tar.gz and install.ps1 installs the zip. Never copy one onto the other.
set -euo pipefail

DEFAULT_SLUG="dongsheng123132/u-claw"

usage() {
    echo "Usage: scripts/print-install-pins.sh [tag]" >&2
    exit 2
}

case "${1:-}" in
    -h|--help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) usage ;;
esac

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
cd "$REPO_ROOT"

# Prefer the checkout's own remote; fall back to the upstream slug when this
# script is run from an unpacked release tarball (no .git).
SLUG="$DEFAULT_SLUG"
if git rev-parse --git-dir >/dev/null 2>&1; then
    if remote="$(git remote get-url origin 2>/dev/null)"; then
        remote="${remote%.git}"
        case "$remote" in
            *github.com[:/]*)
                candidate="${remote##*github.com[:/]}"
                [ -z "$candidate" ] || SLUG="$candidate"
                ;;
        esac
    fi
fi

if [ -n "${1:-}" ]; then
    REF="$1"
elif git rev-parse --git-dir >/dev/null 2>&1; then
    REF="$(git rev-parse -q --verify origin/main 2>/dev/null || git rev-parse HEAD)"
else
    echo "Not a git checkout and no commit given." >&2
    usage
fi
case "$REF" in
    *[!0-9a-f]*|'') echo "Refusing a non-commit ref '$REF': pin an immutable commit, not a branch or tag." >&2; exit 1 ;;
esac
[ ${#REF} -eq 40 ] || { echo "Refusing '$REF': pass a full 40-character commit SHA." >&2; exit 1; }

sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | awk '{print $1}'
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$1" | awk '{print $1}'
    elif command -v openssl >/dev/null 2>&1; then
        openssl dgst -sha256 "$1" | awk '{print $NF}'
    else
        echo "No sha256sum, shasum or openssl available." >&2
        return 1
    fi
}

TMP_BASE="${TMPDIR:-/tmp}"
TMP_BASE="${TMP_BASE%/}"
TMP_DIR="$(mktemp -d "$TMP_BASE/uclaw-pins.XXXXXX")" || exit 1
trap 'rm -rf "$TMP_DIR"' EXIT

TARBALL_URL="https://codeload.github.com/$SLUG/tar.gz/$REF"
ZIP_URL="https://codeload.github.com/$SLUG/zip/$REF"

echo "Downloading $REF archives to compute digests..." >&2
curl -fSL --connect-timeout 20 --max-time 600 --retry 2 \
    "$TARBALL_URL" -o "$TMP_DIR/source.tar.gz" >&2
curl -fSL --connect-timeout 20 --max-time 600 --retry 2 \
    "$ZIP_URL" -o "$TMP_DIR/source.zip" >&2
TARBALL_SHA256="$(sha256_of "$TMP_DIR/source.tar.gz")"
ZIP_SHA256="$(sha256_of "$TMP_DIR/source.zip")"
ARCHIVE_ROOT="u-claw-$REF"

echo
echo "U-Claw install pins for $REF"
echo "  tarball: $TARBALL_URL"
echo "  zip:     $ZIP_URL"
echo "  root:    $ARCHIVE_ROOT/  (top-level directory inside both archives)"
echo
echo "install/install.sh"
echo "PINNED_UCLAW_REF=\"$REF\""
echo "PINNED_UCLAW_SHA256=\"$TARBALL_SHA256\""
echo
echo "install/install.ps1"
echo "\$PinnedUclawRef = '$REF'"
echo "\$PinnedUclawSha256 = '$ZIP_SHA256'"
echo
echo "Then verify with: bash install/install.sh --dry-run"

# Remind the maintainer when a constant did not actually change.
sh_pin() {  # file, CONSTANT_NAME
    awk -F'"' -v want="$2=" '$1 == want { print $2; exit }' "$1" 2>/dev/null
}
ps_pin() {  # file, variable name without the leading $
    awk -F"'" -v want="\$$2 = " '$1 == want { print $2; exit }' "$1" 2>/dev/null
}
SH_REF_LINE="$(sh_pin install/install.sh PINNED_UCLAW_REF)"
SH_SHA_LINE="$(sh_pin install/install.sh PINNED_UCLAW_SHA256)"
PS_REF_LINE="$(ps_pin install/install.ps1 PinnedUclawRef)"
PS_SHA_LINE="$(ps_pin install/install.ps1 PinnedUclawSha256)"
echo
if [ "$SH_REF_LINE" = "$REF" ] && [ "$SH_SHA_LINE" = "$TARBALL_SHA256" ] &&
   [ "$PS_REF_LINE" = "$REF" ] && [ "$PS_SHA_LINE" = "$ZIP_SHA256" ]; then
    echo "The installers already pin $REF."
else
    echo "The installers still pin:"
    echo "  install.sh  ${SH_REF_LINE:-<unset>}  ${SH_SHA_LINE:-<unset>}"
    echo "  install.ps1 ${PS_REF_LINE:-<unset>}  ${PS_SHA_LINE:-<unset>}"
    echo "Update both files before publishing the release."
fi
