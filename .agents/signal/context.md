# Project context

- Updated: 2026-10-29
- Repository: DevArtsLab/ai-starter-kits
- Visibility: public
- Context confidence: verified
- Resume use: source material for software-engineering resumes and portfolios.
  Select work relevant to the target role and ground claims in the linked
  implementation and history below.

## Purpose

StarterKit Radar helps developers compare AI starter kits and reference
applications across setup effort, stack coverage, maturity, documentation,
licensing, and cost. It combines a curated catalog, an automated GitHub
metadata pipeline, a controlled discovery queue, and an interactive dashboard.

## Current state

The default branch is `development`; the product is published on GitHub Pages
at https://devartslab.github.io/ai-starter-kits/. The catalog currently
contains 47 kits and the discovery queue contains 9 candidates. These counts
can change during the scheduled refresh, so verify them before using them in
time-sensitive material.

## Technology and architecture

- Static, single-page HTML, CSS, and vanilla JavaScript application; no build
  step or application backend.
- `data/kits.json` is the curated catalog source. `js/kits-data.js` is
  generated from it, while `js/kits-meta.js` derives categories and scores.
- A Node.js script uses the GitHub REST API to refresh repository metadata,
  enrich catalog entries, discover candidates, and regenerate catalog data.
- A weekly GitHub Actions workflow also supports manual dispatch, commits
  generated catalog changes, and triggers the GitHub Pages deployment.
- The shortlist uses the hosted runtime's RESTful Table API, with browser
  local-storage and in-memory fallbacks.

## Key locations

- `index.html`: dashboard entry point.
- `css/`: design system and responsive layouts.
- `js/app.js`: search, filters, sorting, comparisons, charts, shortlist, theme,
  and CSV export.
- `js/kits-meta.js`: derived categories, dimensions, and readiness scores.
- `data/kits.json`: curated catalog source of truth.
- `data/candidates.json`: discovered suggestions awaiting review.
- `data/ignored.json`: repositories excluded from the catalog and discovery.
- `js/kits-data.js`: generated catalog consumed by the page.
- `.github/scripts/update-kits.mjs`: GitHub metadata refresh, entry enrichment,
  license fallback, and candidate discovery.
- `.github/workflows/refresh-kits.yml`: weekly/manual refresh and generated-data
  commit.
- `README.md`: product behavior, data model, architecture, and security notes.

## Verified work and outcomes

- Built the static StarterKit Radar dashboard, including searchable and
  filterable catalog views, multi-attribute sorting, comparison of up to four
  kits, interactive charts, a persistent shortlist, and CSV export. The
  interface also documents responsive layouts and accessibility features.
- Built an automated catalog pipeline that refreshes GitHub stars, license,
  activity, and normalized popularity; regenerates the page's catalog data;
  and commits changes through a weekly or manually triggered GitHub Actions
  workflow.
- Added catalog quality handling: unavailable repositories returning 404/410
  and archived repositories are removed; archived slugs are added to the
  exclusion list to prevent rediscovery.
- Added license detection fallback that inspects common license text when
  GitHub reports `NOASSERTION`.
- Added enrichment for minimal repository entries, filling repository facts
  from GitHub metadata and supplying provisional defaults for editorial fields.
- Built a discovery workflow using six targeted GitHub searches. It
  deduplicates against the catalog and exclusion list, maintains a capped
  queue of up to 150 candidates, and leaves promotion to the catalog as a
  review step.

## Open work and constraints

- Ratings such as difficulty, maturity, documentation quality, and `bestFor`
  are curated editorial estimates, not external benchmarks. Some missing
  values are filled with provisional defaults.
- `popularity` is a derived, log-normalized score; it is not the raw star
  count.
- Candidate discovery populates a review queue; it does not automatically
  publish new catalog entries.
- Shortlist add/delete uses a public, unauthenticated table API; the static
  frontend cannot enforce per-user access.
- Catalog and candidate totals change as scheduled refreshes run.

## Sources

- Product: https://github.com/DevArtsLab/ai-starter-kits
- Live dashboard: https://devartslab.github.io/ai-starter-kits/
- Initial dashboard implementation:
  https://github.com/DevArtsLab/ai-starter-kits/commit/b9bc97116ddb40651a55b110787303c0849d84bc
- Automated refresh:
  https://github.com/DevArtsLab/ai-starter-kits/commit/c7a13cd6f691d6f81f41d505eb929b290835fa3e
- Discovery and enrichment:
  https://github.com/DevArtsLab/ai-starter-kits/commit/324ac6b6c4eddc429fa067f9abfb1020da4ac250
- License fallback and exclusions:
  https://github.com/DevArtsLab/ai-starter-kits/commit/33d064427dc654a671afa3134594f61b8b7954ba
- Archived-repository handling:
  https://github.com/DevArtsLab/ai-starter-kits/commit/6d96266fe9dc74d26332c468e6a970d77dcca305
- `.github/workflows/refresh-kits.yml`
- `.github/scripts/update-kits.mjs`
- `README.md`, `index.html`, `js/app.js`, and `js/kits-meta.js`
