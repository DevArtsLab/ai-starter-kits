/* ============================================================================
   AI Starter Kit Catalog — derived helpers
   ----------------------------------------------------------------------------
   Shared constants and scoring helpers computed from the KITS array defined in
   js/kits-data.js. Load order in index.html: kits-data.js -> kits-meta.js ->
   app.js. Edit this file by hand; kits-data.js itself is generated from
   data/kits.json (see .github/scripts/update-kits.mjs).
   ========================================================================== */

const CATEGORIES = [...new Set(KITS.map((k) => k.category))].sort();

const LANGUAGES = [...new Set(KITS.flatMap((k) => k.languages))].sort();

const LICENSES = [...new Set(KITS.map((k) => k.license))].sort();

const ADVANTAGE_LABELS = {
  hasUI: "Ships a UI",
  hasBackend: "Backend / service included",
  hasEvals: "Eval & tracing hooks",
  requiresKey: "Needs an API key",
  localFirst: "Runs fully local",
};

/** Weighted 0-10 score used for ranking and the radar/scatter charts. */
function computeKitScore(kit) {
  const raw =
    kit.maturity * 0.22 +
    kit.ecosystem * 0.16 +
    kit.docsQuality * 0.16 +
    kit.activityScore * 0.16 +
    kit.costFriendliness * 0.12 +
    (kit.popularity / 10) * 0.18;
  return Math.round(raw * 10) / 10;
}

/** 0-10 → 1-5 dot rating, friendlier to read than a decimal. */
function difficultyLabel(difficulty) {
  return (
    ["", "Beginner", "Easy", "Moderate", "Advanced", "Expert"][difficulty] || "Unknown"
  );
}

KITS.forEach((kit) => {
  kit.score = computeKitScore(kit);
});
