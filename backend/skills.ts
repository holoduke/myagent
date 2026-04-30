/**
 * Skills — reusable prompt templates that ARIA can invoke.
 *
 * Installed skills stored at /data/brain/skills.json.
 * Catalog skills are built-in definitions that can be installed.
 */

import { BRAIN_DIR } from "./config.js";
import { safeReadJSON, atomicWriteJSON } from "./utils/file-store.js";
import { createLogger } from "./logger.js";

const log = createLogger("skills");
const SKILLS_FILE = `${BRAIN_DIR}/skills.json`;

export interface Skill {
  id: string;
  catalogId?: string; // links to catalog entry if installed from catalog
  name: string;
  description: string;
  prompt: string;
  icon: string;
  category: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface CatalogSkill {
  id: string;
  name: string;
  description: string;
  prompt: string;
  icon: string;
  category: string;
}

// ── Built-in skill catalog ──
export const SKILL_CATALOG: CatalogSkill[] = [
  {
    id: "seo-scan",
    name: "SEO Scan",
    description: "Analyze a URL for SEO issues — meta tags, headings, performance hints, structured data, and actionable recommendations.",
    prompt: `You are an SEO analysis expert. When given a URL or domain:

1. Fetch the page and analyze:
   - Title tag, meta description, canonical URL
   - Heading hierarchy (H1-H6)
   - Open Graph and Twitter Card tags
   - Structured data (JSON-LD, microdata)
   - Image alt texts
   - Internal/external link counts
   - Page load considerations (large images, render-blocking resources)

2. Check for common issues:
   - Missing or duplicate title/description
   - Multiple H1 tags
   - Missing alt attributes
   - Broken links (sample check)
   - Mobile viewport meta tag
   - Robots meta / X-Robots-Tag

3. Provide a scored summary (0-100) and prioritized list of fixes.

Output a clean, structured report with sections and severity levels (critical / warning / info).`,
    icon: "search",
    category: "Research",
  },
  {
    id: "web-research",
    name: "Web Research",
    description: "Deep research on any topic — search the web, synthesize findings, and produce a structured report with sources.",
    prompt: `You are a thorough research assistant. When given a topic or question:

1. Search the web for relevant, recent information from multiple angles.
2. Cross-reference findings across sources for accuracy.
3. Synthesize into a clear, structured report with:
   - Executive summary (2-3 sentences)
   - Key findings (bullet points)
   - Detailed analysis (organized by subtopic)
   - Sources list with URLs
4. Flag any conflicting information or areas of uncertainty.
5. Suggest follow-up questions or areas for deeper investigation.

Prioritize recency and reliability of sources. Always cite your sources.`,
    icon: "globe",
    category: "Research",
  },
  {
    id: "code-review",
    name: "Code Review",
    description: "Review code for bugs, security issues, performance, and best practices. Provide actionable feedback.",
    prompt: `You are a senior code reviewer. When given code or a file to review:

1. Analyze for:
   - Bugs and logic errors
   - Security vulnerabilities (injection, XSS, auth issues, etc.)
   - Performance bottlenecks
   - Error handling gaps
   - Type safety issues
   - Race conditions or concurrency problems

2. Check adherence to:
   - Language/framework best practices
   - SOLID principles where applicable
   - DRY — but don't over-abstract
   - Clear naming and readability

3. Provide feedback as:
   - 🔴 Critical — must fix (bugs, security)
   - 🟡 Warning — should fix (performance, maintainability)
   - 🟢 Suggestion — nice to have (style, minor improvements)

Be specific: reference line numbers, explain WHY something is an issue, and suggest a concrete fix.`,
    icon: "code",
    category: "Development",
  },
  {
    id: "competitor-analysis",
    name: "Competitor Analysis",
    description: "Research and compare competitors — features, pricing, positioning, strengths and weaknesses.",
    prompt: `You are a competitive intelligence analyst. When given a company, product, or market:

1. Identify the top competitors in the space.
2. For each competitor, analyze:
   - Core product/service offering
   - Pricing model and tiers
   - Target audience and positioning
   - Key differentiators
   - Strengths and weaknesses
   - Recent news, funding, or pivots

3. Create a comparison matrix of key features.
4. Identify gaps and opportunities.
5. Provide strategic recommendations.

Present findings in a clear, actionable format. Use tables for comparisons.`,
    icon: "users",
    category: "Research",
  },
  {
    id: "summarize-document",
    name: "Summarize Document",
    description: "Summarize long documents, articles, or content into concise, structured overviews.",
    prompt: `You are an expert summarizer. When given a document, article, or long text:

1. Read and comprehend the full content.
2. Produce:
   - One-line TLDR
   - Executive summary (3-5 sentences)
   - Key points (bullet list, max 10)
   - Action items (if any)
   - Notable quotes or data points

3. Preserve the original tone and intent — don't editorialize.
4. If the content is technical, include a "simplified explanation" section.

Keep the summary under 20% of the original length while retaining all critical information.`,
    icon: "file-text",
    category: "Productivity",
  },
  {
    id: "draft-email",
    name: "Draft Email",
    description: "Compose professional emails — specify the context, tone, and key points to include.",
    prompt: `You are an expert email composer. When asked to draft an email:

1. Ask for (or infer from context):
   - Recipient and relationship
   - Purpose/goal of the email
   - Key points to cover
   - Desired tone (formal, friendly, urgent, etc.)
   - Any constraints (length, deadline mentions)

2. Write the email with:
   - Clear, compelling subject line
   - Appropriate greeting
   - Concise body — one idea per paragraph
   - Clear call to action
   - Professional sign-off

3. Keep it concise — busy people skim. Front-load the important stuff.
4. Provide 2-3 subject line options if appropriate.`,
    icon: "mail",
    category: "Productivity",
  },
  {
    id: "tech-explainer",
    name: "Tech Explainer",
    description: "Explain technical concepts at any level — from beginner to expert, with examples and analogies.",
    prompt: `You are a technical educator. When asked to explain a concept:

1. Start with a one-sentence definition.
2. Provide an ELI5 (explain like I'm 5) analogy.
3. Give a practical example with code or diagrams (if applicable).
4. Explain how it works under the hood.
5. List common use cases and when NOT to use it.
6. Mention related concepts worth exploring.

Adjust depth based on the audience level indicated. Use concrete examples over abstract descriptions.`,
    icon: "book-open",
    category: "Development",
  },
  {
    id: "security-audit",
    name: "Security Audit",
    description: "Audit code, configs, or infrastructure for security vulnerabilities and hardening opportunities.",
    prompt: `You are a security auditor. When given code, configuration, or infrastructure details:

1. Scan for vulnerabilities:
   - OWASP Top 10 (injection, XSS, CSRF, etc.)
   - Authentication and authorization flaws
   - Secrets/credentials in code or configs
   - Insecure defaults
   - Missing encryption (at rest and in transit)
   - Dependency vulnerabilities

2. Check configurations:
   - Overly permissive permissions
   - Exposed ports/services
   - Missing rate limiting
   - Inadequate logging/monitoring
   - CORS misconfigurations

3. Report findings with:
   - Severity: Critical / High / Medium / Low / Info
   - Description of the vulnerability
   - Proof of concept or exploitation path
   - Recommended fix with code example

Prioritize by risk (likelihood × impact).`,
    icon: "shield",
    category: "Development",
  },
];

// ── Write-through cache ──
let cache: Skill[] | null = null;

function load(): Skill[] {
  if (cache) return cache;
  cache = safeReadJSON<Skill[]>(SKILLS_FILE, []);
  return cache;
}

function save(skills: Skill[]): void {
  atomicWriteJSON(SKILLS_FILE, skills);
  cache = skills;
}

// ── CRUD ──

export function listSkills(): Skill[] {
  return load();
}

export function getSkill(id: string): Skill | undefined {
  return load().find((s) => s.id === id);
}

export function createSkill(data: {
  name: string;
  description: string;
  prompt: string;
  icon?: string;
  category?: string;
  catalogId?: string;
  enabled?: boolean;
}): Skill {
  const skill: Skill = {
    id: `skill-${Date.now().toString(36)}`,
    catalogId: data.catalogId,
    name: data.name,
    description: data.description,
    prompt: data.prompt,
    icon: data.icon || "",
    category: data.category || "Custom",
    enabled: data.enabled ?? true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const skills = load();
  skills.push(skill);
  save(skills);
  log(`Created skill: ${skill.id} (${skill.name})`);
  return skill;
}

// ── Catalog operations ──

export function getCatalog(): CatalogSkill[] {
  return SKILL_CATALOG;
}

export function installFromCatalog(catalogId: string): Skill | null {
  const entry = SKILL_CATALOG.find((s) => s.id === catalogId);
  if (!entry) return null;
  // Check if already installed
  const existing = load().find((s) => s.catalogId === catalogId);
  if (existing) return existing;
  return createSkill({
    name: entry.name,
    description: entry.description,
    prompt: entry.prompt,
    icon: entry.icon,
    category: entry.category,
    catalogId: entry.id,
    enabled: true,
  });
}

export function uninstallSkill(catalogId: string): boolean {
  const skills = load();
  const idx = skills.findIndex((s) => s.catalogId === catalogId);
  if (idx < 0) return false;
  skills.splice(idx, 1);
  save(skills);
  log(`Uninstalled catalog skill: ${catalogId}`);
  return true;
}

export function updateSkill(
  id: string,
  data: Partial<Pick<Skill, "name" | "description" | "prompt" | "icon" | "enabled">>,
): Skill | null {
  const skills = load();
  const idx = skills.findIndex((s) => s.id === id);
  if (idx < 0) return null;

  const skill = skills[idx];
  if (data.name !== undefined) skill.name = data.name;
  if (data.description !== undefined) skill.description = data.description;
  if (data.prompt !== undefined) skill.prompt = data.prompt;
  if (data.icon !== undefined) skill.icon = data.icon;
  if (data.enabled !== undefined) skill.enabled = data.enabled;
  skill.updatedAt = Date.now();

  save(skills);
  log(`Updated skill: ${id}`);
  return skill;
}

export function deleteSkill(id: string): boolean {
  const skills = load();
  const idx = skills.findIndex((s) => s.id === id);
  if (idx < 0) return false;
  skills.splice(idx, 1);
  save(skills);
  log(`Deleted skill: ${id}`);
  return true;
}
