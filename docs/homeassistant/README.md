# Home Assistant ↔ ARIA

How the house talks to the agent on Hetzner, how the agent talks back, and how
the first reflex (silver IKEA STYRBAR → spoken weather on the WiiM) works.

## Architecture

```
 Home Assistant (LAN)                          ARIA (Hetzner)
 ┌──────────────────────┐   POST /homeassistant/event   ┌──────────────────────────────┐
 │ automation:          │ ────────────────────────────▶ │ ha-webhook.ts  token check    │
 │  STYRBAR pressed     │   {type, device, action,      │   │                           │
 │  + daily forecast    │    context.forecast}          │   ├─▶ ha-reflexes.ts (fast)   │
 │                      │ ◀──────────────────────────── │   │    weather → haiku → text  │
 │  tts.*_say(speak)    │   {reflex:{speak:"..."}}      │   │                           │
 │  on the WiiM         │                               │   └─▶ ha-events.ts (buffer)   │
 │                      │                               │        bounce/flood guards    │
 │ automation (30 s):   │   GET /homeassistant/commands │        │                      │
 │  pull + run commands │ ◀───────────────────────────▶ │ ha-commands.ts queue          │
 └──────────────────────┘                               │        │ every 15 min          │
          ▲  direct /api/services when reachable        │ ha-digest.ts → 1 observation  │
          └─────────────────────────────────────────────│ (haiku) → brain think tick    │
                                                        │ (sonnet/opus) → ha-cli.ts     │
                                                        └──────────────────────────────┘
```

Three layers keep the expensive model out of the hot path:

| Layer | Trigger | Model | Latency | Output |
|-------|---------|-------|---------|--------|
| Reflex | matching event (button press) | `models.haReflex` (haiku) with template fallback | seconds | spoken text in the HTTP response |
| Digest | every `digestIntervalMs` (15 min) | `models.haDigest` (haiku), template for ≤4 events | minutes | one `[HOME DIGEST]` observation |
| Brain | next think tick after a digest | `models.think` (sonnet/opus) | tick cadence | memory, messages, `ha-cli.ts` commands |

The house decides what ARIA hears: only automations that call
`rest_command.aria_event` produce events. State polling from the server is off
by default (`entities: []`); enabling it for a domain turns every state change
in that domain into an event, and each 15-minute digest wakes the think tick,
so keep it off unless a domain is genuinely quiet. Polled `unknown`/`unavailable`
flaps (Home Assistant restarts) are ignored either way.

Guards: per-event validation (64 KB body, string/attribute size caps), bounce
dedup (same device+action within 1.5 s), flood guard (120 events / 10 min),
pending cap (300), webhook budget (200 req/min), shared-token auth with
constant-time compare, and an allowlist of service domains for outbound
commands (no `lock`, no `homeassistant.*`).

## Endpoints (public, token-protected)

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/homeassistant/event` | House pushes one event. Response includes `reflex.speak` when a reflex fired. |
| `GET` | `/homeassistant/commands` | House pulls queued service calls (`{commands:[{id, service, target, data, reason}]}`). |

Auth: `X-ARIA-Token: <token>` (or `Authorization: Bearer`). The token is
generated on first boot, shown on the dashboard card, stored in
`/data/homeassistant/config.json`.

Event body:

```json
{ "type": "button_press", "device": "Ikea switch 3 silver", "action": "on",
  "ts": "2026-09-04T07:42:00+02:00",
  "context": { "forecast": [ { "datetime": "...", "condition": "rainy", "temperature": 18, "templow": 11, "precipitation_probability": 70 } ] } }
```

`type` is required; one of `device`, `entity_id`, `friendly_name` is required.
`state`/`previous_state` describe state changes. Anything HA puts in `context`
is available to reflexes (the weather reflex reads `context.forecast`).

## Reflexes on the silver STYRBAR

| Button | Reflex | Says |
|--------|--------|------|
| top (`on`), bottom (`off`), left arrow | `weather_briefing` | today's/tomorrow's forecast |
| right arrow (`arrow_right_click`) | `mind_briefing` | what ARIA has on her mind today |

Config (dashboard → Home Assistant card, or `/data/homeassistant/config.json`):

```json
"speech": { "mediaPlayer": "media_player.wiim_amp_ultra_3d72",
            "ttsEngine": "tts.edge_tts_service_edge_tts", "language": "nl-NL-FennaNeural", "ttsVolume": 0.3 },
"reflexes": {
  "weatherBriefing": { "enabled": true, "device": "Ikea switch 3 silver",
                       "actions": ["on", "off", "arrow_left_click"],
                       "eveningHour": 14, "weatherEntity": "weather.buienradar", "pushTts": false },
  "mindBriefing":    { "enabled": true, "device": "Ikea switch 3 silver",
                       "actions": ["arrow_right_click"], "pushTts": false } }
```

`speech` is shared by every reflex, the CLI `speak` command and the dashboard.
(Older files with speaker/voice fields inside `weatherBriefing` are migrated on
load.)

### Mind briefing

`backend/ha-mind.ts` reads, without loading the memory graph: working memory
(current context, mood, short-term tracking, follow-ups, active goals, open
conversation threads), the consciousness file, today's observations (digest
lines excluded, quotes trimmed) and the last message ARIA sent. The prompt
carries ARIA's character preset and asks for 3–5 spoken Dutch sentences: what
stood out today, what she is working on or wondering about, something still
open. No weather, no verbatim private quotes. Model `models.haMind` (haiku by
default, `grok` in production for speed); template fallback ("Vandaag heb ik N
berichten voorbij zien komen…") if the model is slow or empty.

### Weather briefing

Forecast source order: forecast in the event → Home Assistant API (when the
agent can reach the house) → Open-Meteo for `location`. Before `eveningHour`
(owner-local) the briefing covers today, afterwards tomorrow. Phrasing: haiku
prompt in Dutch, deterministic Dutch template if the model fails, so the button
always answers.

Delivery: the automation sets the speaker volume (`media_player.volume_set`,
0.3) and speaks `reflex.speak` from the response with `tts.speak` on the WiiM
(Google Cast). With `pushTts: true` and a reachable house, ARIA also pushes the
volume + TTS calls itself; `ttsVolume` (0–1, or null to leave it) applies to
every server-initiated announcement (reflex push, CLI `speak`, dashboard).

### Premium voice (Grok / ElevenLabs / OpenAI)

Set `speech.provider` to `grok`, `elevenlabs` or `openai` and give a key
(dashboard field, or `GROK_API_KEY` / `ELEVENLABS_API_KEY` / `OPENAI_API_KEY`
in the environment; Grok reuses the key the brain already has). ARIA
then synthesizes every announcement herself (`backend/ha-voice.ts`), stores the
MP3 under `/data/homeassistant/tts/` and returns `reflex.audioUrl`
(`GET /homeassistant/tts/<32-hex>.mp3`, public, expires after a day). The
automation plays that URL with `media_player.play_media`; the CLI and
dashboard do the same. Any provider failure falls back to the Home Assistant
engine, so the button still answers. Clips are cached per text+voice.

**Grok (xAI, in production):** `POST https://api.x.ai/v1/tts`, voices `eve`
(default, female), `ara`, `rex`, `sal`, `leo`; language derived from
`speech.language` ("nl-NL-FennaNeural" → `nl`); `speech.speed` 0.7–1.5; ≈1 s
per clip, $4.20 per million characters. `speech.effect` post-processes every
synthesized clip with ffmpeg (in the image): `reverb` (small hall) or
`computer` (band-limited, long soft tail — the ship's-computer treatment);
filters live in `EFFECT_FILTERS` in `backend/ha-voice.ts`. If ffmpeg fails the
dry clip is used. Defaults: ElevenLabs voice "George" (`JBFqnCBsd6RMkjVDRZzb`, calm, mature; HAL
territory with `eleven_multilingual_v2` in Dutch). OpenAI: `gpt-4o-mini-tts`,
voice `onyx`, `style` becomes the delivery instructions ("calm, measured, like
a ship's computer"). Costs: ElevenLabs free tier 10k chars/month (~25
briefings), Starter $5 for 30k; OpenAI ≈ $0.015 per minute of audio.

Voice: the house runs the **Edge TTS** custom component
(`custom_components/edge_tts`, Microsoft neural voices, no key) as
`tts.edge_tts_service_edge_tts`; the voice is passed as `language`
(`nl-NL-FennaNeural`, alternatives `nl-NL-ColetteNeural`, `nl-BE-DenaNeural`).
`ttsEngine` also accepts the legacy engines `google_translate` / `cloud`
(`tts.<engine>_say`). ElevenLabs (core integration, needs an API key) is the
premium upgrade path: add it, set `ttsEngine` to its `tts.*` entity.

## Outbound: ARIA → house

`backend/integrations/ha-client.ts` calls `/api/services/...` when a direct or
cloud URL is configured. `ha-commands.ts` wraps this: direct when reachable,
queued otherwise, queued-as-fallback when a direct call fails. Queued commands
expire after 30 min. The brain uses the CLI:

```
npx tsx backend/scripts/ha-cli.ts states [--domain light] [--match keuken]
npx tsx backend/scripts/ha-cli.ts call light.turn_on --entity light.lampen_keuken_groep --data '{"brightness":128}'
npx tsx backend/scripts/ha-cli.ts speak "Goedemorgen" [--player media_player.x]
npx tsx backend/scripts/ha-cli.ts forecast
npx tsx backend/scripts/ha-cli.ts events [--limit 20]
```

### Making the house reachable (direct mode)

The house has no inbound access by default. Options, safest first:

1. **Port forward + host firewall** (what we use). The KPN Box 12 has no
   source-IP filter and no UniFi gateway sits in front of it, so:
   - the forward WAN `:8123` → `192.168.2.111:8123` is a UPnP mapping, re-asserted
     every 10 min by cron `/usr/local/sbin/aria-upnp-8123.sh` on the HA host
     (survives router reboots; a static rule in the KPN Box UI is optional);
   - iptables/ip6tables on the HA host accept `:8123` only from RFC1918 ranges,
     the LAN's IPv6 prefix and `46.224.74.85/32`, drop everything else
     (persisted with `netfilter-persistent`). So only the agent can reach Home
     Assistant from outside, and it still needs the long-lived token.
   - Traffic is plain HTTP; the token is only exposed to the one allowed peer.
     Upgrade to Tailscale/WireGuard if that ever matters.
2. Tailscale/WireGuard between the server and the HA host.
3. Nabu Casa remote URL (`cloud` mode).

Public IPv4 is `77.162.147.112`; if KPN ever changes it, update `direct_api.url`
on the dashboard (the pull queue keeps working meanwhile).

Without any of these everything still works: reflexes answer in the HTTP
response and commands are pulled by the house every 30 s.

## Home Assistant side

Files in this folder:

- `aria-package.yaml` — `rest_command` definitions (event push, command pull)
  and the `input_text` holding the token. Goes in `packages/aria.yaml`;
  `configuration.yaml` needs `homeassistant: packages: !include_dir_named packages`.
- `automations.json` — the two automations (STYRBAR → ARIA → TTS, and the
  30-second command puller), created through the config API. The STYRBAR
  automation uses MQTT device triggers on device `505fe2c55f3e036b458f872f3a9654cf`.

After editing YAML: Developer tools → YAML → "Rest commands" (or restart).

Reflex model: `models.haReflex` is `grok-mini` in production (≈6 s from press
to speech; the Claude CLI path takes ≈14 s because of process start-up). If the
model exceeds 12 s the Dutch template speaks instead.

WiiM: the players are currently exposed via Google Cast (`media_player.wiim_*`),
which supports TTS. Home Assistant 2026.4+ also ships a native **WiiM**
integration (Settings → Integrations → Add → WiiM, auto-discovered) that adds
presets, multiroom and better volume control; switching `mediaPlayer` to the
WiiM entity is a config change only.

## Files

| File | Role |
|------|------|
| `backend/integrations/ha-events.ts` | validation, bounce/flood guards, pending buffer, history |
| `backend/integrations/ha-webhook.ts` | public endpoints, token auth, request budget |
| `backend/ha-reflexes.ts` | reflex registry + weather briefing reflex |
| `backend/ha-weather.ts` | forecast sources, day selection, Dutch phrasing |
| `backend/ha-digest.ts` | periodic batch → one observation |
| `backend/integrations/ha-client.ts` | outbound REST client, TTS call builder |
| `backend/integrations/ha-commands.ts` | dispatch (direct/queued), allowlist, pull queue |
| `backend/integrations/homeassistant.ts` | config, webhook token, optional polling, status |
| `backend/scripts/ha-cli.ts` | brain-facing CLI |
| `tests/ha-*.test.ts` | unit tests for all of the above |
