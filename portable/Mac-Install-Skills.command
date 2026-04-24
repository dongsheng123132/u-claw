#!/bin/bash
# ============================================================
# U-Claw - Install Skills from ZIP (macOS)
# Double-click to install skills from skill_zip folder
# ============================================================

UCLAW_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILL_ZIP="$UCLAW_DIR/skill_zip"
SKILLS_TARGET="$UCLAW_DIR/data/.openclaw/workspace/skills"
TEMP_DIR="/tmp/uclaw-skill-install"

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo ""
echo -e "${CYAN}========================================${NC}"
echo -e "${CYAN}   Install Skills from ZIP${NC}"
echo -e "${CYAN}========================================${NC}"
echo ""

if [ ! -d "$SKILL_ZIP" ]; then
    echo -e "  ${RED}[ERROR] skill_zip folder not found${NC}"
    exit 1
fi

if [ ! -d "$SKILLS_TARGET" ]; then
    echo -e "  ${RED}[ERROR] OpenClaw skills folder not found${NC}"
    exit 1
fi

installed=0
skipped=0
failed=0

for zipfile in "$SKILL_ZIP"/*.zip; do
    if [ ! -f "$zipfile" ]; then
        continue
    fi

    filename=$(basename "$zipfile")
    echo -e "  ${CYAN}Processing:${NC} $filename"

    # Clean temp directory
    rm -rf "$TEMP_DIR"
    mkdir -p "$TEMP_DIR"

    # Extract ZIP
    unzip -q "$zipfile" -d "$TEMP_DIR"

    skill_md="$TEMP_DIR/SKILL.md"
    if [ ! -f "$skill_md" ]; then
        echo -e "    ${RED}[ERROR] Invalid ZIP - no SKILL.md${NC}"
        rm -rf "$TEMP_DIR"
        ((failed++))
        continue
    fi

    # Determine skill name from _meta.json or SKILL.md
    skill_name=""

    meta_path="$TEMP_DIR/_meta.json"
    if [ -f "$meta_path" ]; then
        skill_name=$(grep -o '"name"[[:space:]]*:[[:space:]]*"[^"]*"' "$meta_path" | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
        if [ -z "$skill_name" ]; then
            skill_name=$(grep -o '"slug"[[:space:]]*:[[:space:]]*"[^"]*"' "$meta_path" | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
        fi
    fi

    if [ -z "$skill_name" ]; then
        skill_name=$(grep -E '^slug:' "$skill_md" | head -1 | sed 's/slug:[[:space:]]*//' | tr -d '\r')
        if [ -z "$skill_name" ]; then
            skill_name=$(grep -E '^name:' "$skill_md" | head -1 | sed 's/name:[[:space:]]*//' | tr -d '\r')
        fi
    fi

    if [ -z "$skill_name" ]; then
        echo -e "    ${RED}[ERROR] Could not determine skill name${NC}"
        rm -rf "$TEMP_DIR"
        ((failed++))
        continue
    fi

    echo -e "    ${CYAN}Skill name:${NC} $skill_name"

    target_path="$SKILLS_TARGET/$skill_name"
    if [ -d "$target_path" ]; then
        echo -e "    ${YELLOW}[SKIP] Already installed: $skill_name${NC}"
        ((skipped++))
    else
        mkdir -p "$target_path"
        cp -r "$TEMP_DIR/"* "$target_path/"
        echo -e "    ${GREEN}[OK] Installed: $skill_name${NC}"
        ((installed++))
    fi

    rm -rf "$TEMP_DIR"
done

echo ""
echo -e "${CYAN}========================================${NC}"
echo -e "${CYAN}   Done${NC}"
echo -e "${CYAN}========================================${NC}"
echo -e "  ${GREEN}Installed:${NC} $installed"
echo -e "  ${YELLOW}Skipped:${NC}   $skipped"
echo -e "  ${RED}Failed:${NC}    $failed"
echo ""
echo -e "  ${CYAN}Restart OpenClaw to use new skills${NC}"
echo ""

read -p "  Press Enter to exit..."
