/**
 * Play Store review CLI — ARIA's tool for listing and replying to reviews.
 *
 * Usage (from /app):
 *   npx tsx backend/scripts/playstore-cli.ts reviews [--days N]
 *   npx tsx backend/scripts/playstore-cli.ts reply <reviewId> --text "..." --confirm
 *
 * Replies are PUBLIC on the Play Store. The --confirm flag is required so a
 * reply can never be posted by accident: only pass it with text the owner has
 * explicitly approved.
 */

import {
  fetchReviewsWithIds,
  replyToReview,
  isPlayStoreConfigured,
  getPlayStoreConfig,
} from "../integrations/playstore.js";

export interface CliCommand {
  command: "reviews" | "reply";
  days?: number;
  reviewId?: string;
  text?: string;
  confirm?: boolean;
}

/** Parse argv (after node/script) into a command. Throws with a usage message on invalid input. */
export function parseCliArgs(argv: string[]): CliCommand {
  const [command, ...rest] = argv;

  if (command === "reviews") {
    let days = 7;
    const di = rest.indexOf("--days");
    if (di >= 0) {
      const n = Number(rest[di + 1]);
      if (!Number.isInteger(n) || n < 1 || n > 90) throw new Error("--days must be an integer 1-90");
      days = n;
    }
    return { command: "reviews", days };
  }

  if (command === "reply") {
    const reviewId = rest[0] && !rest[0].startsWith("--") ? rest[0] : undefined;
    if (!reviewId) throw new Error("reply requires a reviewId as first argument");
    const ti = rest.indexOf("--text");
    const text = ti >= 0 ? rest[ti + 1] : undefined;
    if (!text || text.startsWith("--")) throw new Error("reply requires --text \"...\"");
    const confirm = rest.includes("--confirm");
    return { command: "reply", reviewId, text, confirm };
  }

  throw new Error(
    'Usage:\n  playstore-cli.ts reviews [--days N]\n  playstore-cli.ts reply <reviewId> --text "..." --confirm',
  );
}

async function main() {
  const cmd = parseCliArgs(process.argv.slice(2));

  if (!isPlayStoreConfigured()) {
    console.error(`Play Store not configured: missing ${getPlayStoreConfig().serviceAccountFile}`);
    process.exit(1);
  }

  if (cmd.command === "reviews") {
    const since = Date.now() - (cmd.days ?? 7) * 24 * 60 * 60 * 1000;
    const reviews = await fetchReviewsWithIds(since);
    if (reviews.length === 0) {
      console.log(`No reviews in the last ${cmd.days} days.`);
      return;
    }
    for (const r of reviews) {
      console.log(`[${r.date}] ${"★".repeat(r.stars)}${"☆".repeat(5 - r.stars)} [${r.language}] ${r.replied ? "[REPLIED]" : "[NO REPLY]"}`);
      console.log(`  ${r.text || "(no text)"}`);
      console.log(`  id: ${r.reviewId}`);
    }
    return;
  }

  // cmd.command === "reply"
  if (!cmd.confirm) {
    console.error("Refusing to post: replies are PUBLIC. Re-run with --confirm once the owner has approved this exact text.");
    process.exit(1);
  }
  await replyToReview(cmd.reviewId!, cmd.text!);
  console.log(`Reply posted to review ${cmd.reviewId}.`);
}

// Only run when invoked directly (not when imported by tests).
const invokedDirectly = process.argv[1]?.endsWith("playstore-cli.ts");
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`Error: ${err.message ?? err}`);
    process.exit(1);
  });
}
