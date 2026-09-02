/**
 * WhatsApp JID alias resolution.
 *
 * WhatsApp addresses the same person via a phone JID (@s.whatsapp.net) or a
 * LID (@lid) depending on chat addressing mode; the synced contact store links
 * the two. Identity consumers (frequency baselines, silence detection) collapse
 * both aliases onto one key via canonicalJid() — otherwise a contact whose
 * chats migrated to the other alias reads as "gone quiet" on the dead one.
 *
 * Kept separate from whatsapp.ts so light consumers (frequency-tracker) don't
 * pull in the Baileys socket stack; whatsapp.ts invalidates the map whenever
 * it persists contact updates.
 */

import { existsSync } from "fs";
import { safeReadJSON } from "../utils/file-store.js";
import { createLogger } from "../logger.js";

const log = createLogger("jid-alias");

const CONTACTS_PATH = process.env.DATA_DIR
  ? `${process.env.DATA_DIR}/brain/contacts.json`
  : "/data/brain/contacts.json";

/** Minimal shape of a stored Baileys contact — only the identity fields. */
interface StoredContact {
  id?: string;
  lid?: string;
  jid?: string;
  phoneNumber?: string;
}

let jidAliasMap: Map<string, string> | null = null;

/** Strip the device suffix from a JID ("123:45@lid" → "123@lid") — same normalization used for owner-LID matching. */
export function normalizeJid(jid: string): string {
  return jid.replace(/:\d+@/, "@");
}

function buildJidAliasMap(): Map<string, string> {
  const map = new Map<string, string>();
  if (!existsSync(CONTACTS_PATH)) return map;
  const data = safeReadJSON<StoredContact[]>(CONTACTS_PATH, []);
  if (!Array.isArray(data)) return map;
  for (const c of data) {
    // Baileys puts the phone JID in `phoneNumber` or `id`; older stored
    // contacts carry it in a raw `jid` field instead.
    const pn = [c.phoneNumber, c.jid, c.id].find((j) => j?.endsWith("@s.whatsapp.net"));
    const lid = [c.lid, c.id].find((j) => j?.endsWith("@lid"));
    if (pn && lid) map.set(normalizeJid(lid), normalizeJid(pn));
  }
  log(`Built JID alias map: ${map.size} lid↔pn pairs`);
  return map;
}

/** Drop the cached map; called by whatsapp.ts whenever contacts are persisted. */
export function invalidateJidAliasMap(): void {
  jidAliasMap = null;
}

/**
 * Resolve a JID to its canonical contact identity: a LID with a known
 * phone-JID pairing maps to the phone JID; everything else passes through
 * normalized. Unknown aliases stay distinct — no guessing.
 */
export function canonicalJid(jid: string): string {
  const norm = normalizeJid(jid);
  if (!norm.endsWith("@lid")) return norm;
  if (!jidAliasMap) jidAliasMap = buildJidAliasMap();
  return jidAliasMap.get(norm) ?? norm;
}
