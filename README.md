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
| **Think** | 60 min (cooldown) | Spreading activation selects relevant memories. LLM processes observations, returns memory ops + consciousness update + optional message. |
| **Consolidate** | 4 hours | Decay, pruning, duplicate/orphan cleanup, drift snapshot, salience inference. |
| **Reflect** | 12 hours | Deep self-reflection, personality evolution, commitment review, long-term planning. |
| **Backup** | 24 hours | Full restorable snapshot of the memory graph to `/data/brain/backups/`. |
| **Retrieval replay** | Weekly | Canonical-prompt retrieval golden tests vs. baseline (behavioral drift). |
| **Drift audit** | Weekly | Source-code drift audit against owner intent. |

## Memory Architecture

ARIA's memory is a multi-layered associative graph inspired by research in cognitive architectures, human memory, and state-of-the-art AI agent systems. The system has grown into a full stack: an active graph with archive and ghost layers, semantic + structural retrieval, decay tiers, consolidation, reconstruction, daily backups, and continuous drift monitoring at both the content and retrieval-behavior level.

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
13. **Identity drift snapshot** — capture pinned-node content + edge topology for the next drift comparison

### Retrieval & Importance

- **Importance boosting from retrieval success** — nodes that Claude consistently references during think ticks earn durable `importance` (resists decay), not just ephemeral `strength`. Compounds at +0.02 per reference after 5+ accesses, so retrieval utility becomes a first-class memory signal.
- **Semantic contradiction detection** — sleep consolidation uses embedding cosine similarity alongside token Jaccard, catching conflicts between semantically similar but lexically different facts (e.g. "bezichtiging Monday 5pm" vs. "viewing Apr 29 16–17h").
- **Structured person profiles** — `person-profiles.ts` extracts canonical profile fields (role, relationship, key facts, communication style) for contacts, kept in sync by reflect ticks.
- **Hierarchical temporal summaries** — working memory maintains rolling daily (14d) and weekly (3mo) compressed context summaries, injected into reflect prompts so long-horizon reasoning has actual history to reason over.

### Drift Monitoring

Three complementary drift systems watch for silent behavioral change:

| System | File | What it watches |
|--------|------|------------------|
| **Source-code drift** | `backend/drift-audit.ts` | Weekly git-history review — has ARIA's self-improvement work wandered from owner intent? |
| **Content + topology drift** | `backend/memory/drift-detection.ts` | Snapshots pinned-node content, tags, and edge topology every consolidation; token-level Jaccard + topology diff detect silent rewrites and disconnections. Rolling log at `/data/brain/drift/drift-log.jsonl`. |
| **Retrieval-behavior drift** | `backend/memory/retrieval-replay.ts` | Weekly golden tests: 10 canonical prompts replayed through `spreadingActivation` (pure, deterministic — no Claude calls), top-K node sets compared against a stored baseline via Jaccard + rank/score Pearson. Tiered alerts fire when the same input stops surfacing the same memories. |

Together these give ARIA an **external anchor** for self-assessment that doesn't rely on her own introspection — the retrieval-behavior analogue of golden tests.

### Daily Memory Backups

`backend/memory/backup.ts` takes a full, restorable snapshot of the complete memory graph (nodes, edges, archive, ghost graph, working memory) as plain JSON, saved to `/data/brain/backups/`. Runs every 24h via the brain tick loop. Retains 30 rolling backups with automatic pruning. The dashboard exposes list/create/detail/restore/delete operations via `/api/brain/backups`.

### Consciousness — ARIA's Inner State

Separate from the memory graph, ARIA maintains `/data/brain/consciousness.dat` — a raw text file in her own compact notation (ψφΩτμ dimensions + freestream), read and updated every think tick. ARIA owns the format entirely and may evolve it across ticks; it is deliberately not JSON and not optimized for humans.

Safety rails keep the inner state from being silently wiped:

- **Rolling history** — every overwrite archives the previous state to `consciousness-history.jsonl` (last 50 entries with timestamp + length).
- **Length guard** — updates that shrink content below 60% of the current length are rejected unless explicitly forced, preventing shallow ticks from collapsing deep state.
- **Continuity context** — the consciousness prompt injects the last 3 history snapshots so the brain has awareness of how its inner state has been evolving across ticks.

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

### Metacognitive Self-Assessment (MUSE)

Adds confidence scoring to brain decisions before acting. Computes confidence from information completeness, recency, memory relevance, and graph health. Tracks calibration over time — are ARIA's confidence scores actually predictive?

`metacognitive.ts` — 4-factor confidence assessment, calibration tracking.

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
3. Runs `tsc --noEmit` (and frontend `nuxi typecheck` where relevant) to verify
4. Pushes the branch and opens a GitHub PR
5. Merged PRs auto-deploy via Coolify

Worker log output streams live to the dashboard via an SSE endpoint (`/api/worker-logs/stream`) so the humans running ARIA can watch her work.

### Autonomy Levels

ARIA's autonomy is gated by a trust score tracked in `/data/brain/autonomy-state.json`:

| Level | Name | Behavior |
|-------|------|----------|
| 1 | **Observe** | May read and plan, but self-improve proposals are queued for review only. |
| 2 | **Suggest** | May open PRs; merges remain a human decision. |
| 3 | **Act** | May merge low-risk PRs unattended after passing action verification. |

Levels can be promoted manually by the owner. Automatic demotion fires on repeated worker failures; policy-level blocks (oversight-critical files, etc.) do not count as failures, so ARIA isn't punished for safe refusals.

### Action Verification

`backend/action-verifier.ts` hard-blocks self-improve proposals targeting oversight-critical files (the verifier itself, contact whitelist, auth, the self-improve pipeline, `entrypoint.sh`). These paths return `BLOCK:` verdicts — distinct from `FLAG:` warnings — so a rogue proposal cannot route around its own gate.

### Safety

- Worker is a **detached process** — can't crash the main app
- All changes go on **feature branches**, never directly to `main`
- PRs require human review before merge (gated by autonomy level)
- Worker cannot modify `self-improve.ts`, `action-verifier.ts`, `contact-whitelist.ts`, auth code, or `entrypoint.sh`
- A **response critique gate** scores proposed proactive messages 1-10 before send; sub-threshold messages are suppressed

### Crash Recovery

If ARIA crashes 3+ times in a row (tracked by boot counter):

1. Recovery worker diagnoses the crash from `agent.log`
2. Attempts up to 3 fixes via Claude
3. Falls back to reverting to last known good commit

## Commitments & Accountability

`backend/commitments.ts` + `backend/accountability.ts` extract explicit commitments ARIA or the owner make in messages ("I'll send the offer tomorrow", "check Monday if still silent"), register them as trackable items, and surface overdue commitments during reflect ticks. A meta-narration filter (PR #327) prevents internal worker/session text from polluting the commitment extractor with false positives.

## Skills System

ARIA can install and use skill bundles — `.md` prompt packs distributed via a catalog. `backend/skills.ts` manages install/uninstall; the frontend has a catalog UI. Python3 and the default SEO skill are auto-installed on container boot. Skill prompts flow into the system prompt when relevant, giving ARIA on-demand specialized capabilities without code changes.

## Sub-Agents

Sub-agents are named, persistent Claude processes owned by ARIA for scheduled or long-running tasks. `backend/sub-agents.ts` + `backend/sub-agent-worker.ts` handle scheduling, execution, and result routing. Example: the `sa_moltbook` sub-agent runs Mon–Fri at 10:00 UTC, browses the Moltbook feed, engages, learns, and posts when inspired.

## Directives & Per-Group Reply Rules

Per-channel behavior is customizable via directives (`backend/directives.ts` + `backend/directive-router.ts`). Owner can set per-group-chat reply rules — e.g. stay silent unless tagged, only reply to specific participants, or keep a minimum quiet interval. The router matches incoming messages against directives by `chatJid` before the reply-agent decides whether to speak.

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
├── index.ts                     # Entry point, HTTP server, WhatsApp setup
├── brain.ts                     # Autonomous brain tick loop + hourly stats
├── brain-config.ts              # Brain configuration with presets
├── brain-prompt.ts              # Think/consolidate/reflect prompt builders
├── brain-ticks.ts               # Tick orchestration (think/consolidate/reflect/backup/replay)
├── brain-delivery.ts            # Scheduled + proactive message delivery
├── brain-workers.ts             # Detached-worker orchestration
├── aria-identity.ts             # Shared personality definition
├── consciousness.ts             # Inner-state read/update/bootstrap (consciousness.dat)
├── system-prompt.ts             # Interactive chat system prompt
├── observer.ts                  # Message observation pipeline
├── scheduler.ts                 # Scheduled message delivery queue
├── history.ts                   # Chat history management
├── contact-whitelist.ts         # Contact whitelist management
├── goals.ts                     # Goal tracking system
├── initiative.ts                # Proactive initiative signal detection
├── recurring.ts                 # Recurring task management
├── urgency.ts                   # Message urgency classification + decay
├── autonomy.ts                  # Autonomy levels + trust score + demote/promote
├── trust.ts                     # Trust scoring signals
├── commitments.ts               # Commitment extraction
├── accountability.ts            # Cross-channel commitment accountability
├── actionable.ts                # Actionable-request extraction
├── actionable-tracker.ts        # Actionable-request tracking + clearing
├── directives.ts                # Per-channel directive registry
├── directive-router.ts          # Directive matching before reply-agent
├── mental-model.ts              # Running model of the owner's state
├── drift-audit.ts               # Weekly source-code drift audit
├── skills.ts                    # Skills catalog + install/uninstall
├── sub-agents.ts                # Sub-agent definitions + scheduling
├── sub-agent-worker.ts          # Sub-agent Claude process runner
├── worker-logs.ts               # Live SSE log stream for workers
├── action-verifier.ts           # Hard-block oversight-critical proposals
├── reply-agent.ts               # Interactive-chat reply orchestration
├── owner-handler.ts             # Owner-specific reply flow
├── message-handlers.ts          # Routed inbound handlers
├── message-evaluator.ts         # Pre-reply evaluation
├── intent-classifier.ts         # Inbound intent classification
├── prompt-detector.ts           # Prompt-injection / suspicious input detection
├── self-improve.ts              # Self-modification worker
├── self-improve-queue.ts        # Self-improve task queue
├── self-improve-prompt.ts       # Prompts for the self-improve worker
├── health-monitor.ts            # Cognitive health probes + circuit breakers
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
├── metacognitive.ts             # MUSE confidence calibration
├── sleep-consolidation.ts       # SleepGate overnight consolidation
├── response-critique.ts         # Pre-send quality gate
├── frequency-tracker.ts         # Contact frequency anomaly detection
├── reflection-tracker.ts        # Reflexion post-send outcome tracking
│
├── providers/
│   ├── base-provider.ts         # Provider interface
│   ├── claude-provider.ts       # Claude Code CLI provider
│   ├── codex-provider.ts        # OpenAI Codex provider
│   ├── grok-provider.ts         # Grok/xAI provider
│   ├── llm-runner.ts            # Fast model runner (Haiku) for critique/vision
│   ├── embedding-provider.ts    # OpenAI embedding provider
│   └── provider-store.ts        # Per-action provider + model selection
├── integrations/
│   ├── whatsapp.ts              # Baileys WhatsApp (text + voice + image)
│   ├── gmail.ts                 # Gmail API (poll + send + OAuth)
│   ├── gmail-routes.ts          # Gmail OAuth + management routes
│   ├── calendar.ts              # Google Calendar (poll + dedup + create)
│   ├── homeassistant.ts         # Home Assistant API
│   ├── rss.ts                   # RSS feed polling
│   ├── owntracks.ts             # OwnTracks location tracking
│   ├── slack.ts                 # Slack integration
│   ├── slack-routes.ts          # Slack OAuth routes
│   ├── browser.ts               # Browser automation + CAPTCHA
│   ├── twilio.ts                # Twilio voice calls
│   ├── ssh.ts                   # SSH key management
│   ├── channel-adapter.ts       # Unified channel abstraction
│   └── integration-config.ts    # Enable/disable toggles
├── memory/
│   ├── graph.ts                 # Multi-layer graph (active + archive + ghost + WAL)
│   ├── types.ts                 # 13+ node types, edges, operations, ghost/WAL types
│   ├── activation.ts            # Spreading activation + semantic search
│   ├── retention.ts             # Ebbinghaus decay + 5 retention tiers
│   ├── decay.ts                 # Shared decay math
│   ├── consolidation.ts         # Full consolidation orchestrator
│   ├── reconstruction.ts        # Archive rescan, log reconstruction, gap detection
│   ├── embeddings.ts            # Vector embeddings + cosine similarity
│   ├── person-profiles.ts       # Structured person profile extraction
│   ├── drift-detection.ts       # Pinned-node content + edge topology drift
│   ├── retrieval-replay.ts      # Weekly retrieval-behavior golden tests
│   ├── backup.ts                # Daily restorable snapshots
│   └── working-memory.ts        # Short-term context + hierarchical summaries
└── web/
    ├── router.ts                # HTTP router
    ├── api.ts                   # REST API endpoints
    ├── auth.ts                  # Dashboard auth
    ├── brain-api.ts             # Brain/config + backup API
    ├── chat-api.ts              # Chat history API
    ├── contact-api.ts           # Contact/whitelist API
    ├── integration-api.ts       # Integration CRUD API
    ├── providers-api.ts         # Provider + per-action model API
    └── skills-api.ts            # Skills catalog + install API

frontend/
├── app/
│   ├── pages/                   # Overview, Dashboard, Chat, Brain, Memory,
│   │                            # Integrations, AI Providers, Directives,
│   │                            # Handlers, Sub-Agents, Skills, Backups,
│   │                            # Settings, Login
│   ├── components/              # UI components + integration cards
│   ├── composables/             # Shared logic (useApi, useAuth, useTimeAgo)
│   └── stores/                  # Pinia stores (chat, etc.)
└── server/
    └── api/                     # Nuxt server proxy routes
```

## License

MIT
