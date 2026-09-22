#!/usr/bin/env node
/* ============================================================================
   Kit catalog refresh — data/kits.json -> js/kits-data.js
   ----------------------------------------------------------------------------
   1. Reads the curated catalog (data/kits.json). Editorial fields like
      difficulty, timeToHelloWorld, bestFor and maturity stay untouched.
   2. Fetches each kit's GitHub repo and refreshes the factual fields:
        stars          <- stargazers_count
        license        <- license.spdx_id (kept if NOASSERTION / missing)
        activityScore  <- recency of pushed_at, bucketed 0-10
        popularity     <- log10(stars) normalised so the top repo scores 100
   3. Writes data/kits.json and regenerates js/kits-data.js.

   Usage:
     node .github/scripts/update-kits.mjs
     GITHUB_TOKEN=ghp_... node .github/scripts/update-kits.mjs

   Unauthenticated works for 48 repos (60 req/hr limit); the workflow passes
   the built-in GITHUB_TOKEN for a comfortable margin.
   ========================================================================== */

import { readFileSync, writeFileSync } from "node:fs";

const DATA_PATH = new URL("../../data/kits.json", import.meta.url);
const OUT_PATH = new URL("../../js/kits-data.js", import.meta.url);
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

function repoSlug(url) {
  const match = /^https?:\/\/github\.com\/([^/]+)\/([^/#?]+)/.exec(url || "");
  return match ? `${match[1]}/${match[2].replace(/\.git$/, "")}` : null;
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

async function fetchRepo(slug) {
  const res = await fetch(`https://api.github.com/repos/${slug}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "starterkit-radar-catalog-refresh",
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const kits = JSON.parse(readFileSync(DATA_PATH, "utf8"));
const results = await Promise.all(
  kits.map(async (kit) => {
    const slug = repoSlug(kit.repo);
    if (!slug) return { kit, repo: null, error: "no github repo" };
    try {
      return { kit, repo: await fetchRepo(slug) };
    } catch (err) {
      return { kit, repo: null, error: err.message };
    }
  }),
);

let updated = 0;
const failures = [];
for (const { kit, repo, error } of results) {
  if (!repo) {
    failures.push(`${kit.id}: ${error}`);
    continue;
  }
  kit.stars = repo.stargazers_count;
  const spdx = repo.license && repo.license.spdx_id;
  if (spdx && spdx !== "NOASSERTION") kit.license = spdx;
  kit.activityScore = activityFromPush(repo.pushed_at);
  updated += 1;
}

const maxStars = Math.max(...kits.map((k) => k.stars || 0), 1);
for (const kit of kits) {
  kit.popularity = Math.max(
    1,
    Math.min(
      100,
      Math.round((100 * Math.log10((kit.stars || 0) + 1)) / Math.log10(maxStars + 1)),
    ),
  );
}

writeFileSync(DATA_PATH, JSON.stringify(kits, null, 2) + "\n");
writeFileSync(
  OUT_PATH,
  GENERATED_HEADER + "const KITS = " + JSON.stringify(kits, null, 2) + ";\n",
);

console.log(
  `Refreshed ${updated}/${kits.length} kits ` +
    `(max stars: ${maxStars}). data/kits.json and js/kits-data.js written.`,
);
if (failures.length) {
  console.warn("Skipped (kept previous values):\n  " + failures.join("\n  "));
}
