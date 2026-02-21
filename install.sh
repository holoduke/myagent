#!/bin/bash
set -e

# ═══ ARIA Installer ═══
# Usage: curl -fsSL https://raw.githubusercontent.com/holoduke/myagent/master/install.sh | bash

REPO="holoduke/myagent"
BRANCH="master"
RAW="https://raw.githubusercontent.com/$REPO/$BRANCH"
INSTALL_DIR="${1:-$HOME/aria}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

info()  { echo -e "${CYAN}$1${NC}"; }
ok()    { echo -e "${GREEN}$1${NC}"; }
err()   { echo -e "${RED}$1${NC}" >&2; }

echo ""
echo -e "${BOLD}═══ ARIA — Autonomous Reasoning & Insight Agent ═══${NC}"
echo ""

# ── Check Docker ──
if ! command -v docker &>/dev/null; then
  err "Docker is not installed. Install it first: https://docs.docker.com/get-docker/"
  exit 1
fi

if ! docker compose version &>/dev/null && ! docker-compose version &>/dev/null; then
  err "Docker Compose is not installed. Install it first: https://docs.docker.com/compose/install/"
  exit 1
fi

# Pick compose command
if docker compose version &>/dev/null; then
  COMPOSE="docker compose"
else
  COMPOSE="docker-compose"
fi

ok "Docker found"

# ── Create install directory ──
info "Installing to $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"

# ── Download files ──
info "Downloading files..."
curl -fsSL "$RAW/docker-compose.yml" -o "$INSTALL_DIR/docker-compose.yml"
curl -fsSL "$RAW/Dockerfile"         -o "$INSTALL_DIR/Dockerfile"
curl -fsSL "$RAW/entrypoint.sh"      -o "$INSTALL_DIR/entrypoint.sh"
curl -fsSL "$RAW/package.json"       -o "$INSTALL_DIR/package.json"
curl -fsSL "$RAW/package-lock.json"  -o "$INSTALL_DIR/package-lock.json"
curl -fsSL "$RAW/tsconfig.json"      -o "$INSTALL_DIR/tsconfig.json"
curl -fsSL "$RAW/.env.example"       -o "$INSTALL_DIR/.env.example"

# Download src directory via git clone (sparse checkout for just what we need)
if [ -d "$INSTALL_DIR/src" ]; then
  info "Updating source..."
  rm -rf "$INSTALL_DIR/src"
fi
info "Downloading source code..."
git clone --depth 1 --branch "$BRANCH" "https://github.com/$REPO.git" "$INSTALL_DIR/.tmp-clone" 2>/dev/null
mv "$INSTALL_DIR/.tmp-clone/src" "$INSTALL_DIR/src"
rm -rf "$INSTALL_DIR/.tmp-clone"

chmod +x "$INSTALL_DIR/entrypoint.sh"
ok "Files downloaded"

# ── Configure .env ──
if [ -f "$INSTALL_DIR/.env" ]; then
  info "Existing .env found — keeping it"
else
  echo ""
  echo -e "${BOLD}Quick setup — press Enter to skip optional fields${NC}"
  echo ""

  read -rp "WhatsApp phone (international, e.g. 31612345678): " OWNER_PHONE
  read -rp "Your name: " OWNER_NAME
  read -rp "Anthropic API key: " CLAUDE_API_KEY
  read -rp "Web dashboard password (optional): " WEB_PASSWORD

  cp "$INSTALL_DIR/.env.example" "$INSTALL_DIR/.env"
  sed -i "s/^OWNER_PHONE=.*/OWNER_PHONE=$OWNER_PHONE/" "$INSTALL_DIR/.env"
  sed -i "s/^OWNER_NAME=.*/OWNER_NAME=$OWNER_NAME/" "$INSTALL_DIR/.env"
  sed -i "s/^CLAUDE_API_KEY=.*/CLAUDE_API_KEY=$CLAUDE_API_KEY/" "$INSTALL_DIR/.env"
  sed -i "s/^WEB_PASSWORD=.*/WEB_PASSWORD=$WEB_PASSWORD/" "$INSTALL_DIR/.env"

  ok ".env created"
fi

# ── Create data directory ──
mkdir -p "$INSTALL_DIR/data"

# ── Build and start ──
echo ""
info "Building and starting ARIA..."
cd "$INSTALL_DIR"
$COMPOSE up -d --build

echo ""
ok "═══ ARIA is running! ═══"
echo ""
echo -e "  Dashboard:  ${BOLD}http://localhost:3000${NC}"
echo -e "  QR code:    ${BOLD}http://localhost:3000/qr${NC}"
echo -e "  Install dir: $INSTALL_DIR"
echo ""
echo -e "  ${CYAN}Scan the QR code to connect WhatsApp.${NC}"
echo -e "  ${CYAN}Logs: cd $INSTALL_DIR && $COMPOSE logs -f${NC}"
echo ""
