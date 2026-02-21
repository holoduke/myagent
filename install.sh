#!/bin/bash
set -euo pipefail

# ═══ ARIA Installer ═══
# Usage: curl -fsSL https://raw.githubusercontent.com/holoduke/myagent/master/install.sh | bash

main() {
  REPO="holoduke/myagent"
  BRANCH="master"
  RAW="https://raw.githubusercontent.com/$REPO/$BRANCH"
  INSTALL_DIR="${1:-$HOME/aria}"

  # Colors (disabled if not a terminal)
  if [ -t 1 ] 2>/dev/null || [ -t 0 ] 2>/dev/null; then
    RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
  else
    RED=''; GREEN=''; CYAN=''; BOLD=''; NC=''
  fi

  info()  { printf '%b\n' "${CYAN}$1${NC}"; }
  ok()    { printf '%b\n' "${GREEN}$1${NC}"; }
  err()   { printf '%b\n' "${RED}$1${NC}" >&2; }

  # Cleanup on failure
  cleanup() { rm -rf "${INSTALL_DIR:?}/.tmp-clone"; }
  trap cleanup EXIT

  printf '\n'
  printf '%b\n\n' "${BOLD}═══ ARIA — Autonomous Reasoning & Insight Agent ═══${NC}"

  # ── Check prerequisites ──
  if ! command -v docker &>/dev/null; then
    err "Docker is not installed. Install it first: https://docs.docker.com/get-docker/"
    exit 1
  fi
  if ! command -v git &>/dev/null; then
    err "Git is not installed. Install it first: https://git-scm.com/downloads"
    exit 1
  fi
  if ! command -v curl &>/dev/null; then
    err "curl is not installed."
    exit 1
  fi

  if docker compose version &>/dev/null; then
    COMPOSE="docker compose"
  elif docker-compose version &>/dev/null; then
    COMPOSE="docker-compose"
  else
    err "Docker Compose is not installed. Install it first: https://docs.docker.com/compose/install/"
    exit 1
  fi

  ok "Prerequisites found (docker, git, curl)"

  # ── Create install directory ──
  info "Installing to $INSTALL_DIR"
  mkdir -p "$INSTALL_DIR"

  # ── Download files ──
  info "Downloading files..."
  for f in docker-compose.yml Dockerfile entrypoint.sh package.json package-lock.json tsconfig.json .env.example; do
    if ! curl -fsSL "$RAW/$f" -o "$INSTALL_DIR/$f"; then
      err "Failed to download $f"
      exit 1
    fi
  done

  # Download src directory via shallow clone
  if [ -d "$INSTALL_DIR/src" ]; then
    info "Updating source..."
    rm -rf "$INSTALL_DIR/src"
  fi
  info "Downloading source code..."
  if ! git clone --depth 1 --branch "$BRANCH" "https://github.com/$REPO.git" "$INSTALL_DIR/.tmp-clone"; then
    err "Failed to clone repository. Check your network connection."
    exit 1
  fi
  mv "$INSTALL_DIR/.tmp-clone/src" "$INSTALL_DIR/src"
  rm -rf "$INSTALL_DIR/.tmp-clone"

  chmod +x "$INSTALL_DIR/entrypoint.sh"
  ok "Files downloaded"

  # ── Configure .env ──
  if [ -f "$INSTALL_DIR/.env" ]; then
    info "Existing .env found — keeping it"
  else
    printf '\n'
    printf '%b\n\n' "${BOLD}Quick setup — press Enter to skip optional fields${NC}"

    # Read from /dev/tty so prompts work when piped via curl | bash
    read -rp "WhatsApp phone (international, e.g. 31612345678): " OWNER_PHONE </dev/tty
    read -rp "Your name: " OWNER_NAME </dev/tty
    read -rsp "Anthropic API key: " CLAUDE_API_KEY </dev/tty
    printf '\n'
    read -rp "Web dashboard password (optional): " WEB_PASSWORD </dev/tty

    if [ -z "$CLAUDE_API_KEY" ]; then
      err "Anthropic API key is required. Get one at https://console.anthropic.com/"
      exit 1
    fi

    # Write .env directly (avoids sed portability issues)
    {
      echo "# ARIA Configuration"
      echo "OWNER_PHONE=$OWNER_PHONE"
      echo "OWNER_NAME=$OWNER_NAME"
      echo "CLAUDE_API_KEY=$CLAUDE_API_KEY"
      echo "WEB_PASSWORD=$WEB_PASSWORD"
    } > "$INSTALL_DIR/.env"

    ok ".env created"
  fi

  # ── Create data directory ──
  mkdir -p "$INSTALL_DIR/data"

  # ── Build and start ──
  printf '\n'
  info "Building and starting ARIA (this may take a few minutes)..."
  cd "$INSTALL_DIR"
  $COMPOSE up -d --build

  printf '\n'
  ok "═══ ARIA is running! ═══"
  printf '\n'
  printf '  Dashboard:   %b\n' "${BOLD}http://localhost:3000${NC}"
  printf '  QR code:     %b\n' "${BOLD}http://localhost:3000/qr${NC}"
  printf '  Install dir: %s\n' "$INSTALL_DIR"
  printf '\n'
  printf '  %b\n' "${CYAN}Scan the QR code to connect WhatsApp.${NC}"
  printf '  %b\n\n' "${CYAN}Logs: cd \"$INSTALL_DIR\" && $COMPOSE logs -f${NC}"
}

main "$@"
