import { safeReadJSON, atomicWriteJSON, ensureDir } from "./utils/file-store.js";
import { createLogger } from "./logger.js";

const log = createLogger("whitelist");

const BRAIN_DIR = process.env.BRAIN_DIR || "/data/brain";
const WHITELIST_FILE = `${BRAIN_DIR}/contact-whitelist.json`;

export interface WhitelistedContact {
  jid: string;
  name: string;
  addedAt: number;
}

// Write-through in-memory cache (follows history.ts pattern)
let whitelistCache: WhitelistedContact[] | null = null;

function loadWhitelist(): WhitelistedContact[] {
  if (whitelistCache) return whitelistCache;
  whitelistCache = safeReadJSON<WhitelistedContact[]>(WHITELIST_FILE, []);
  return whitelistCache;
}

function saveWhitelist(contacts: WhitelistedContact[]): void {
  ensureDir(BRAIN_DIR);
  atomicWriteJSON(WHITELIST_FILE, contacts);
  whitelistCache = contacts;
}

export function isWhitelisted(jid: string): boolean {
  const ownerJid = `${process.env.OWNER_PHONE}@s.whatsapp.net`;
  if (jid === ownerJid) return true;
  return loadWhitelist().some(c => c.jid === jid);
}

export function addToWhitelist(jid: string, name: string): void {
  const contacts = loadWhitelist();
  if (contacts.some(c => c.jid === jid)) return;
  contacts.push({ jid, name, addedAt: Date.now() });
  saveWhitelist(contacts);
}

export function removeFromWhitelist(jid: string): boolean {
  const contacts = loadWhitelist();
  const filtered = contacts.filter(c => c.jid !== jid);
  if (filtered.length === contacts.length) return false;
  saveWhitelist(filtered);
  return true;
}

export function getWhitelist(): WhitelistedContact[] {
  return loadWhitelist();
}
