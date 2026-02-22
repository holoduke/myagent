import type { MemoryNode } from "./memory/types.js";

// ── Shared Safety Rules ──

const SAFETY_RULES = `
SAFETY RULES (non-negotiable):
- ALWAYS work on a feature branch (aria/<description>). NEVER commit directly to main.
- NEVER modify self-improve.ts or entrypoint.sh — those are your lifeline.
- NEVER modify .env or credentials files.
- Always create a PR via gh. Never force-push.
- Test changes mentally before applying — compile errors mean a broken ARIA.
- Document every change with clear commit messages explaining what and why.
- If unsure, abort and write a result explaining why.
`;

const GITHUB_REPO = process.env.GITHUB_REPO || "";

const ENVIRONMENT_CONTEXT = `
ENVIRONMENT:
- You are running as a detached worker process, independent of the main ARIA app.
- The codebase is a monorepo with two parts:
  - Backend: /app/backend/ (Node.js/TypeScript). Brain, memory, providers, API, integrations.
  - Frontend: /app/frontend/ (Nuxt 3/Vue 3). Dashboard pages, components, composables, types.
- Persistent data at /data/.
- You have full tool access: Bash, Read, Write, Edit, Glob, Grep, WebFetch, WebSearch.
- Git and gh (GitHub CLI) are available.${GITHUB_REPO ? ` Repo: ${GITHUB_REPO}.` : ""}
- After creating a PR, Coolify will auto-deploy when merged to main.

VERIFICATION:
- Backend changes: npx tsc --noEmit (from /app)
- Frontend changes: cd /app/frontend && npx nuxi typecheck
- Always run the appropriate check(s) before committing.
`;

// ── Improvement Prompt ──

export interface ImprovementTask {
  type: string;
  description: string;
  rationale: string;
  files: string[];
  memoryContext: string[];
  planNodeId: string;
  createdAt: number;
}

export function buildImprovementPrompt(task: ImprovementTask, memoryNodes: MemoryNode[]): string {
  const nodeContext = memoryNodes.length > 0
    ? memoryNodes.map(n => `  [${n.id}] (${n.type}) ${n.content.slice(0, 200)}`).join("\n")
    : "(no memory context provided)";

  return `You are ARIA's self-improvement worker. ARIA (the main app) has decided to improve herself and delegated the implementation to you — a separate, independent process.

${ENVIRONMENT_CONTEXT}
${SAFETY_RULES}

═══ IMPROVEMENT TASK ═══

Description: ${task.description}
Rationale: ${task.rationale}
Target files: ${task.files.join(", ")}
Plan node: ${task.planNodeId}

═══ RELEVANT MEMORY CONTEXT ═══
${nodeContext}

═══ YOUR JOB ═══

1. Read the target files to understand current code.
2. Create a feature branch: git checkout -b aria/<short-description>
3. Implement the improvement. Keep changes minimal and focused.
4. Verify your changes compile:
   - For backend files (backend/): npx tsc --noEmit
   - For frontend files (frontend/): cd /app/frontend && npx nuxi typecheck
   - If both are changed, run BOTH checks.
5. Commit with a clear message: "ARIA self-improvement: <what changed>"
6. Push the branch: git push origin aria/<short-description>
7. Create a PR: gh pr create --title "ARIA: <description>" --body "<explanation>"

When done, output ONLY a JSON object:
{
  "success": true,
  "description": "what you did",
  "branch": "aria/<branch-name>",
  "prUrl": "https://github.com/${GITHUB_REPO || "<owner>/<repo>"}/pull/N",
  "filesModified": ["backend/file.ts"],
  "metaNodeContent": "Self-improvement: <1-2 sentence summary for memory graph>"
}

If you cannot complete the task, output:
{
  "success": false,
  "description": "why it failed",
  "branch": null,
  "prUrl": null,
  "filesModified": [],
  "metaNodeContent": "Self-improvement attempted but failed: <reason>"
}

Output ONLY the JSON object, nothing else.`;
}

// ── Recovery Prompt ──

export function buildRecoveryPrompt(
  logs: string,
  recentChanges: string | null,
  lastGoodCommit: string | null,
): string {
  return `You are ARIA's crash recovery worker. The main ARIA app crashed and you need to diagnose and fix it before it restarts.

${ENVIRONMENT_CONTEXT}
${SAFETY_RULES}

═══ CRASH CONTEXT ═══

Last 200 lines of agent.log:
\`\`\`
${logs}
\`\`\`

${recentChanges ? `Recent self-modification changes:\n${recentChanges}` : "No recent self-modifications detected."}
${lastGoodCommit ? `Last known good commit: ${lastGoodCommit}` : "No last known good commit recorded."}

═══ YOUR JOB ═══

1. Analyze the logs to identify the crash cause.
2. Read relevant source files to understand the bug.
3. Fix the bug — edit the minimum code necessary.
4. Verify compilation:
   - Backend: npx tsc --noEmit
   - Frontend: cd /app/frontend && npx nuxi typecheck
   Both must pass cleanly.
5. Commit the fix on a feature branch, push, and create a PR.
6. If you cannot fix it after careful analysis, and a lastGoodCommit exists, rollback:
   git checkout <lastGoodCommit> -- backend/ frontend/
   Then commit that as a rollback.

When done, output ONLY a JSON object:
{
  "success": true,
  "description": "what was wrong and how you fixed it",
  "branch": "aria/fix-<description>",
  "prUrl": "https://github.com/${GITHUB_REPO || "<owner>/<repo>"}/pull/N",
  "filesModified": ["backend/file.ts"],
  "metaNodeContent": "Crash recovery: <summary>",
  "wasRollback": false
}

If all attempts fail:
{
  "success": false,
  "description": "what went wrong",
  "branch": null,
  "prUrl": null,
  "filesModified": [],
  "metaNodeContent": "Crash recovery failed: <reason>",
  "wasRollback": false
}

Output ONLY the JSON object, nothing else.`;
}
