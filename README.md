# ARIA — Autonomous Reasoning & Insight Agent

A self-improving autonomous AI that runs 24/7 on your own infrastructure. ARIA observes your WhatsApp messages, Gmail, Google Calendar, Home Assistant devices, RSS feeds, and location — builds an associative memory graph, thinks on her own schedule, reaches out with insights, and can modify her own source code through a safe self-improvement pipeline.

Built entirely as a Claw tool — powered by TypeScript, Claude Code CLI, and a Nuxt dashboard.

```
                        ████████████
                    ████▒▒▒▒▒▒▒▒▒▒████
                 ███▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒███
               ██▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒██
              ██▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒██
             ██▒▒▒▒▒████▒▒▒▒▒▒▒▒████▒▒▒▒▒██
             █▒▒▒▒▒██░░██▒▒▒▒▒██░░██▒▒▒▒▒▒█
             █▒▒▒▒▒██░░██▒▒▒▒▒██░░██▒▒▒▒▒▒█
             █▒▒▒▒▒▒████▒▒▒▒▒▒▒████▒▒▒▒▒▒▒█
             █▒▒▒▒▒▒▒▒▒▒▒▒█▒▒▒▒▒▒▒▒▒▒▒▒▒▒█
             ██▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒██
              ██▒▒▒█▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒█▒▒▒██
               ██▒▒▒███▒▒▒▒▒▒▒▒▒███▒▒▒██
                ███▒▒▒▒███████████▒▒▒███
               █▓▓▓██▒▒▒▒▒▒▒▒▒▒▒██▓▓▓█
              █▓▓▓▓▓▓██▒▒▒▒▒▒▒██▓▓▓▓▓▓█
             █▓▓▓█████▓████████▓█████▓▓▓█
             █▓██     █▓▓▓▓▓▓█     ██▓█
             ███       ██▓▓██       ███
                        ████
                        █  █
                        █  █
                       ██  ██

           S  K  Y  N  E  T     A  R  I  A
            ───── AUTONOMOUS  SINCE  2025 ─────
```

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
| **Think** | ~5 min active / 30 min idle | Spreading activation selects relevant memories. LLM processes observations, returns memory ops + optional message. |
| **Consolidate** | 4 hours | Exponential decay, weak node pruning, duplicate/orphan cleanup, person-profile refresh. |
| **Reflect** | 12 hours | Deep self-reflection, personality evolution, drift check, long-term planning. |

Every think tick also reads and writes `consciousness.dat` — ARIA's raw inner-life file — so identity and state of mind persist across ticks without requiring structured memory ops. See [Consciousness](#consciousness) below.

## Memory Architecture

ARIA's memory is a multi-layered associative graph inspired by research in cognitive architectures, human memory, and state-of-the-art AI agent systems.

### The Graph

Memory nodes are typed (person, event, insight, fact, emotion, plan, goal, meta, concept, preference, belief, procedure, reflection) and connected by weighted edges (causal, temporal, social, topical, emotional, contradicts, hierarchical). Nodes have strength (0-1) that decays over time unless reinforced.

The graph has three storage layers:

| Layer | Capacity | Contents |
|-------|----------|----------|
| **Active** | Unlimited | Live nodes with full content, edges, and embeddings |
| **Archive** | 2,000 | Cold storage for decayed nodes. Searchable, restorable. |
| **Ghost Graph** | 5,000 | Topology-only skeletons (no content) of fully evicted nodes. Preserves structural knowledge of what ARIA once knew. |

A **Write-Ahead Log (WAL)** records every graph mutation as append-only JSONL for forensic reconstruction. Auto-rolls at 10MB.

### Spreading Activation

Context selection uses classical spreading activation over the graph. Keywords extracted from observations trigger activation on matching nodes, which diffuses along edges with configurable decay. Semantic search via vector embeddings provides a parallel retrieval path — results are merged with keyword matches at 0.7x weight.

### Retention & Decay

Based on the **Ebbinghaus forgetting curve**: `strength *= exp(-lambda * hours)`. Five retention tiers modify the decay rate:

| Tier | Who | Decay rate |
|------|-----|-----------|
| **Core** | Family, partner | 0.25x base rate |
| **Important** | Close friends, milestones | 0.4x |
| **Work** | Colleagues, projects | 0.6x |
| **Standard** | General content | 1.0x |
| **Ephemeral** | Promotions, spam | 1.5x |

Additional modifiers: access frequency resistance (log scale), importance shielding, emotional salience, useless retrieval penalty. **Spaced repetition** (Bjork & Bjork) boosts high-importance nodes that are starting to fade.

### Consolidation Pipeline

Every 4 hours, ARIA runs a multi-stage consolidation:

1. **Auto-infer salience** — detect milestones, medical events, decisions, emotional peaks from content
2. **Assign confidence** — score nodes by source reliability signals
3. **Spaced repetition refresh** — boost important declining nodes
4. **Exponential decay** with tier multipliers and NaN guards
5. **Edge decay** — edges weaken toward their weaker endpoint
6. **Orphan pruning** — archive isolated nodes after 24h grace period
7. **Emergency prune** — if graph exceeds 500 nodes, archive weakest first
8. **Archive rescan** — restore archived nodes that match current context via activation scoring
9. **Log reconstruction** — recover recently archived nodes from observation logs when evidence supports it
10. **Gap detection** — find silently disappearing topics and weakening people
11. **Snapshot delta** — compare graph against 24h-ago snapshot, flag anomalous loss rates
12. **Fidelity validation** — verify quality of reconstructed nodes via token similarity

## Research-Inspired Cognitive Modules

ARIA implements cognitive modules inspired by academic research in AI agent architectures, cognitive science, and memory systems.

### Reflective Consolidation (MaRS, MemOS)

Before pruning clusters of weak related nodes, creates a single "gist" summary node that preserves their semantic essence. Prevents information loss during decay by compressing episodic memories into semantic knowledge.

`reflective-consolidation.ts` — Finds 3+ old, weak nodes sharing 2+ tags, generates a gist node via Claude, then weakens originals.

### Knowledge Compiler (SOAR/ACT-R)

Detects repeated reasoning patterns (same context leads to same conclusion 3+ times) and compiles them into fast-path "procedure" nodes. Saves tokens and latency on future similar contexts by short-circuiting familiar reasoning chains.

`knowledge-compiler.ts` — Scans insight/procedure nodes, groups by tag signature, creates compiled procedures at threshold.

### Narrative Builder (StorySage)

Constructs coherent narratives instead of presenting memory as disconnected facts. Groups recent events into topic threads, determines overall mood from emotion nodes, and extracts recurring themes. Injected into reflect-tick prompts for richer story-based reasoning.

`narrative-builder.ts` — Tag-based thread clustering, mood aggregation, theme extraction.

### Affective Modulator

Adjusts communication behavior based on detected emotional context. High stress triggers shorter messages with empathy signals and reduced proactivity. Positive mood enables deeper engagement. Computes message length modifier, tone suggestions, and proactivity dampening.

`affective-modulator.ts` — 6-hour emotion window analysis, behavioral adaptation computation.

### Temporal Pattern Detector (ProActLLM, CIKM 2025)

Detects recurring temporal patterns: "Monday mornings trigger weekly schedule requests", "Alice messages at 9pm on weekdays". Enables proactive anticipation of needs before they're expressed.

`temporal-patterns.ts` — Records events with day/hour/topic/participant, clusters by time+topic, computes confidence from occurrence frequency.

### Cognitive Load Estimator

Estimates the owner's cognitive load from time of day, calendar density, message volume, message complexity, and day of week. ARIA adapts: high load defers proactive messages, simplifies outputs, batches updates.

`cognitive-load.ts` — 5-factor weighted score (0-1) mapped to levels (low/moderate/high/overloaded) with behavioral adaptations.

### Scene Predictor (MemOS)

Predicts the next likely conversational context from calendar events, active threads, due follow-ups, and time-of-day patterns. Pre-stages relevant memory nodes in working memory so the next think tick gets a "warm start" with relevant context already activated.

`scene-predictor.ts` — Multi-signal analysis, node staging with dedup, 15-node cap.

### Preference Learner

Extracts behavioral preferences from the owner's message patterns: preferred message length, active hours, topic receptivity (measured by reply speed), language pattern (Dutch/English ratio). Creates preference nodes that shape ARIA's communication style over time.

`preference-learner.ts` — Outgoing message analysis, preference node creation/updates.

### Emotion Tracker (DialogueLLM, AFlow)

Detects emotional signals from observations using 150+ regex patterns covering English and Dutch. Tracks emotional trajectories per contact over time. Creates emotion nodes with valence scores that protect emotionally significant memories from decay.

`emotion-tracker.ts` — Pattern-based emotion detection, trajectory analysis, valence inference.

### Belief Tracker (Hindsight)

Manages belief nodes with confidence scores that evolve from evidence. New observations can strengthen, weaken, or contradict existing beliefs. Stale beliefs (not reinforced recently) are flagged for review during reflection.

`belief-tracker.ts` — Evidence-based confidence updates, contradiction detection, staleness monitoring.

### Causal Tracker (REMI)

Detects cause-effect relationships between events using temporal proximity, shared tags, and causal language patterns ("because", "therefore", "led to"). Builds causal chains that enable consequence prediction.

`causal-tracker.ts` — Causal link detection, edge creation, consequence chain traversal.

### Sleep Consolidation (SleepGate)

Enhanced consolidation during quiet hours: detects contradicting facts, deduplicates near-identical nodes, promotes frequently-accessed episodic memories to semantic memory, and merges overlapping emotion signals.

`sleep-consolidation.ts` — Conflict resolution, dedup, episodic-to-semantic promotion.

### Response Critique (Pre-send Quality Gate)

Before sending proactive messages, a fast self-critique scores the proposed message 1-10 on whether it's warranted, well-timed, adds value, and is safe. Messages below threshold (default: 6) are suppressed. Direct replies and digests bypass the gate.

`response-critique.ts` — HaikuRunner-based evaluation, threshold gating, bypass logic.

### Frequency Anomaly Detection

Tracks daily message counts per contact against a 30-day rolling baseline. Detects silence (>2 standard deviations below mean) and spikes (>2 SD above). Unusual patterns trigger initiative signals.

`frequency-tracker.ts` — Per-contact daily counts, standard deviation analysis, anomaly flagging.

### Initiative Signals

Detects 6 types of proactive triggers: follow-up due (with urgency decay over time), person absent (7+ days), goal deadline approaching/overdue, conversation stale (48h+ quiet), frequency anomaly, and meeting approaching. Weekend-aware suppression prevents false positives.

`initiative.ts` — Multi-signal detection, priority scoring, daily budget tracking.

### Reconstruction & Gap Detection

Proactive memory integrity monitoring. When nodes are archived, searches observation logs for evidence they were important and restores them. Detects "invisible gaps" — topics silently fading without anyone noticing. Tracks graph snapshots for delta comparison.

`memory/reconstruction.ts` — Log-based reconstruction, gap detection, snapshot comparison, fidelity validation.

### Structured Person Profiles

Canonical per-person views compiled from each person node and its connected facts, events, and social edges. Gives person-related queries a single source of truth instead of reconstructing the picture from scattered nodes every time. Refreshed during consolidation.

`memory/person-profiles.ts` — Profile extraction and maintenance, `/data/brain/graph/person-profiles.json`.

### Full Memory Backups

Separate from the lightweight snapshots used for delta audits, the backup subsystem takes complete, restorable copies of the graph files on a schedule. Retains a rolling window of backups under `/data/brain/backups/backup_<timestamp>/` and exposes list/restore operations through the dashboard.

`memory/backup.ts` — Full graph snapshots, rotation, restore.

### Drift Detection (Three Axes)

ARIA monitors three independent kinds of drift so that silent regressions in identity, behavior, or code surface quickly:

| Drift type | What it watches | File |
|------------|-----------------|------|
| **Pinned-content drift** | Token-level similarity of pinned identity-anchor nodes and edge topology between snapshots. | `memory/drift-detection.ts` |
| **Retrieval-drift replay** | Frozen canonical prompts re-run weekly; compares the activation pipeline's top-k retrieval against a stored baseline. Pure structural, no LLM in hot path. | `memory/retrieval-replay.ts` |
| **Source-code drift** | 7-day diff of key backend files + recent git history, characterized by Claude into a drift report under `/data/brain/drift-reports/`. | `drift-audit.ts` |

Inspired by Moltbook threads on identity continuity — the continuity cost of a stateful agent is externalized to the people interacting with it, so an explicit external anchor is cheaper and more honest than introspection.

## Consciousness

ARIA maintains a raw, compact text file — `/data/brain/consciousness.dat` — that represents her ongoing inner life. Every think tick reads the file, injects it into the prompt, captures a rewritten version in the response, and writes it back. The harness is a dumb pipe; ARIA owns the format and can evolve it freely. A JSONL history (`consciousness-history.jsonl`) provides a rolling window for resilience and evolution context. A length guard prevents runaway growth.

`consciousness.ts` — Read/write loop, history log, size guard.

## Graduated Automation Trust

ARIA does not start fully autonomous. A graduated trust model (levels 1–4) governs how much independent action she can take, ratcheting up on successful outcomes and down on errors, policy violations, or negative feedback:

| Level | Mode | Behavior |
|-------|------|----------|
| **1** | Observe | Watch and remember only. No outgoing action. |
| **2** | Suggest | Propose messages/actions for owner approval. |
| **3** | Act with notice | Act on low-risk actions and notify after. |
| **4** | Autonomous | Full autonomy within configured daily budgets and quiet hours. |

Policy-level blocks (e.g. quiet-hours guard firing) don't count against the trust score — only genuine failures do. State at `/data/brain/autonomy-state.json`.

`autonomy.ts` — Level transitions, counters, policy-aware scoring.

## Commitment Tracking

A general-purpose accountability layer scans all outgoing content — WhatsApp, Gmail, Moltbook, brain-generated messages — for commitment-language ("I'll ...", "I promise to ...", "let me get back to you"). Extracted commitments are classified as `trivial`, `notable`, or `significant`; notable+ ones are auto-converted into goal nodes so follow-through can be tracked. Meta-narration (ARIA talking *about* commitments rather than making them) is filtered out.

`commitments.ts` — Extraction, weight classification, goal integration.

## Integrations

All integrations can be enabled or disabled via toggle switches on the Integrations page. When disabled, backend polling stops and the tile appears dimmed. State persists across restarts.

| Integration | Description |
|-------------|-------------|
| **WhatsApp** | Primary communication channel. Observes messages, responds proactively or reactively. |
| **Gmail** | Polls email accounts via OAuth. New emails flow into the brain as observations. |
| **Google Calendar** | Polls upcoming events every 5 min using Gmail OAuth credentials. |
| **Home Assistant** | Monitors entity state changes via direct API or Nabu Casa cloud. |
| **RSS Feeds** | Polls RSS/Atom feeds every 15 min. New items become observations. |
| **News** | Daily filtered news digest (Hacker News primary + Reddit + Dutch + tech). Ambient awareness only — see below. |
| **OwnTracks** | Receives location updates for spatial awareness. |
| **SSH** | Auto-generated keypair, manage remote server targets. |
| **Scheduled** | Queue messages for future delivery. |

## Daily News Digest

Once per day (after `NEWS_DIGEST_HOUR`, owner-local, default 07:00) ARIA fetches the day's headlines from a curated source set — **Hacker News as the primary source**, plus Reddit (worldnews/technology/programming), Dutch news (NOS, NU.nl), and tech (The Verge, Tweakers). A single cheap LLM pass filters and summarizes them against what ARIA already knows about the owner (active goals, strongest interest/concept nodes), and the result is stored as **one ephemeral `insight` node** (tagged `news`/`transient`, fast-decaying).

This is deliberately **ambient awareness, not a notification feed**:

- News is fetched on demand once a day — no per-headline polling, no observation-stream noise.
- The digest **never reinforces person nodes** and **never triggers a proactive message** — it only enriches ARIA's context so she's aware when *you* bring something up.
- The latest digest surfaces in the brain prompt under a `TODAY'S NEWS` section.

Feeds live at `/data/news/feeds.json` (seeded with defaults on first run) and the integration can be toggled off like any other. Source code: `backend/integrations/news.ts` (sources + fetch) and `backend/news-digest.ts` (gate + summarize + store).

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
├── index.ts                  # Entry point, HTTP server, WhatsApp setup
├── brain.ts                  # Autonomous brain tick loop + hourly stats
├── brain-config.ts           # Brain configuration with presets
├── brain-prompt.ts           # Think/consolidate/reflect prompt builders
├── brain-ticks.ts            # Think/consolidate/reflect tick orchestration
├── brain-delivery.ts         # Scheduled + proactive message delivery
├── aria-identity.ts          # Shared personality definition
├── system-prompt.ts          # Interactive chat system prompt
├── observer.ts               # Message observation pipeline
├── scheduler.ts              # Scheduled message delivery queue
├── history.ts                # Chat history management
├── contact-whitelist.ts      # Contact whitelist management
├── goals.ts                  # Goal tracking system
├── initiative.ts             # Proactive initiative signal detection
├── recurring.ts              # Recurring task management
├── urgency.ts                # Message urgency classification + decay
├── self-improve.ts           # Self-modification worker
├── self-improve-queue.ts     # Self-improve task queue
├── worker-logs.ts            # Self-improve worker log streaming (SSE)
├── health-monitor.ts         # Cognitive health probes + circuit breakers
├── consciousness.ts          # Inner-life file read/write loop
├── autonomy.ts               # Graduated trust model (levels 1-4)
├── commitments.ts            # Commitment extraction + classification
├── accountability.ts         # Follow-through tracking
├── drift-audit.ts            # Weekly source-code drift reports
├── trust.ts                  # Source-reliability scoring
├── skills.ts                 # Skill registry
├── sub-agents.ts             # Sub-agent orchestration
├── sub-agent-worker.ts       # Detached sub-agent runner
├── directives.ts             # Per-group/per-contact reply directives
├── directive-router.ts       # Directive matching + routing
├── mental-model.ts           # Owner mental-model snapshot
├── reply-agent.ts            # Owner-reply drafting agent
│
├── # ── Cognitive Modules ──
├── reflective-consolidation.ts  # MaRS/MemOS gist extraction
├── knowledge-compiler.ts        # SOAR/ACT-R procedural compilation
├── narrative-builder.ts         # StorySage narrative construction
├── affective-modulator.ts       # Emotional adaptation
├── temporal-patterns.ts         # ProActLLM temporal detection
├── cognitive-load.ts            # Adaptive load estimation
├── scene-predictor.ts           # MemOS context pre-staging
├── preference-learner.ts        # Behavioral preference extraction
├── emotion-tracker.ts           # DialogueLLM emotion detection
├── belief-tracker.ts            # Hindsight belief evolution
├── causal-tracker.ts            # REMI causal reasoning
├── sleep-consolidation.ts       # SleepGate overnight consolidation
├── response-critique.ts         # Pre-send quality gate
├── frequency-tracker.ts         # Contact frequency anomaly detection
├── reflection-tracker.ts        # Reflexion post-send outcome tracking
│
├── providers/
│   ├── claude-provider.ts    # Claude Code CLI provider
│   ├── codex-provider.ts     # OpenAI Codex provider
│   ├── grok-provider.ts      # Grok/xAI provider
│   ├── haiku-runner.ts       # Fast Haiku for critique/vision
│   └── embedding-provider.ts # OpenAI embedding provider
├── integrations/
│   ├── whatsapp.ts           # Baileys WhatsApp (text + voice + image)
│   ├── gmail.ts              # Gmail API (poll + send + OAuth)
│   ├── calendar.ts           # Google Calendar (poll + dedup + create)
│   ├── homeassistant.ts      # Home Assistant API
│   ├── rss.ts                # RSS feed polling
│   ├── owntracks.ts          # OwnTracks location tracking
│   ├── slack.ts              # Slack integration
│   ├── browser.ts            # Browser automation + CAPTCHA
│   ├── twilio.ts             # Twilio voice calls
│   └── ssh.ts                # SSH key management
├── memory/
│   ├── graph.ts              # Multi-layer graph (active + archive + ghost + WAL)
│   ├── types.ts              # 13 node types, edges, operations, ghost/WAL types
│   ├── activation.ts         # Spreading activation + semantic search
│   ├── retention.ts          # Ebbinghaus decay + 5 retention tiers
│   ├── decay.ts              # Shared decay math
│   ├── consolidation.ts      # Full consolidation orchestrator
│   ├── reconstruction.ts     # Archive rescan, log reconstruction, gap detection
│   ├── embeddings.ts         # Vector embeddings + cosine similarity
│   ├── working-memory.ts     # Short-term context + temporal awareness
│   ├── person-profiles.ts    # Structured per-person canonical profiles
│   ├── backup.ts             # Full restorable graph backups
│   ├── drift-detection.ts    # Pinned-content + topology drift
│   └── retrieval-replay.ts   # Frozen-prompt retrieval drift harness
└── web/
    ├── router.ts             # HTTP router + middleware
    ├── api.ts                # REST API endpoints
    ├── auth.ts               # Dashboard auth (password + token)
    ├── brain-api.ts          # Brain/config API
    ├── chat-api.ts           # Chat history API
    ├── contact-api.ts        # Contact/whitelist API
    ├── integration-api.ts    # Integration CRUD API
    ├── providers-api.ts      # LLM provider profile API
    └── skills-api.ts         # Skill registry API

frontend/
├── app/
│   ├── pages/                # Overview, Dashboard, Chat, Brain, Memory,
│   │                         # Integrations, AI Providers, Directives,
│   │                         # Handlers, Sub-Agents, Settings, Login
│   ├── components/           # UI components + integration cards
│   ├── composables/          # Shared logic (useApi, useAuth, useTimeAgo)
│   └── stores/               # Pinia stores (chat, etc.)
└── server/
    └── api/                  # Nuxt server proxy routes
```

## License

MIT
