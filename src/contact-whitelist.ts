import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "fs";

const BRAIN_DIR = process.env.BRAIN_DIR || "/data/brain";
const WHITELIST_FILE = `${BRAIN_DIR}/contact-whitelist.json`;

export interface WhitelistedContact {
  jid: string;
  name: string;
  addedAt: number;
}

function loadWhitelist(): WhitelistedContact[] {
  try {
    if (existsSync(WHITELIST_FILE)) {
      return JSON.parse(readFileSync(WHITELIST_FILE, "utf-8"));
    }
  } catch {
    console.error("[whitelist] Failed to read whitelist, starting fresh");
  }
  return [];
}

function saveWhitelist(contacts: WhitelistedContact[]): void {
  if (!existsSync(BRAIN_DIR)) {
    mkdirSync(BRAIN_DIR, { recursive: true });
  }
  const tmp = WHITELIST_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(contacts, null, 2));
  renameSync(tmp, WHITELIST_FILE);
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
