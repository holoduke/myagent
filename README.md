# ARIA — Autonomous Reasoning & Insight Agent

An autonomous AI companion that observes your WhatsApp life, builds understanding of your world, and proactively shares insights. Not a chatbot — a thinking entity that runs 24/7, forms opinions, and reaches out when it has something worth saying.

## Quick Install

```bash
curl -fsSL https://raw.githubusercontent.com/holoduke/myagent/master/install.sh | bash
```

Requires Docker. Prompts for your phone number, name, and Anthropic API key.

## What ARIA Does

- **Observes** all WhatsApp text messages (private + group chats)
- **Thinks** autonomously — forms opinions, tracks social dynamics, notices patterns
- **Remembers** everything in an associative memory graph that persists across restarts
- **Reaches out** proactively when it has something worth saying
- **Reads email** via Gmail integration (OAuth)
- **Improves itself** — proposes and implements code changes via GitHub PRs

## How It Works

ARIA runs on a tick loop:

| Tick | Frequency | Purpose |
|------|-----------|---------|
| Observe | 60s | Buffer new messages, reinforce known contacts |
| Think | 5 min (with new messages) | Process observations, update memory, optionally message |
| Consolidate | 4 hours | Decay old memories, prune weak nodes, deduplicate |
| Reflect | 12 hours | Deep self-reflection, personality evolution, long-term planning |

## Manual Setup

```bash
git clone https://github.com/holoduke/myagent.git
cd myagent
cp .env.example .env    # edit with your config
docker compose up -d
```

Open `http://localhost:3000/qr` to scan the WhatsApp QR code.

## Configuration

Copy `.env.example` and set at minimum:

| Variable | Required | Description |
|----------|----------|-------------|
| `OWNER_PHONE` | Yes | Your WhatsApp number (international format) |
| `OWNER_NAME` | Yes | Your name |
| `CLAUDE_API_KEY` | Yes | Anthropic API key |
| `WEB_PASSWORD` | No | Dashboard password |

See `.env.example` for all options (brain tuning, integrations, self-improvement).

## Integrations

| Integration | Setup |
|-------------|-------|
| **WhatsApp** | Scan QR at `/qr` on first start |
| **Gmail** | Configure via web dashboard after start |
| **Home Assistant** | Set `HA_URL` + `HA_TOKEN` in .env |
| **RSS Feeds** | Add via web dashboard |
| **OwnTracks** | POST location to `/owntracks` |

## Running Locally vs. Cloud

ARIA works on a local machine (laptop/desktop), but a cloud server is recommended. Key differences:

| | Local | Cloud Server |
|---|---|---|
| **WhatsApp** | Works fine | Works fine |
| **Dashboard** | `localhost:3000` | Public URL |
| **Brain ticks** | Stop when machine sleeps/shuts down | Runs 24/7 |
| **Gmail OAuth** | Callback to `localhost` works during setup | Works with any domain |
| **OwnTracks** | Needs port forwarding or tunnel for phone to reach it | Reachable directly |
| **Self-improve PRs** | Works (needs internet) | Works |

**Localhost limitations:**
- **Must stay running** — ARIA is designed to run 24/7. If your machine sleeps, the WhatsApp connection drops, brain ticks stop, and you miss messages. It reconnects on wake, but gaps will exist.
- **OwnTracks/webhooks** — external services can't reach `localhost` without a tunnel (e.g. ngrok, Cloudflare Tunnel).
- **No remote dashboard** — you can only access the web UI from the same machine (unless you set up port forwarding).

**Recommended:** A small cloud VPS (Hetzner, DigitalOcean, etc.) with Docker. Coolify makes management easy.

## Architecture

- **Runtime**: Node.js 20 + TypeScript (tsx)
- **WhatsApp**: Baileys (open-source WhatsApp Web API)
- **AI**: Claude via Anthropic API
- **Memory**: JSON-based associative graph (`/data/brain/graph/`)
- **Web UI**: Vanilla JS dashboard on port 3000
- **Deployment**: Docker, designed for Coolify / self-hosted PaaS

## Data

All persistent data lives in `/data/` (Docker volume):

```
/data/
├── brain/           # Memory graph, config, observations
├── auth_state/      # WhatsApp session
├── gmail/           # Gmail OAuth state
└── claude/          # Claude credentials
```

## License

Private — not open source yet.
