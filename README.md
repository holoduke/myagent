# ARIA — Autonomous Reasoning & Insight Agent

An autonomous AI companion that runs 24/7, observes your WhatsApp messages and Gmail, maintains an associative memory graph, and proactively reaches out with insights. Built with TypeScript, Claude Code CLI, and a Nuxt dashboard.

## Architecture

```
┌─────────────────────────────────────────────────┐
│  Backend (Node.js / TypeScript)         :3000   │
│  ├── WhatsApp via Baileys (observe + send)      │
│  ├── Gmail via Google APIs (poll + send)        │
│  ├── Brain tick loop (observe/think/consolidate)│
│  ├── Claude Code CLI (reasoning engine)         │
│  ├── Associative memory graph                   │
│  └── HTTP API + WebSocket                       │
├─────────────────────────────────────────────────┤
│  Frontend (Nuxt 4)                      :3001   │
│  ├── Dashboard (system status, brain activity)  │
│  ├── Chat (interactive conversation)            │
│  ├── Memory Explorer (graph visualization)      │
│  ├── Integrations (WhatsApp, Gmail, SSH)        │
│  └── Settings (whitelist, config)               │
└─────────────────────────────────────────────────┘
```

## Prerequisites

- **Node.js 20+**
- **Claude Code CLI** — requires a Claude Max subscription
- **WhatsApp account** — for the Baileys connection
- **Docker** (for production deployment)

## Quick Start (Local Development)

### 1. Clone and install

```bash
git clone https://github.com/holoduke/myagent.git
cd myagent
npm install
cd frontend && npm install && cd ..
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env`:

```env
OWNER_PHONE=<your-phone-number-without-plus>
OWNER_NAME=<your-name>
WEB_PASSWORD=<pick-a-password>
GITHUB_REPO=<your-github-user>/<your-repo>

# Optional
BRAIN_ENABLED=true
```

### 3. Authenticate Claude Code CLI

```bash
claude auth login
```

Follow the OAuth flow. Credentials are stored in `~/.claude/`.

### 4. Start the backend

```bash
npm run dev
```

On first run, a QR code will appear in the terminal. Scan it with WhatsApp to pair.

The backend serves the API on `http://localhost:3000`.

### 5. Start the frontend

```bash
cd frontend
API_URL=http://localhost:3000 npm run dev
```

Dashboard available at `http://localhost:3001`.

## Docker Deployment

### Backend

```dockerfile
docker build -t aria-backend .
docker run -d \
  --name aria \
  -p 3000:3000 \
  -v aria-data:/data \
  --env-file .env \
  aria-backend
```

### Frontend

```dockerfile
cd frontend
docker build -t aria-frontend \
  --build-arg NUXT_API_URL=http://your-backend:3000 .
docker run -d \
  --name aria-dashboard \
  -p 3001:3000 \
  aria-frontend
```

### Persistent Data

All persistent data lives in `/data/` (mounted as a Docker volume):

| Path | Contents |
|------|----------|
| `/data/auth_state/` | WhatsApp session credentials |
| `/data/claude/` | Claude CLI credentials |
| `/data/brain/` | Memory graph, state, working memory |
| `/data/brain/graph/` | `nodes.json` and `edges.json` |
| `/data/brain/state.json` | Tick timestamps, counters, cost tracking |
| `/data/brain/working-memory.json` | Current context, mood, tracking |
| `/data/brain/observations.jsonl` | Raw message log (last 7 days) |
| `/data/gmail/` | Gmail account config and state |

## Coolify Deployment

The repo includes a GitHub Actions workflow (`.github/workflows/deploy.yml`) that auto-deploys to Coolify on push to `main`.

Required GitHub secrets:
- `COOLIFY_TOKEN` — Coolify API bearer token
- `COOLIFY_URL` — Coolify API base URL (e.g., `http://your-server:8000`)
- `COOLIFY_APP_UUID` — Backend app UUID in Coolify

Required GitHub variables:
- `COOLIFY_FRONTEND_APP_UUID` — Frontend app UUID (optional, skip if frontend not deployed separately)

## How the Brain Works

ARIA runs on a tick loop:

| Tick | Interval | What happens |
|------|----------|-------------|
| **Observe** | 60s | Buffer new WhatsApp/Gmail messages, reinforce known person nodes. No Claude call (free). |
| **Think** | 5 min (with new messages) | Spreading activation selects relevant memories. Claude processes observations, returns memory operations + optional message. |
| **Consolidate** | 4 hours | Exponential decay on all memories, weak nodes pruned, duplicate/orphan cleanup. |
| **Reflect** | 12 hours | Deep self-reflection, personality evolution, long-term planning. |

Memory is an associative graph of typed nodes (person, event, insight, fact, emotion, plan, goal, meta) connected by weighted edges. Old memories decay unless reinforced or pinned.

## Gmail Integration

1. Create OAuth credentials in [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
2. Add an account via the Integrations page in the dashboard
3. Authorize via the OAuth flow link
4. Emails are automatically polled and flow into the brain as observations

## SSH Integration

ARIA can manage SSH connections to remote servers:

1. A keypair is auto-generated on first use
2. Add the public key to your target servers
3. Manage targets via the Integrations page

## Self-Improvement

ARIA can modify her own source code via a worker architecture:

1. Creates a plan node in the memory graph
2. Writes a task to `/data/brain/improve-task.json`
3. A separate Claude process implements changes on a feature branch
4. Creates a PR for review
5. Merged PRs auto-deploy via Coolify

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OWNER_PHONE` | Yes | Your phone number (WhatsApp JID format, no +) |
| `OWNER_NAME` | Yes | Your name (used in prompts) |
| `WEB_PASSWORD` | Yes | Password for the dashboard |
| `GITHUB_REPO` | No | GitHub repo (e.g., `user/repo`) for self-improve PRs |
| `COOLIFY_TOKEN` | No | Coolify API token for deployment |
| `CLAUDE_TIMEOUT` | No | Claude CLI timeout in ms (default: 300000) |
| `BRAIN_ENABLED` | No | Enable autonomous brain (default: true) |
| `BRAIN_TICK_INTERVAL` | No | Observe tick interval in ms (default: 60000) |
| `BRAIN_MAX_MESSAGES_PER_DAY` | No | Max proactive messages per day (default: 5) |
| `BRAIN_QUIET_START` | No | Quiet hours start (default: 23) |
| `BRAIN_QUIET_END` | No | Quiet hours end (default: 7) |
| `BRAIN_MIN_MESSAGE_INTERVAL` | No | Min ms between proactive messages (default: 7200000) |

## Project Structure

```
src/
├── index.ts              # Entry point, HTTP server, WhatsApp setup
├── brain.ts              # Autonomous brain tick loop
├── brain-prompt.ts       # Think/consolidate/reflect prompt builders
├── aria-identity.ts      # Shared personality definition
├── system-prompt.ts      # Interactive chat system prompt
├── claude.ts             # Claude CLI wrapper
├── whatsapp.ts           # Baileys WhatsApp connection
├── gmail.ts              # Gmail API integration
├── ssh.ts                # SSH key management and connections
├── scheduler.ts          # Scheduled message delivery
├── observer.ts           # Message observation pipeline
├── self-improve.ts       # Self-modification worker
├── self-improve-prompt.ts # Self-improve/recovery prompts
├── memory/
│   ├── graph.ts          # Associative memory graph
│   ├── activation.ts     # Spreading activation algorithm
│   ├── decay.ts          # Memory decay and consolidation
│   ├── working-memory.ts # Short-term context management
│   └── types.ts          # Type definitions
└── web/
    ├── api.ts            # REST API endpoints
    └── auth.ts           # Session authentication

frontend/
├── app/
│   ├── pages/            # Dashboard, Chat, Memory, Integrations, Settings
│   ├── components/       # UI components
│   ├── composables/      # Shared logic (useApi, useAuth, useTimeAgo)
│   └── types/            # TypeScript types
└── server/
    └── api/              # Nuxt server proxy routes
```

## License

MIT
