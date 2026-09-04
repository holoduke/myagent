/**
 * Home Assistant CLI — ARIA's tool for looking at and acting on the house.
 *
 * Usage (from /app):
 *   npx tsx backend/scripts/ha-cli.ts states [--domain light] [--match keuken]
 *   npx tsx backend/scripts/ha-cli.ts call <domain.service> [--entity <id>] [--data '{"brightness":128}'] [--reason "..."]
 *   npx tsx backend/scripts/ha-cli.ts speak "Tekst" [--player media_player.x]
 *   npx tsx backend/scripts/ha-cli.ts forecast
 *   npx tsx backend/scripts/ha-cli.ts events [--limit 20]
 *
 * `call` and `speak` go straight to Home Assistant when it is reachable from
 * the server, otherwise they are queued and the house pulls them within its
 * polling interval. Only allow-listed service domains are accepted.
 */

import { getStates, buildTtsCall } from "../integrations/ha-client.js";
import { dispatchCommand } from "../integrations/ha-commands.js";
import { getRecentEvents, describeEvent } from "../integrations/ha-events.js";
import { loadConfig } from "../integrations/homeassistant.js";
import { composeWeatherBriefing } from "../ha-weather.js";
import { getBrainConfig } from "../brain-config.js";
import { OWNER_NAME } from "../config.js";

export type CliCommand =
  | { command: "states"; domain?: string; match?: string }
  | { command: "call"; service: string; entity?: string; data?: Record<string, unknown>; reason?: string }
  | { command: "speak"; text: string; player?: string }
  | { command: "forecast" }
  | { command: "events"; limit: number };

const USAGE = `Usage:
  ha-cli.ts states [--domain light] [--match text]
  ha-cli.ts call <domain.service> [--entity <entity_id>] [--data '{...}'] [--reason "..."]
  ha-cli.ts speak "text" [--player media_player.x]
  ha-cli.ts forecast
  ha-cli.ts events [--limit N]`;

function flag(rest: string[], name: string): string | undefined {
  const i = rest.indexOf(name);
  if (i < 0) return undefined;
  const value = rest[i + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

/** Parse argv (after node/script) into a command. Throws with a usage message on invalid input. */
export function parseCliArgs(argv: string[]): CliCommand {
  const [command, ...rest] = argv;

  if (command === "states") {
    return { command: "states", domain: flag(rest, "--domain"), match: flag(rest, "--match") };
  }
  if (command === "call") {
    const service = rest[0] && !rest[0].startsWith("--") ? rest[0] : undefined;
    if (!service || !/^[a-z_]+\.[a-z0-9_]+$/.test(service)) throw new Error("call requires <domain.service> as first argument");
    const rawData = flag(rest, "--data");
    let data: Record<string, unknown> | undefined;
    if (rawData) {
      const parsed: unknown = JSON.parse(rawData);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("--data must be a JSON object");
      data = parsed as Record<string, unknown>;
    }
    return { command: "call", service, entity: flag(rest, "--entity"), data, reason: flag(rest, "--reason") };
  }
  if (command === "speak") {
    const text = rest[0] && !rest[0].startsWith("--") ? rest[0] : undefined;
    if (!text) throw new Error('speak requires the text as first argument');
    return { command: "speak", text, player: flag(rest, "--player") };
  }
  if (command === "forecast") return { command: "forecast" };
  if (command === "events") {
    const raw = flag(rest, "--limit");
    const limit = raw === undefined ? 20 : Number(raw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("--limit must be an integer 1-200");
    return { command: "events", limit };
  }
  throw new Error(USAGE);
}

async function main() {
  const cmd = parseCliArgs(process.argv.slice(2));
  const config = loadConfig();

  if (cmd.command === "states") {
    const states = await getStates(cmd.domain);
    const needle = cmd.match?.toLowerCase();
    const rows = needle
      ? states.filter(s => `${s.entity_id} ${s.attributes.friendly_name ?? ""}`.toLowerCase().includes(needle))
      : states;
    for (const s of rows) console.log(`${s.entity_id} = ${s.state}  (${s.attributes.friendly_name ?? ""})`);
    console.log(`${rows.length} entities`);
    return;
  }

  if (cmd.command === "call") {
    const [domain, service] = cmd.service.split(".");
    const result = await dispatchCommand({ domain, service, entityId: cmd.entity, data: cmd.data }, "cli", cmd.reason);
    console.log(result.mode === "direct"
      ? `Called ${cmd.service} directly.`
      : `Queued ${cmd.service} (${result.command.id}) — the house pulls it within its polling interval.`);
    return;
  }

  if (cmd.command === "speak") {
    const reflex = config.reflexes.weatherBriefing;
    const call = buildTtsCall(cmd.text, { player: cmd.player ?? reflex.mediaPlayer, engine: reflex.ttsEngine, language: reflex.language });
    const result = await dispatchCommand(call, "cli", "spoken message");
    console.log(result.mode === "direct" ? "Spoken via Home Assistant." : `Queued for the house (${result.command.id}).`);
    return;
  }

  if (cmd.command === "forecast") {
    const brain = getBrainConfig();
    const briefing = await composeWeatherBriefing({
      now: new Date(),
      timezone: brain.ownerTimezone,
      eveningHour: config.reflexes.weatherBriefing.eveningHour,
      ownerName: OWNER_NAME,
      location: config.location,
    });
    console.log(`${briefing.label} (${briefing.day.date}, ${briefing.source}): ${briefing.text}`);
    return;
  }

  for (const e of getRecentEvents(cmd.limit)) {
    console.log(`[${new Date(e.ts).toISOString()}] ${describeEvent(e)}${e.handledBy ? ` → ${e.handledSummary}` : ""}`);
  }
}

// Only run when invoked directly (not when imported by tests).
const invokedDirectly = process.argv[1]?.endsWith("ha-cli.ts");
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`Error: ${err.message ?? err}`);
    process.exit(1);
  });
}
