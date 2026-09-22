#!/usr/bin/env node
/* ============================================================================
   Kit catalog refresh — data/kits.json -> js/kits-data.js
   ----------------------------------------------------------------------------
   1. Reads the curated catalog (data/kits.json). Editorial fields like
      difficulty, timeToHelloWorld, bestFor and maturity are never overwritten.
   2. Fetches each kit's GitHub repo and refreshes the factual fields:
        stars          <- stargazers_count
        license        <- license.spdx_id (kept if NOASSERTION / missing)
        activityScore  <- recency of pushed_at, bucketed 0-10
        popularity     <- log10(stars) normalised so the top repo scores 100
      Repos that return 404/410 are REMOVED from the catalog (logged below).
      Repos listed in data/ignored.json are also removed from the catalog.
      Archived repos are removed and auto-appended to data/ignored.json.
   3. Enriches minimal entries: a kit listed as { "name": "...", "repo": "..." }
      gets org, description, docs, languages, licence, category and ratings
      filled in automatically (best-effort guesses from the API data).
   4. Discovery: searches GitHub for new starter-kit repos and appends unseen
      results to data/candidates.json. Candidates are NOT auto-promoted —
      promotion is a manual step (copy a slug into kits.json and this script
      fills in the rest).
   5. Writes data/kits.json, js/kits-data.js and data/candidates.json.

   Usage:
     node .github/scripts/update-kits.mjs
     GITHUB_TOKEN=ghp_... node .github/scripts/update-kits.mjs

   Unauthenticated works for ~50 repos (60 req/hr limit, 10 req/min search);
   the workflow passes the built-in GITHUB_TOKEN for a comfortable margin.
   ========================================================================== */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const DATA_PATH = new URL("../../data/kits.json", import.meta.url);
const OUT_PATH = new URL("../../js/kits-data.js", import.meta.url);
const CANDIDATES_PATH = new URL("../../data/candidates.json", import.meta.url);
const IGNORED_PATH = new URL("../../data/ignored.json", import.meta.url);
const TOKEN = process.env.GITHUB_TOKEN || "";

const GENERATED_HEADER = `/* ============================================================================
   AI Starter Kit Catalog — GENERATED FILE, do not edit by hand.
   ----------------------------------------------------------------------------
   Source of truth: data/kits.json (edit that file instead).
   Regenerate:   node .github/scripts/update-kits.mjs
   Auto-refresh: .github/workflows/refresh-kits.yml runs weekly and commits.

   The numeric ratings (difficulty, timeToHelloWorld, maturity, ecosystem,
   costFriendliness, docsQuality) and bestFor text are editorial estimates.
   stars, license, activityScore and popularity are refreshed from the GitHub
   API — see .github/scripts/update-kits.mjs for the exact mapping.
   ========================================================================== */

`;

/* Discovery queries: kept narrow ("starter/template" phrasing in name or
   description) so the candidate list stays reviewable rather than a firehose. */
const SEARCH_QUERIES = [
  {
    q: "starter kit ai in:name,description stars:>1000",
    via: "ai starter kit",
  },
  { q: "llm starter in:name,description stars:>800", via: "llm starter" },
  { q: "rag starter in:name,description stars:>500", via: "rag starter" },
  {
    q: "ai agent template in:name,description stars:>1000",
    via: "agent template",
  },
  {
    q: "chatbot starter in:name,description stars:>500",
    via: "chatbot starter",
  },
  { q: "mcp starter in:name,description stars:>300", via: "mcp starter" },
];
const KIT_WORDS =
  /(starter|template|boilerplate|kit|quickstart|quick-start|example|cookbook|sample|scaffold)/i;
const MAX_CANDIDATES = 150;

/* First match wins — ordered so specific categories beat broad ones. */
const CATEGORY_HINTS = [
  [/(rag|retrieval|vector|embedding|semantic-search)/i, "RAG / Retrieval"],
  [
    /(eval|observability|tracing|monitor|telemetry)/i,
    "Evaluation / Observability",
  ],
  [/(fine-?tun|qlora|lora|training)/i, "Fine-Tuning"],
  [/(guardrail|safety|moderation|security)/i, "Guardrails / Safety"],
  [/(mcp|tool[- ]?use|function-calling)/i, "Tooling / MCP"],
  [/(speech|audio|voice|whisper|tts|stt)/i, "Audio / Speech"],
  [/(image|diffusion|stable|dall-?e)/i, "Image / Generation"],
  [/(vision|multimodal|video|ocr)/i, "Vision / Multimodal"],
  [/(serving|inference|vllm|deploy)/i, "Model Serving / Inference"],
  [/(local|self-?host|offline|edge|ollama|llama\.cpp)/i, "Local / Self-Hosted"],
  [/(agent|agentic|autogen|crewai)/i, "Agent Framework"],
  [
    /(nextjs|react|vercel|fullstack|full-stack|web[- ]?app|saas)/i,
    "Full-Stack Web App",
  ],
  [/(notebook|jupyter|streamlit|gradio|pandas|data)/i, "Data & Notebook App"],
  [/(enterprise|cloud|aws|azure|gcp|serverless)/i, "Enterprise / Cloud"],
  [
    /(cookbook|examples|recipes|course|tutorial|learn|awesome)/i,
    "Reference / Cookbook",
  ],
];
const FALLBACK_CATEGORY = "Reference / Cookbook";

function repoSlug(url) {
  const match = /^https?:\/\/github\.com\/([^/]+)\/([^/#?]+)/.exec(url || "");
  return match ? `${match[1]}/${match[2].replace(/\.git$/, "")}` : null;
}

function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function activityFromPush(pushedAt) {
  const days = (Date.now() - new Date(pushedAt).getTime()) / 864e5;
  if (days <= 14) return 10;
  if (days <= 45) return 9;
  if (days <= 90) return 8;
  if (days <= 180) return 6;
  if (days <= 365) return 4;
  if (days <= 730) return 2;
  return 1;
}

function maturityFromRepo(repo) {
  const ageYears =
    (Date.now() - new Date(repo.created_at).getTime()) / (365.25 * 864e5);
  const stars = repo.stargazers_count || 0;
  if (stars > 20000 && ageYears > 2) return 9;
  if (stars > 5000 || (stars > 2000 && ageYears > 1)) return 7;
  if (stars > 1000) return 5;
  return 4;
}

function guessCategory(repo) {
  const haystack = [
    repo.name,
    repo.description || "",
    (repo.topics || []).join(" "),
  ].join(" ");
  for (const [pattern, category] of CATEGORY_HINTS) {
    if (pattern.test(haystack)) return category;
  }
  return FALLBACK_CATEGORY;
}

async function gh(path) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "starterkit-radar-catalog-refresh",
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
    },
  });
  if (!res.ok) return { status: res.status, data: null };
  return { status: res.status, data: await res.json() };
}

/* GitHub's licence detector returns NOASSERTION for files it can't classify
   (non-standard formatting, CC licences, recently added files). Fall back to
   fetching the LICENSE blob and matching common texts. First match wins —
   order more-specific patterns before broader ones. */
const LICENSE_SNIFFS = [
  [/GNU AFFERO GENERAL PUBLIC LICENSE[\s\S]{0,400}Version 3/i, "AGPL-3.0"],
  [/GNU GENERAL PUBLIC LICENSE[\s\S]{0,400}Version 3/i, "GPL-3.0"],
  [/Apache License[\s\S]{0,400}Version 2\.0/i, "Apache-2.0"],
  [/MIT License|Permission is hereby granted, free of charge/i, "MIT"],
  [/Attribution-ShareAlike 4\.0 International/i, "CC-BY-SA-4.0"],
  [
    /Attribution 4\.0 International|Creative Commons Attribution 4\.0/i,
    "CC-BY-4.0",
  ],
  [/CC0 1\.0|Creative Commons Zero/i, "CC0-1.0"],
  [/Mozilla Public License[\s\S]{0,400}Version 2\.0/i, "MPL-2.0"],
  [
    /Neither the name (of|of the).{0,200}(used to endorse|promote)/is,
    "BSD-3-Clause",
  ],
  [/Redistribution and use in source and binary forms/i, "BSD-2-Clause"],
];

async function detectLicense(repo) {
  const spdx = repo.license && repo.license.spdx_id;
  if (spdx && spdx !== "NOASSERTION") return spdx;
  const { data } = await gh(`/repos/${repo.full_name}/license`);
  if (!data || !data.content) return null;
  const text = Buffer.from(data.content, "base64").toString("utf8");
  for (const [pattern, id] of LICENSE_SNIFFS) {
    if (pattern.test(text)) return id;
  }
  return null;
}

/* ------------------------------------------------------------ *
 * Phase 1+2: fetch every catalog repo, refresh or drop entries *
 * ------------------------------------------------------------ */

const kits = JSON.parse(readFileSync(DATA_PATH, "utf8"));

// Ignore list: permanent exclusion from catalog AND candidate discovery.
let ignoredFile = { ignored: [] };
if (existsSync(IGNORED_PATH)) {
  try {
    ignoredFile = JSON.parse(readFileSync(IGNORED_PATH, "utf8"));
  } catch {
    /* malformed ignore file — start empty */
  }
}
const ignoredSlugs = new Set(
  (ignoredFile.ignored || []).map((s) => s.toLowerCase()),
);
const fetched = await Promise.all(
  kits.map(async (kit) => {
    const slug = repoSlug(kit.repo);
    if (!slug) return { kit, status: 0, repo: null, error: "no github repo" };
    const { status, data } = await gh(`/repos/${slug}`);
    return { kit, status, repo: data, error: data ? null : `HTTP ${status}` };
  }),
);

const removed = [];
const flagged = [];
const failures = [];
const kept = [];

for (const { kit, status, repo, error } of fetched) {
  const slug = repoSlug(kit.repo);
  if (slug && ignoredSlugs.has(slug.toLowerCase())) {
    removed.push(`${kit.id} (ignored: ${slug})`);
    continue;
  }
  if (status === 404 || status === 410) {
    removed.push(`${kit.id} (${kit.repo})`);
    continue;
  }
  if (!repo) {
    failures.push(`${kit.id}: ${error}`);
    kept.push(kit);
    continue;
  }
  if (repo.archived) {
    removed.push(`${kit.id} (archived: ${slug})`);
    if (slug && !ignoredSlugs.has(slug.toLowerCase())) {
      ignoredFile.ignored.push(slug);
      ignoredSlugs.add(slug.toLowerCase());
    }
    continue;
  }
  kit.stars = repo.stargazers_count;
  const license = await detectLicense(repo);
  if (license) kit.license = license;
  kit.activityScore = activityFromPush(repo.pushed_at);
  kept.push(Object.assign(kit, { _repo: repo }));
}

/* ------------------------------------------------------------ *
 * Phase 3: enrich minimal entries ({name, repo} is enough to add) *
 * ------------------------------------------------------------ */

const enriched = [];
for (const kit of kept) {
  const repo = kit._repo;
  delete kit._repo;
  if (!repo) continue; // nothing to enrich from; keep as-is

  let defaulted = false;
  const fill = (key, value, editorial) => {
    if (kit[key] === undefined || kit[key] === null || kit[key] === "") {
      kit[key] = value;
      if (editorial) defaulted = true;
    }
  };

  fill("id", slugify(repo.name || kit.name));
  fill("org", repo.owner && repo.owner.login);
  fill("name", repo.name);
  fill("bestFor", repo.description || "See the repository for details.", true);
  fill("docs", repo.homepage || repo.html_url);
  fill("category", guessCategory(repo), true);
  fill("difficulty", 3, true);
  fill("timeToHelloWorld", 30, true);
  fill("maturity", maturityFromRepo(repo), true);
  fill(
    "ecosystem",
    Math.min(9, Math.round(Math.log10(kit.stars + 1) * 2)),
    true,
  );
  fill("costFriendliness", kit.license ? 7 : 5, true);
  fill("docsQuality", repo.has_wiki || repo.homepage ? 6 : 5, true);
  fill("pricing", kit.license ? "Free / OSS" : "Check repo licence", true);
  fill("models", []);
  fill("license", "Unspecified");
  for (const flag of [
    "hasUI",
    "hasBackend",
    "hasEvals",
    "requiresKey",
    "localFirst",
  ]) {
    fill(flag, false);
  }

  if (!Array.isArray(kit.languages) || kit.languages.length === 0) {
    const langs = await gh(`/repos/${repo.full_name}/languages`);
    kit.languages = langs.data ? Object.keys(langs.data).slice(0, 4) : [];
    defaulted = true;
  }

  if (defaulted) enriched.push(kit.id);
}

/* ------------------------------------------------------------ *
 * Phase 4: popularity normalised against the catalog's top repo *
 * ------------------------------------------------------------ */

const maxStars = Math.max(...kept.map((k) => k.stars || 0), 1);
for (const kit of kept) {
  delete kit.score; // runtime-computed by js/kits-meta.js — never stored
  delete kit.needsReview; // enrichment is best-effort, no manual review flag
  kit.popularity = Math.max(
    1,
    Math.min(
      100,
      Math.round(
        (100 * Math.log10((kit.stars || 0) + 1)) / Math.log10(maxStars + 1),
      ),
    ),
  );
}

/* ------------------------------------------------------------ *
 * Phase 5: discover new candidates via GitHub search            *
 * ------------------------------------------------------------ */

let candidatesFile = { generated_at: null, candidates: [] };
if (existsSync(CANDIDATES_PATH)) {
  try {
    candidatesFile = JSON.parse(readFileSync(CANDIDATES_PATH, "utf8"));
  } catch {
    /* start fresh on a corrupt file */
  }
}
const knownSlugs = new Set(
  kept
    .map((k) => repoSlug(k.repo))
    .filter(Boolean)
    .map((s) => s.toLowerCase()),
);
const candidates = candidatesFile.candidates || [];
const newCandidates = [];

for (const { q, via } of SEARCH_QUERIES) {
  const { status, data } = await gh(
    `/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=15`,
  );
  if (!data) {
    failures.push(`search "${via}": HTTP ${status}`);
    continue;
  }
  for (const repo of data.items || []) {
    const slug = repo.full_name.toLowerCase();
    if (repo.archived || knownSlugs.has(slug) || ignoredSlugs.has(slug))
      continue;
    const existing = candidates.find((c) => c.full_name.toLowerCase() === slug);
    if (existing) {
      existing.stars = repo.stargazers_count;
      existing.pushed_at = repo.pushed_at;
      continue;
    }
    const haystack = `${repo.name} ${repo.description || ""}`;
    if (!KIT_WORDS.test(haystack)) continue;
    const entry = {
      full_name: repo.full_name,
      url: repo.html_url,
      description: repo.description,
      stars: repo.stargazers_count,
      license: repo.license && repo.license.spdx_id,
      language: repo.language,
      topics: repo.topics || [],
      pushed_at: repo.pushed_at,
      suggested_category: guessCategory(repo),
      found_via: via,
      first_seen: new Date().toISOString().slice(0, 10),
    };
    candidates.push(entry);
    newCandidates.push(entry.full_name);
  }
}

// Drop candidates that were promoted into the catalog or added to ignored.json.
const active = candidates.filter(
  (c) =>
    !knownSlugs.has(c.full_name.toLowerCase()) &&
    !ignoredSlugs.has(c.full_name.toLowerCase()),
);
active.sort((a, b) => (b.stars || 0) - (a.stars || 0));
const trimmed = active.slice(0, MAX_CANDIDATES);
candidatesFile = {
  generated_at: new Date().toISOString(),
  note:
    "Auto-discovered via GitHub search — NOT shown on the site. To promote one, " +
    'add { "name": ..., "repo": <url> } to data/kits.json; update-kits.mjs ' +
    "fills in the remaining fields automatically.",
  candidates: trimmed,
};

/* ------------------------------------------------------------ *
 * Phase 6: write everything                                     *
 * ------------------------------------------------------------ */

writeFileSync(DATA_PATH, JSON.stringify(kept, null, 2) + "\n");
writeFileSync(
  OUT_PATH,
  GENERATED_HEADER + "const KITS = " + JSON.stringify(kept, null, 2) + ";\n",
);
writeFileSync(CANDIDATES_PATH, JSON.stringify(candidatesFile, null, 2) + "\n");
writeFileSync(IGNORED_PATH, JSON.stringify(ignoredFile, null, 2) + "\n");

// Normalise output with prettier so generated files match repo formatting and
// re-runs stay diff-free. Skipped silently if npx/prettier can't run.
try {
  execFileSync(
    "npx",
    [
      "--yes",
      "prettier@3",
      "--write",
      ...[DATA_PATH, OUT_PATH, CANDIDATES_PATH, IGNORED_PATH].map(
        fileURLToPath,
      ),
    ],
    { stdio: "pipe" },
  );
} catch {
  console.warn("prettier skipped (npx unavailable) — files left unformatted.");
}

console.log(
  `Refreshed ${kept.length} kits (max stars: ${maxStars}). ` +
    `${enriched.length} enriched, ${newCandidates.length} new candidates ` +
    `(${trimmed.length} total in data/candidates.json).`,
);
if (enriched.length)
  console.log("Enriched (auto-filled fields): " + enriched.join(", "));
if (removed.length)
  console.warn("REMOVED (repo gone):\n  " + removed.join("\n  "));
if (flagged.length) console.warn("Flagged archived: " + flagged.join(", "));
if (failures.length)
  console.warn("Skipped (kept previous values):\n  " + failures.join("\n  "));
