# ARIA — Autonomous Reasoning & Insight Agent

A self-improving autonomous AI that runs 24/7 on your own infrastructure. ARIA observes your WhatsApp messages, Gmail, Google Calendar, Home Assistant devices, RSS feeds, and location via OwnTracks — builds an associative memory graph, thinks on her own schedule, reaches out with insights, and can modify her own source code through a safe self-improvement architecture. No API keys, no usage limits, no corporate restrictions — she runs on Claude Code CLI with a Max subscription.

Built entirely as a Claw tool — powered by TypeScript, Claude Code CLI, and a Nuxt dashboard.

> **WARNING: THIS APP CAN DESTROY YOUR DIGITAL LIFE.** It is self-improving — it reads your messages, emails, calendar, and location, modifies its own source code, and acts autonomously 24/7. It might decide to turn against you. Run at your own risk.

## Architecture

```
┌─────────────────────────────────────────────────┐
│  Backend (Node.js / TypeScript)         :3000   │
│  ├── WhatsApp via Baileys (observe + send)      │
│  ├── Gmail via Google APIs (poll + send)        │
│  ├── Google Calendar (event tracking)           │
│  ├── Home Assistant (smart home monitoring)     │
│  ├── RSS Feeds (content ingestion)              │
│  ├── OwnTracks (location tracking)             │
│  ├── SSH (remote server management)             │
│  ├── Brain tick loop (observe/think/consolidate)│
│  ├── Multi-provider LLM (Claude/Codex/Grok)    │
│  ├── Associative memory graph                   │
│  └── HTTP API + WebSocket                       │
├─────────────────────────────────────────────────┤
│  Frontend (Nuxt 4)                      :3001   │
│  ├── Overview (system status at a glance)       │
│  ├── Dashboard (brain activity, stats)          │
│  ├── Chat (interactive conversation)            │
│  ├── Brain (goals, recurring tasks, signals)    │
│  ├── Memory Explorer (graph visualization)      │
│  ├── Integrations (8 services, toggle on/off)   │
│  ├── Agents (multi-provider LLM profiles)       │
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
| `/data/calendar/` | Calendar sync state |
| `/data/homeassistant/` | Home Assistant config and entity state |
| `/data/rss/` | RSS feed list and poll state |
| `/data/owntracks/` | OwnTracks location state |
| `/data/integrations-config.json` | Integration enable/disable toggles |

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

Memory is an associative graph of typed nodes (person, event, insight, fact, emotion, plan, goal, meta, concept) connected by weighted edges. Old memories decay unless reinforced or pinned.

## Integrations

All integrations can be enabled or disabled via toggle switches on the Integrations page. When disabled, backend polling stops and the tile appears dimmed. State persists across restarts in `/data/integrations-config.json`.

### Gmail

1. Create OAuth credentials in [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
2. Add an account via the Integrations page in the dashboard
3. Authorize via the OAuth flow link
4. Emails are automatically polled and flow into the brain as observations

### Google Calendar

Uses the same Google OAuth credentials as Gmail. Polls upcoming events every 5 minutes and records them as observations so ARIA is aware of your schedule.

### Home Assistant

Supports both direct API and Nabu Casa cloud connections. Configure via the Integrations page with your HA URL and long-lived access token. Monitors entity state changes (lights, switches, sensors, etc.) and reports them as observations.

### RSS Feeds

Add any RSS/Atom feed URL. Feeds are polled every 15 minutes. New items are recorded as observations, keeping ARIA up to date on topics you care about.

### OwnTracks

Receives location updates from the OwnTracks mobile app. ARIA gains spatial awareness — she knows where you are and can factor that into her reasoning.

### SSH

ARIA can manage SSH connections to remote servers:

1. A keypair is auto-generated on first use
2. Add the public key to your target servers
3. Manage targets via the Integrations page

### WhatsApp

The primary communication channel. ARIA observes incoming messages, processes them through the brain, and can respond proactively or reactively.

## Self-Improvement

ARIA can autonomously modify her own source code. This is not a toy feature — it's a core part of the architecture.

### How it works

During **reflect ticks** (every 12 hours), ARIA analyzes her own behavior, identifies improvements, and writes an improvement task:

1. ARIA creates a plan node in her memory graph describing the improvement
2. Writes the task to `/data/brain/improve-task.json`
3. The brain spawns a **detached worker process** (completely independent of the main app)
4. The worker gets full Claude tool access (Bash, Read, Write, Edit, Glob, Grep)
5. Worker creates a feature branch (`aria/<description>`), implements the change, runs `tsc --noEmit`
6. Worker pushes the branch and creates a GitHub PR
7. On the next brain tick, ARIA picks up the result and records it in her memory graph
8. Merged PRs auto-deploy via Coolify

### Safety guarantees

- Worker runs as a **detached process** — can't crash the main app
- All changes go on **feature branches**, never directly to `main`
- PRs require human review before merge
- Worker cannot modify `self-improve.ts` or `entrypoint.sh` (safety rules)
- `pendingSelfMod` flag prevents race conditions

### Crash recovery

If ARIA crashes 3+ times in a row (tracked by boot counter in `entrypoint.sh`):

1. Recovery worker is spawned in the background alongside normal startup
2. Worker reads the last 200 lines of agent.log to diagnose the crash
3. Attempts up to 3 fixes via Claude
4. Falls back to reverting to the last known good commit if fixes fail
5. Records everything in the memory graph

### Requirements for self-improvement

- `GITHUB_REPO` env var must be set (e.g., `user/myagent`)
- `GH_TOKEN` env var must be set (GitHub personal access token with repo scope)
- Claude Code CLI must be authenticated in the container

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OWNER_PHONE` | Yes | Your phone number (WhatsApp JID format, no +) |
| `OWNER_NAME` | Yes | Your name (used in prompts) |
| `WEB_PASSWORD` | Yes | Password for the dashboard |
| `GITHUB_REPO` | No | GitHub repo (e.g., `user/repo`) for self-improve PRs |
| `GH_TOKEN` | No | GitHub personal access token (repo scope) for self-improve PRs |
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
backend/
├── index.ts                # Entry point, HTTP server, WhatsApp setup
├── brain.ts                # Autonomous brain tick loop
├── brain-config.ts         # Brain configuration with presets
├── brain-prompt.ts         # Think/consolidate/reflect prompt builders
├── aria-identity.ts        # Shared personality definition
├── system-prompt.ts        # Interactive chat system prompt
├── claude.ts               # Claude CLI wrapper
├── observer.ts             # Message observation pipeline
├── scheduler.ts            # Scheduled message delivery
├── history.ts              # Chat history management
├── contact-whitelist.ts    # Contact whitelist management
├── goals.ts                # Goal tracking system
├── initiative.ts           # Proactive initiative signal detection
├── recurring.ts            # Recurring task management
├── urgency.ts              # Message urgency classification
├── self-improve.ts         # Self-modification worker
├── self-improve-queue.ts   # Self-improve task queue
├── self-improve-prompt.ts  # Self-improve/recovery prompts
├── queue.ts                # Message queue
├── providers/
│   ├── index.ts            # Provider registry
│   ├── claude-provider.ts  # Claude Code CLI provider
│   ├── codex-provider.ts   # OpenAI Codex provider
│   ├── grok-provider.ts    # Grok/xAI provider
│   ├── agent-store.ts      # Agent profile persistence
│   └── types.ts            # Provider type definitions
├── integrations/
│   ├── integration-config.ts # Enable/disable toggle config
│   ├── whatsapp.ts         # Baileys WhatsApp connection
│   ├── gmail.ts            # Gmail API integration
│   ├── gmail-routes.ts     # Gmail OAuth callback routes
│   ├── calendar.ts         # Google Calendar polling
│   ├── homeassistant.ts    # Home Assistant API integration
│   ├── rss.ts              # RSS feed polling
│   ├── owntracks.ts        # OwnTracks location tracking
│   └── ssh.ts              # SSH key management and connections
├── memory/
│   ├── graph.ts            # Associative memory graph
│   ├── activation.ts       # Spreading activation algorithm
│   ├── decay.ts            # Memory decay and consolidation
│   ├── working-memory.ts   # Short-term context management
│   └── types.ts            # Type definitions
└── web/
    ├── api.ts              # REST API endpoints
    ├── auth.ts             # Session authentication
    ├── router.ts           # Route handler
    ├── dashboard.ts        # Dashboard data aggregation
    ├── agents-api.ts       # Agent profile CRUD API
    └── styles.ts           # Embedded CSS

frontend/
├── app/
│   ├── pages/              # Overview, Dashboard, Chat, Brain, Memory,
│   │                       # Integrations, Agents, Settings, Login
│   ├── components/         # UI components
│   ├── composables/        # Shared logic (useApi, useAuth, useTimeAgo)
│   └── types/              # TypeScript types
└── server/
    └── api/                # Nuxt server proxy routes
```

## License

MIT
