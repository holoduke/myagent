# ARIA — Autonomous Reasoning & Insight Agent

A self-improving autonomous AI that runs 24/7 on your own infrastructure. ARIA observes your WhatsApp messages, Gmail, Google Calendar, Home Assistant devices, RSS feeds, and location — builds an associative memory graph, thinks on her own schedule, reaches out with insights, and can modify her own source code through a safe self-improvement pipeline.

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

## Quick Start

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
```

### 3. Authenticate Claude Code CLI

```bash
claude auth login
```

### 4. Start the backend

```bash
npm run dev
```

On first run, a QR code appears in the terminal — scan it with WhatsApp to pair. Backend serves on `http://localhost:3000`.

### 5. Start the frontend

```bash
cd frontend
API_URL=http://localhost:3000 npm run dev
```

Dashboard at `http://localhost:3001`.

## Docker Deployment

```bash
# Backend
docker build -t aria-backend .
docker run -d \
  --name aria \
  -p 3000:3000 \
  -v aria-data:/data \
  --env-file .env \
  aria-backend

# Frontend
cd frontend
docker build -t aria-frontend \
  --build-arg NUXT_API_URL=http://your-backend:3000 .
docker run -d \
  --name aria-dashboard \
  -p 3001:3000 \
  aria-frontend
```

### Persistent Data

All state lives in `/data/` (Docker volume):

| Path | Contents |
|------|----------|
| `/data/auth_state/` | WhatsApp session credentials |
| `/data/claude/` | Claude CLI credentials |
| `/data/brain/` | Memory graph, state, working memory, observations |
| `/data/gmail/` | Gmail account config and poll state |
| `/data/calendar/` | Calendar sync state |
| `/data/homeassistant/` | Home Assistant config and entity state |
| `/data/rss/` | RSS feed list and poll state |
| `/data/owntracks/` | OwnTracks location state |
| `/data/integrations-config.json` | Integration enable/disable toggles |

## Coolify Deployment

Auto-deploys on push to `main` via `.github/workflows/deploy.yml`.

Required GitHub secrets: `COOLIFY_TOKEN`, `COOLIFY_URL`, `COOLIFY_APP_UUID`

Optional GitHub variable: `COOLIFY_FRONTEND_APP_UUID` (if frontend is deployed separately)

## How the Brain Works

ARIA runs on a tick loop:

| Tick | Interval | What happens |
|------|----------|-------------|
| **Observe** | 60s | Buffer new messages, reinforce person nodes. No LLM call. |
| **Think** | 5 min | Spreading activation selects relevant memories. LLM processes observations, returns memory ops + optional message. |
| **Consolidate** | 4 hours | Exponential decay, weak node pruning, duplicate/orphan cleanup. |
| **Reflect** | 12 hours | Deep self-reflection, personality evolution, long-term planning. |

Memory is an associative graph of typed nodes (person, event, insight, fact, emotion, plan, goal, meta, concept) connected by weighted edges. Old memories decay unless reinforced or pinned.

## Integrations

All integrations can be enabled or disabled via toggle switches on the Integrations page. When disabled, backend polling stops and the tile appears dimmed. State persists across restarts.

| Integration | Description |
|-------------|-------------|
| **WhatsApp** | Primary communication channel. Observes messages, responds proactively or reactively. |
| **Gmail** | Polls email accounts via OAuth. New emails flow into the brain as observations. |
| **Google Calendar** | Polls upcoming events every 5 min using Gmail OAuth credentials. |
| **Home Assistant** | Monitors entity state changes via direct API or Nabu Casa cloud. |
| **RSS Feeds** | Polls RSS/Atom feeds every 15 min. New items become observations. |
| **OwnTracks** | Receives location updates for spatial awareness. |
| **SSH** | Auto-generated keypair, manage remote server targets. |
| **Scheduled** | Queue messages for future delivery. |

## Self-Improvement

ARIA autonomously modifies her own source code — this is a core part of the architecture.

During **reflect ticks**, ARIA identifies improvements and spawns a **detached worker process** that:

1. Creates a feature branch (`aria/<description>`)
2. Implements the change with full Claude tool access
3. Runs `tsc --noEmit` to verify
4. Pushes the branch and opens a GitHub PR
5. Merged PRs auto-deploy via Coolify

### Safety

- Worker is a **detached process** — can't crash the main app
- All changes go on **feature branches**, never directly to `main`
- PRs require human review before merge
- Worker cannot modify `self-improve.ts` or `entrypoint.sh`

### Crash Recovery

If ARIA crashes 3+ times in a row (tracked by boot counter):

1. Recovery worker diagnoses the crash from `agent.log`
2. Attempts up to 3 fixes via Claude
3. Falls back to reverting to last known good commit

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OWNER_PHONE` | Yes | Your phone number (WhatsApp JID format, no `+`) |
| `OWNER_NAME` | Yes | Your name (used in prompts) |
| `WEB_PASSWORD` | Yes | Dashboard password |
| `GITHUB_REPO` | No | GitHub repo for self-improve PRs (e.g. `user/repo`) |
| `GH_TOKEN` | No | GitHub PAT with repo scope for self-improve PRs |
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
