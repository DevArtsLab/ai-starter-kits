# Project context

- Updated: 2026-10-29
- Repository or folder: DevArtsLab/ai-starter-kits
- Visibility: public
- Context confidence: verified

## Purpose

StarterKit Radar is a static dashboard for comparing AI starter kits and
reference applications using setup effort, stack coverage, maturity,
documentation, licensing, and cost dimensions.

## Current state

The default branch is `development`. The latest GitHub repository activity is
at commit `20d9fee`, and the local checkout now matches that branch. The
committed catalog contains 47 kits and the discovery queue contains 3
candidates.

## Technology and architecture

- Single-page HTML, CSS, and vanilla JavaScript; no build step or application
  backend is documented.
- `data/kits.json` is the curated catalog source; `js/kits-data.js` is
  generated from it, and `js/kits-meta.js` derives categories and scores.
- The dashboard supports filtering, sorting, comparisons, charts, shortlist,
  and CSV export.
- A weekly GitHub Actions workflow refreshes factual catalog metadata through
  the GitHub API and commits generated catalog changes.
- The shortlist uses the hosted runtime's RESTful Table API with local storage
  and in-memory fallbacks.

## Key locations

- `index.html`: single-page interface.
- `css/`: styles and responsive layouts.
- `js/app.js`: filtering, comparisons, charts, theme, and shortlist behavior.
- `data/kits.json`: curated source catalog.
- `data/candidates.json`, `data/ignored.json`: discovery queue and exclusions.
- `js/kits-data.js`: generated catalog data.
- `.github/scripts/update-kits.mjs`: GitHub metadata refresh and candidate
  discovery.
- `.github/workflows/refresh-kits.yml`: weekly/manual refresh automation.
- `README.md`: feature, data, architecture, and security notes.

## Verified work and outcomes

- The README documents an automated weekly catalog refresh and manual
  `workflow_dispatch` entry point.
- Candidate discovery does not publish candidates automatically; promoting
  entries is a manual curation step.

## Open work and constraints

- README describes public, unauthenticated shortlist add/delete actions; a
  static frontend cannot enforce per-user permissions.
- Editorial ratings and `bestFor` descriptions are estimates, not external
  benchmarks.
- Catalog totals can change when a scheduled metadata refresh updates the
  repository; recheck the current source before making time-sensitive
  comparisons.

## Sources

- https://github.com/DevArtsLab/ai-starter-kits
- `README.md`
- `.github/workflows/refresh-kits.yml`
- `.github/scripts/update-kits.mjs`
- `index.html`
- `js/app.js`
- `js/kits-meta.js`
