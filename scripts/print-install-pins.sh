#!/bin/bash
# Print the install-source pins for a release tag, ready to paste into the two
# online installers. Run this when cutting a release; see install/README.md.
#
#   scripts/print-install-pins.sh             # newest v* tag in this checkout
#   scripts/print-install-pins.sh v2.4.3      # an explicit tag
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
    TAG="$1"
elif git rev-parse --git-dir >/dev/null 2>&1; then
    TAG="$(git tag --sort=-v:refname | head -1)"
    [ -n "$TAG" ] || { echo "No tags in this checkout; pass a tag explicitly." >&2; exit 1; }
else
    echo "Not a git checkout and no tag given." >&2
    usage
fi

COMMIT=""
if git rev-parse --git-dir >/dev/null 2>&1 && git rev-parse -q --verify "refs/tags/$TAG" >/dev/null 2>&1; then
    COMMIT="$(git rev-parse "$TAG^{commit}")"
fi

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

TARBALL_URL="https://codeload.github.com/$SLUG/tar.gz/refs/tags/$TAG"
ZIP_URL="https://codeload.github.com/$SLUG/zip/refs/tags/$TAG"

echo "Downloading $TAG archives to compute digests..." >&2
curl -fSL --connect-timeout 20 --max-time 600 --retry 2 \
    "$TARBALL_URL" -o "$TMP_DIR/source.tar.gz" >&2
curl -fSL --connect-timeout 20 --max-time 600 --retry 2 \
    "$ZIP_URL" -o "$TMP_DIR/source.zip" >&2
TARBALL_SHA256="$(sha256_of "$TMP_DIR/source.tar.gz")"
ZIP_SHA256="$(sha256_of "$TMP_DIR/source.zip")"
ARCHIVE_ROOT="u-claw-${TAG#v}"

echo
echo "U-Claw install pins for $TAG"
[ -z "$COMMIT" ] || echo "  commit:  $COMMIT"
echo "  tarball: $TARBALL_URL"
echo "  zip:     $ZIP_URL"
echo "  root:    $ARCHIVE_ROOT/  (top-level directory inside both archives)"
echo
echo "install/install.sh"
echo "PINNED_UCLAW_VERSION=\"$TAG\""
echo "PINNED_UCLAW_SHA256=\"$TARBALL_SHA256\""
echo
echo "install/install.ps1"
echo "\$PinnedUclawVersion = '$TAG'"
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
SH_VERSION_LINE="$(sh_pin install/install.sh PINNED_UCLAW_VERSION)"
SH_SHA_LINE="$(sh_pin install/install.sh PINNED_UCLAW_SHA256)"
PS_VERSION_LINE="$(ps_pin install/install.ps1 PinnedUclawVersion)"
PS_SHA_LINE="$(ps_pin install/install.ps1 PinnedUclawSha256)"
echo
if [ "$SH_VERSION_LINE" = "$TAG" ] && [ "$SH_SHA_LINE" = "$TARBALL_SHA256" ] &&
   [ "$PS_VERSION_LINE" = "$TAG" ] && [ "$PS_SHA_LINE" = "$ZIP_SHA256" ]; then
    echo "The installers already pin $TAG."
else
    echo "The installers still pin:"
    echo "  install.sh  ${SH_VERSION_LINE:-<unset>}  ${SH_SHA_LINE:-<unset>}"
    echo "  install.ps1 ${PS_VERSION_LINE:-<unset>}  ${PS_SHA_LINE:-<unset>}"
    echo "Update both files before publishing the release."
fi
