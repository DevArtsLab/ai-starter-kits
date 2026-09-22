/* ============================================================================
   StarterKit Radar — application logic
   ----------------------------------------------------------------------------
   Sections:
     1. Small utilities (escaping, toasts, formatting)
     2. Persistence layer  — RESTful Table API with a local fallback
     3. Dashboard state + catalog filtering / sorting / rendering
     4. Comparison table
     5. ECharts insights
     6. Shortlist CRUD
     7. Misc: theme, nav highlighting, CSV export, boot
   ========================================================================== */
(function () {
  "use strict";

  /* ======================================================================== *
   * 1. Utilities
   * ======================================================================== */

  const $ = (sel, root) => (root || document).querySelector(sel);

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /** Only ever emit http(s) links — keeps javascript: URLs out of the DOM. */
  function safeUrl(raw) {
    try {
      const parsed = new URL(String(raw), window.location.href);
      return parsed.protocol === "http:" || parsed.protocol === "https:"
        ? parsed.href
        : "";
    } catch (err) {
      return "";
    }
  }

  function formatDuration(minutes) {
    if (minutes == null) return "—";
    if (minutes < 60) return minutes + " min";
    const hours = Math.round((minutes / 60) * 10) / 10;
    return hours + " hr" + (hours === 1 ? "" : "s");
  }

  function formatStars(stars) {
    if (!stars) return "—";
    if (stars >= 1000)
      return (
        (Math.round(stars / 100) / 10).toFixed(1).replace(/\.0$/, "") + "k"
      );
    return String(stars);
  }

  function formatDate(value) {
    const date = value ? new Date(value) : null;
    if (!date || isNaN(date.getTime())) return "";
    return date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }

  function debounce(fn, wait) {
    let timer = null;
    return function () {
      const args = arguments;
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(null, args), wait);
    };
  }

  function scoreClass(score) {
    if (score >= 7.5) return "high";
    if (score >= 6) return "mid";
    return "low";
  }

  /** Text rendered as plain text — never HTML — so untrusted input is inert. */
  function setText(node, text) {
    if (node) node.textContent = String(text == null ? "" : text);
  }

  const toastStack = $("#toastStack");
  function toast(message, kind) {
    if (!toastStack) return;
    const node = document.createElement("div");
    node.className = "toast " + (kind || "");
    node.textContent = message;
    toastStack.appendChild(node);
    setTimeout(() => {
      node.classList.add("leaving");
      setTimeout(() => node.remove(), 220);
    }, 3600);
  }

  function difficultyDots(level) {
    let out = '<span class="dots" aria-hidden="true">';
    for (let i = 1; i <= 5; i += 1)
      out += '<i class="' + (i <= level ? "on" : "") + '"></i>';
    return out + "</span>";
  }

  /* ======================================================================== *
   * 2. Persistence — RESTful Table API, with localStorage fallback
   * ======================================================================== */

  let localStorageOk = true;
  try {
    window.localStorage.setItem("skr:probe", "1");
    window.localStorage.removeItem("skr:probe");
  } catch (err) {
    localStorageOk = false;
  }
  const memoryStore = {};

  const Local = {
    read(table) {
      if (!localStorageOk) return (memoryStore[table] || []).slice();
      try {
        const raw = window.localStorage.getItem("skr:" + table);
        return raw ? JSON.parse(raw) : [];
      } catch (err) {
        return [];
      }
    },
    write(table, rows) {
      if (!localStorageOk) {
        memoryStore[table] = rows.slice();
        return;
      }
      try {
        window.localStorage.setItem("skr:" + table, JSON.stringify(rows));
      } catch (err) {
        memoryStore[table] = rows.slice();
      }
    },
  };

  /* Start optimistic: the preview/hosted runtime serves tables/* on this origin.
     If the first request fails we degrade to localStorage for the session.
     Reads fail silently; the one-time toast only fires on the first write. */
  let apiOk = true;
  let apiWarned = false;
  let apiFailReason = "";

  function degradeToLocal(reason) {
    apiOk = false;
    apiFailReason = reason;
  }

  function warnStorageOnce() {
    if (apiWarned) return;
    apiWarned = true;
    toast(
      "Storage API unavailable — changes are kept in this browser only" +
        (apiFailReason ? " (" + apiFailReason + ")" : "") +
        ".",
      "warn",
    );
  }

  async function listRows(table) {
    if (apiOk) {
      try {
        const res = await fetch("tables/" + table + "?limit=200");
        if (!res.ok) throw new Error("HTTP " + res.status);
        const payload = await res.json();
        return Array.isArray(payload.data) ? payload.data : [];
      } catch (err) {
        degradeToLocal(err.message || "request failed");
      }
    }
    return Local.read(table);
  }

  function localId() {
    return "local-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
  }

  async function addRow(table, row) {
    if (apiOk) {
      try {
        const res = await fetch("tables/" + table, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(row),
        });
        if (!res.ok) throw new Error("HTTP " + res.status);
        return await res.json();
      } catch (err) {
        degradeToLocal(err.message || "request failed");
      }
    }
    warnStorageOnce();
    const record = Object.assign(
      { id: localId(), created_at: Date.now() },
      row,
    );
    const rows = Local.read(table);
    rows.push(record);
    Local.write(table, rows);
    return record;
  }

  async function deleteRow(table, id) {
    if (apiOk && String(id).indexOf("local-") !== 0) {
      try {
        const res = await fetch(
          "tables/" + table + "/" + encodeURIComponent(id),
          {
            method: "DELETE",
          },
        );
        if (res.ok || res.status === 204) return true;
        throw new Error("HTTP " + res.status);
      } catch (err) {
        degradeToLocal(err.message || "request failed");
      }
    }
    warnStorageOnce();
    const rows = Local.read(table).filter((r) => r.id !== id);
    Local.write(table, rows);
    return true;
  }

  /* ======================================================================== *
   * 3. State + catalog rendering
   * ======================================================================== */

  const state = {
    search: "",
    category: "",
    language: "",
    license: "",
    maxDifficulty: 5,
    maxTTW: 999,
    requiresLocal: false,
    requiresKeyless: false,
    requiresUI: false,
    requiresEvals: false,
    sort: "score",
    view: "cards",
    compare: [],
    shortlist: new Set(),
    shortlistRows: [],
    chart: "category",
  };

  const MAX_COMPARE = 4;

  const byId = {};
  KITS.forEach((kit) => {
    byId[kit.id] = kit;
  });

  function matchesFilters(kit) {
    const q = state.search.trim().toLowerCase();
    if (q) {
      const haystack = [
        kit.name,
        kit.org,
        kit.category,
        kit.bestFor,
        kit.pricing,
        kit.license,
      ]
        .concat(kit.languages, kit.models)
        .join(" ")
        .toLowerCase();
      if (haystack.indexOf(q) === -1) return false;
    }
    if (state.category && kit.category !== state.category) return false;
    if (state.language && kit.languages.indexOf(state.language) === -1)
      return false;
    if (state.license && kit.license !== state.license) return false;
    if (kit.difficulty > state.maxDifficulty) return false;
    if (kit.timeToHelloWorld > state.maxTTW) return false;
    if (state.requiresLocal && !kit.localFirst) return false;
    if (state.requiresKeyless && kit.requiresKey) return false;
    if (state.requiresUI && !kit.hasUI) return false;
    if (state.requiresEvals && !kit.hasEvals) return false;
    return true;
  }

  const SORTERS = {
    score: (a, b) => b.score - a.score || b.popularity - a.popularity,
    popularity: (a, b) => b.popularity - a.popularity || b.score - a.score,
    timeToHelloWorld: (a, b) =>
      a.timeToHelloWorld - b.timeToHelloWorld || b.score - a.score,
    difficulty: (a, b) => a.difficulty - b.difficulty || b.score - a.score,
    maturity: (a, b) => b.maturity - a.maturity || b.score - a.score,
    costFriendliness: (a, b) =>
      b.costFriendliness - a.costFriendliness || b.score - a.score,
    name: (a, b) => a.name.localeCompare(b.name),
  };

  function visibleKits() {
    const rows = KITS.filter(matchesFilters);
    rows.sort(SORTERS[state.sort] || SORTERS.score);
    return rows;
  }

  function kitCard(kit) {
    const compared = state.compare.indexOf(kit.id) !== -1;
    const shortlisted = state.shortlist.has(kit.id);
    const pct = Math.round((kit.score / 10) * 100);
    const repo = safeUrl(kit.repo);
    const docs = safeUrl(kit.docs);
    const models =
      kit.models.slice(0, 3).join(", ") +
      (kit.models.length > 3 ? " +" + (kit.models.length - 3) : "");

    return [
      '<article class="kit-card' +
        (compared ? " is-compared" : "") +
        (shortlisted ? " is-shortlisted" : "") +
        '" data-kit="' +
        esc(kit.id) +
        '">',
      '  <div class="kit-card-top">',
      "    <div>",
      '      <h3 class="kit-title">' + esc(kit.name) + "</h3>",
      '      <p class="kit-org">' +
        esc(kit.org) +
        " · " +
        esc(kit.license) +
        "</p>",
      "    </div>",
      '    <div class="score-ring ' +
        scoreClass(kit.score) +
        '" style="--pct:' +
        pct +
        '" role="img" aria-label="Readiness score ' +
        kit.score +
        ' out of 10">',
      "      <span>" + kit.score.toFixed(1) + "</span>",
      "    </div>",
      "  </div>",
      '  <p class="kit-desc">' + esc(kit.bestFor) + "</p>",
      '  <div class="badge-row">',
      '    <span class="badge badge-category">' + esc(kit.category) + "</span>",
      kit.localFirst
        ? '<span class="badge badge-ok"><i class="fas fa-plug-circle-xmark"></i> Local</span>'
        : "",
      kit.requiresKey
        ? '<span class="badge badge-warn"><i class="fas fa-key"></i> Key needed</span>'
        : "",
      kit.hasUI
        ? '<span class="badge"><i class="fas fa-window-maximize"></i> UI</span>'
        : "",
      kit.hasEvals
        ? '<span class="badge"><i class="fas fa-vial"></i> Evals</span>'
        : "",

      "  </div>",
      '  <div class="kit-metrics">',
      '    <div class="metric"><span class="metric-label">Hello world</span><span class="metric-value">' +
        esc(formatDuration(kit.timeToHelloWorld)) +
        "</span></div>",
      '    <div class="metric"><span class="metric-label">Difficulty</span><span class="metric-value">' +
        esc(difficultyLabel(kit.difficulty)) +
        difficultyDots(kit.difficulty) +
        "</span></div>",
      '    <div class="metric"><span class="metric-label">Stars</span><span class="metric-value">' +
        esc(formatStars(kit.stars)) +
        "</span></div>",
      "  </div>",
      kit.models.length
        ? '  <p class="kit-models"><strong>Models:</strong> ' +
          esc(models) +
          "</p>"
        : "",
      '  <div class="kit-actions">',
      repo
        ? '<a class="btn btn-sm" href="' +
          esc(repo) +
          '" target="_blank" rel="noopener noreferrer"><i class="fas fa-code-branch"></i> Repo</a>'
        : "",
      docs
        ? '<a class="btn btn-sm" href="' +
          esc(docs) +
          '" target="_blank" rel="noopener noreferrer"><i class="fas fa-book"></i> Docs</a>'
        : "",
      '    <button type="button" class="btn btn-sm" data-action="compare" data-kit="' +
        esc(kit.id) +
        '" aria-pressed="' +
        compared +
        '">',
      '      <i class="fas fa-scale-balanced"></i> ' +
        (compared ? "Selected" : "Compare"),
      "    </button>",
      '    <button type="button" class="btn btn-sm ' +
        (shortlisted ? "btn-primary" : "") +
        '" data-action="shortlist" data-kit="' +
        esc(kit.id) +
        '">',
      '      <i class="fas fa-' +
        (shortlisted ? "check" : "plus") +
        '"></i> ' +
        (shortlisted ? "Saved" : "Shortlist"),
      "    </button>",
      "  </div>",
      "</article>",
    ].join("\n");
  }

  function kitTableRow(kit) {
    return [
      "<tr>",
      '  <td class="cell-kit"><strong>' +
        esc(kit.name) +
        "</strong><span>" +
        esc(kit.org) +
        "</span></td>",
      "  <td>" + esc(kit.category) + "</td>",
      "  <td><strong>" + kit.score.toFixed(1) + "</strong></td>",
      "  <td>" + esc(formatDuration(kit.timeToHelloWorld)) + "</td>",
      "  <td>" + esc(difficultyLabel(kit.difficulty)) + "</td>",
      "  <td>" + esc(kit.license) + "</td>",
      "  <td>" + esc(kit.languages.join(", ")) + "</td>",
      '  <td class="cell-actions">',
      '    <button type="button" class="btn btn-sm" data-action="compare" data-kit="' +
        esc(kit.id) +
        '" title="Add to comparison"><i class="fas fa-scale-balanced"></i></button>',
      '    <button type="button" class="btn btn-sm' +
        (state.shortlist.has(kit.id) ? " btn-primary" : "") +
        '" data-action="shortlist" data-kit="' +
        esc(kit.id) +
        '" title="Add to shortlist"><i class="fas fa-star"></i></button>',
      "  </td>",
      "</tr>",
    ].join("");
  }

  function renderCatalog() {
    const rows = visibleKits();
    const grid = $("#catalogGrid");
    const tableBody = $("#catalogTableBody");
    const tableWrap = $("#catalogTableWrap");
    const empty = $("#catalogEmpty");

    if (rows.length === 0) {
      grid.innerHTML = "";
      tableBody.innerHTML = "";
    } else if (state.view === "cards") {
      grid.innerHTML = rows.map(kitCard).join("\n");
    } else {
      tableBody.innerHTML = rows.map(kitTableRow).join("\n");
    }

    grid.hidden = state.view !== "cards" || rows.length === 0;
    tableWrap.hidden = state.view !== "table" || rows.length === 0;
    empty.hidden = rows.length !== 0;

    setText(
      $("#resultCount"),
      rows.length +
        (rows.length === 1 ? " kit" : " kits") +
        " shown of " +
        KITS.length,
    );
  }

  function renderStats() {
    setText($("#statTotal"), KITS.length);
    setText($("#statCategories"), CATEGORIES.length);
    setText(
      $("#statFast"),
      KITS.filter((k) => k.timeToHelloWorld <= 15).length,
    );
    setText($("#statLocal"), KITS.filter((k) => k.localFirst).length);
    setText($("#statBeginner"), KITS.filter((k) => k.difficulty <= 2).length);
    const avg = KITS.reduce((sum, k) => sum + k.score, 0) / KITS.length;
    setText($("#statAvgScore"), avg.toFixed(1));
  }

  /* ======================================================================== *
   * 4. Comparison table
   * ======================================================================== */

  function compareRow(label, getter, bestMode) {
    const kits = state.compare.map((id) => byId[id]).filter(Boolean);
    const values = kits.map(getter);
    let bestIndex = -1;
    if (bestMode === "max") {
      values.forEach((v, i) => {
        if (bestIndex === -1 || v > values[bestIndex]) bestIndex = i;
      });
    } else if (bestMode === "min") {
      values.forEach((v, i) => {
        if (bestIndex === -1 || v < values[bestIndex]) bestIndex = i;
      });
    }
    // Only flag a winner when the row actually discriminates.
    const allSame = values.every((v) => String(v) === String(values[0]));
    if (allSame) bestIndex = -1;

    return (
      '<tr><th scope="row">' +
      esc(label) +
      "</th>" +
      values
        .map(
          (v, i) =>
            '<td class="' +
            (i === bestIndex ? "cmp-best" : "") +
            '">' +
            esc(v == null ? "—" : v) +
            "</td>",
        )
        .join("") +
      "</tr>"
    );
  }

  function yesNo(flag) {
    return flag ? "Yes" : "No";
  }

  function renderCompare() {
    const body = $("#compareBody");
    const kits = state.compare.map((id) => byId[id]).filter(Boolean);

    if (kits.length < 1) {
      body.innerHTML =
        '<p class="empty-state"><i class="fas fa-scale-balanced" aria-hidden="true"></i>' +
        "Nothing selected yet — choose <em>Compare</em> on a couple of kit cards.</p>";
      return;
    }

    const head =
      '<thead><tr><th scope="col">Attribute</th>' +
      kits
        .map(
          (k) =>
            '<th scope="col"><span class="cmp-name">' +
            esc(k.name) +
            '</span><span class="cmp-org">' +
            esc(k.org) +
            "</span></th>",
        )
        .join("") +
      "</tr></thead>";

    const rows = [
      compareRow("Category", (k) => k.category),
      compareRow("Readiness score", (k) => k.score, "max"),
      compareRow(
        "Hello world",
        (k) => formatDuration(k.timeToHelloWorld),
        "min",
      ),
      compareRow("Difficulty", (k) => difficultyLabel(k.difficulty), "min"),
      compareRow("Maturity", (k) => k.maturity + "/10", "max"),
      compareRow("Ecosystem", (k) => k.ecosystem + "/10", "max"),
      compareRow("Docs quality", (k) => k.docsQuality + "/10", "max"),
      compareRow("Maintenance activity", (k) => k.activityScore + "/10", "max"),
      compareRow("Cost friendliness", (k) => k.costFriendliness + "/10", "max"),
      compareRow("Licence", (k) => k.license),
      compareRow("Languages", (k) => k.languages.join(", ")),
      compareRow("Model providers", (k) => k.models.join(", ")),
      compareRow("Cost model", (k) => k.pricing),
      compareRow("GitHub stars", (k) => formatStars(k.stars), "max"),
      compareRow("Ships a UI", (k) => yesNo(k.hasUI)),
      compareRow("Backend included", (k) => yesNo(k.hasBackend)),
      compareRow("Eval / tracing", (k) => yesNo(k.hasEvals)),
      compareRow("Runs fully local", (k) => yesNo(k.localFirst)),
      compareRow("API key required", (k) => yesNo(k.requiresKey), "min"),
      compareRow("Best for", (k) => k.bestFor),
    ].join("");

    body.innerHTML =
      '<table class="compare-table">' +
      head +
      "<tbody>" +
      rows +
      "</tbody></table>";
  }

  function toggleCompare(kitId) {
    const index = state.compare.indexOf(kitId);
    if (index !== -1) {
      state.compare.splice(index, 1);
    } else if (state.compare.length >= MAX_COMPARE) {
      toast(
        "You can compare " + MAX_COMPARE + " kits at once — remove one first.",
        "warn",
      );
      return;
    } else {
      state.compare.push(kitId);
      const section = $("#compare-section");
      if (section && state.compare.length === 2)
        section.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    renderCompare();
    renderCatalog();
  }

  /* ======================================================================== *
   * 5. Insights charts
   * ======================================================================== */

  const chartInstances = {};

  /* Chart axis labels are a presentation concern: long catalog names get a
     purpose-built short form so nothing is ever clipped mid-word. */
  const CATEGORY_SHORT = {
    "Evaluation / Observability": "Eval & Observability",
    "Model Serving / Inference": "Model Serving",
    "Full-Stack Web App": "Full-Stack Web",
    "Data & Notebook App": "Data & Notebooks",
    "Reference / Cookbook": "Cookbooks",
    "Enterprise / Cloud": "Enterprise Cloud",
    "Guardrails / Safety": "Guardrails",
    "Image / Generation": "Image Generation",
    "Vision / Multimodal": "Vision",
    "Tooling / MCP": "MCP & Tooling",
    "Agent Framework": "Agent Frameworks",
  };

  const KIT_SHORT = {
    "vercel-ai-sdk-starter": "Vercel AI SDK",
    "langchain-quickstart": "LangChain",
    "llamaindex-starter": "LlamaIndex",
    "huggingface-transformers-starter": "HF Transformers",
    "llama-cpp-quickstart": "llama.cpp",
    "ultralytics-yolo": "Ultralytics YOLO",
    "diffusers-starter": "HF Diffusers",
    "gradio-interface": "Gradio",
    "ollama-playground": "Ollama",
    "comfyui-workflows": "ComfyUI",
    "nemo-guardrails": "NeMo Guardrails",
    "automatic1111-webui": "AUTOMATIC1111",
  };

  function shortCategory(name) {
    return CATEGORY_SHORT[name] || name;
  }

  function shortKit(kit) {
    return KIT_SHORT[kit.id] || kit.name;
  }

  /**
   * Charts live in panels that start hidden (table view) or below the fold, so a
   * chart initialised at zero size would stay blank. Skip those, and explicitly
   * resize whenever a chart gets a real width.
   */
  function initChart(host) {
    if (!host.clientWidth) return null;
    const instance = echarts.init(host, null, { renderer: "canvas" });
    instance.resize();
    return instance;
  }

  const SERIES_HUES = [228, 168, 108, 48, 348, 288];

  function chartPalette() {
    const styles = getComputedStyle(document.documentElement);
    const read = (name, fallback) =>
      (styles.getPropertyValue(name) || fallback).trim() || fallback;
    return {
      text: read("--text-dim", "#a3aec9"),
      title: read("--text", "#e8ecf8"),
      split: read("--border-soft", "#1b2440"),
      surface: read("--bg-elev-2", "#182240"),
      series: SERIES_HUES.map((h) => `hsl(${h}, 65%, 72%)`),
    };
  }

  function baseOption(palette) {
    return {
      color: palette.series,
      textStyle: {
        fontFamily: "Inter, system-ui, sans-serif",
        color: palette.text,
        fontSize: 12,
      },
      tooltip: {
        backgroundColor: palette.surface,
        borderColor: palette.split,
        textStyle: { color: palette.title, fontSize: 12 },
        confine: true,
      },
      grid: { left: 6, right: 14, top: 16, bottom: 6, containLabel: true },
    };
  }

  function countBy(list, keyFn) {
    const map = new Map();
    list.forEach((item) => {
      const key = keyFn(item);
      map.set(key, (map.get(key) || 0) + 1);
    });
    return map;
  }

  const MAIN_CHARTS = {
    category: {
      caption: "Kits per category — where the ecosystem is crowded",
      build(palette, kits) {
        const counts = [...countBy(kits, (k) => k.category).entries()].sort(
          (a, b) => a[1] - b[1],
        );
        const maxCount = counts.length ? counts[counts.length - 1][1] : 1;
        const option = baseOption(palette);
        option.grid.left = 10;
        option.grid.right = 44;
        option.xAxis = {
          type: "value",
          max: Math.ceil(maxCount * 1.2),
          minInterval: 1,
          splitLine: { lineStyle: { color: palette.split } },
          axisLabel: { color: palette.text },
        };
        option.yAxis = {
          type: "category",
          data: counts.map((c) => shortCategory(c[0])),
          axisLabel: { color: palette.text, width: 150, overflow: "truncate" },
          axisLine: { lineStyle: { color: palette.split } },
        };
        option.series = [
          {
            type: "bar",
            data: counts.map((c) => c[1]),
            barWidth: "58%",
            itemStyle: { borderRadius: [0, 5, 5, 0], color: palette.series[0] },
            label: {
              show: true,
              position: "right",
              distance: 6,
              fontSize: 13,
              fontWeight: 600,
              color: palette.title,
            },
          },
        ];
        return option;
      },
    },
    speed: {
      caption: "Time to a working hello world, bucketed",
      build(palette, kits) {
        const buckets = [
          ["≤ 5 min", 0, 5],
          ["6–15 min", 5, 15],
          ["16–30 min", 15, 30],
          ["31–60 min", 30, 60],
          ["60+ min", 60, Infinity],
        ].map((b) => ({
          label: b[0],
          count: kits.filter(
            (k) => k.timeToHelloWorld > b[1] && k.timeToHelloWorld <= b[2],
          ).length,
        }));
        const option = baseOption(palette);
        option.xAxis = {
          type: "category",
          data: buckets.map((b) => b.label),
          axisLabel: { color: palette.text },
          axisLine: { lineStyle: { color: palette.split } },
        };
        option.yAxis = {
          type: "value",
          splitLine: { lineStyle: { color: palette.split } },
          axisLabel: { color: palette.text },
        };
        option.series = [
          {
            type: "bar",
            data: buckets.map((b, i) => ({
              value: b.count,
              itemStyle: {
                color: palette.series[i % palette.series.length],
                borderRadius: [5, 5, 0, 0],
              },
            })),
            barWidth: "52%",
            label: { show: true, position: "top", color: palette.text },
          },
        ];
        return option;
      },
    },
    tradeoff: {
      caption: "Setup effort vs. readiness — bubble size is popularity",
      build(palette, kits) {
        const option = baseOption(palette);
        option.grid = {
          left: 6,
          right: 26,
          top: 20,
          bottom: 6,
          containLabel: true,
        };
        option.xAxis = {
          type: "value",
          name: "Minutes to hello world",
          nameLocation: "middle",
          nameGap: 26,
          nameTextStyle: { color: palette.text },
          splitLine: { lineStyle: { color: palette.split } },
          axisLabel: { color: palette.text },
        };
        option.yAxis = {
          type: "value",
          name: "Readiness",
          min: 4,
          max: 10,
          splitLine: { lineStyle: { color: palette.split } },
          axisLabel: { color: palette.text },
        };
        option.series = [
          {
            type: "scatter",
            symbolSize: (value) => 8 + (value[2] / 100) * 22,
            data: kits.map((k) => ({
              value: [k.timeToHelloWorld, k.score, k.popularity],
              name: k.name,
              itemStyle: {
                color: palette.series[k.difficulty % palette.series.length],
                opacity: 0.82,
              },
            })),
            emphasis: {
              focus: "series",
              label: {
                show: true,
                formatter: (p) => p.data.name,
                color: palette.title,
                position: "top",
              },
            },
          },
        ];
        option.tooltip.formatter = (p) =>
          p.data.name + "<br/>" + p.value[0] + " min · score " + p.value[1];
        return option;
      },
    },
    licence: {
      caption: "Licence mix across the catalog",
      build(palette, kits) {
        const counts = [...countBy(kits, (k) => k.license).entries()].sort(
          (a, b) => b[1] - a[1],
        );
        const top = counts.slice(0, 6);
        const rest = counts.slice(6).reduce((sum, c) => sum + c[1], 0);
        const data = top.map((c) => ({ name: c[0], value: c[1] }));
        if (rest > 0) data.push({ name: "Other", value: rest });

        const option = baseOption(palette);
        option.tooltip.trigger = "item";
        option.legend = {
          bottom: 0,
          textStyle: { color: palette.text },
          icon: "circle",
          itemWidth: 9,
          itemHeight: 9,
          type: "scroll",
        };
        option.series = [
          {
            type: "pie",
            radius: ["42%", "70%"],
            center: ["50%", "44%"],
            avoidLabelOverlap: true,
            itemStyle: { borderColor: palette.surface, borderWidth: 2 },
            label: { color: palette.text, formatter: "{b}\n{c}" },
            labelLine: { lineStyle: { color: palette.split } },
            data: data,
          },
        ];
        return option;
      },
    },
  };

  function renderMainChart() {
    const host = $("#mainChart");
    if (!host || typeof echarts === "undefined") return;
    const config = MAIN_CHARTS[state.chart] || MAIN_CHARTS.category;
    setText($("#mainChartCaption"), config.caption);
    if (!chartInstances.main) chartInstances.main = initChart(host);
    if (!chartInstances.main) return;
    const palette = chartPalette();
    chartInstances.main.setOption(config.build(palette, visibleKits()), true);
  }

  function renderTopChart() {
    const host = $("#topChart");
    if (!host || typeof echarts === "undefined") return;
    const top = KITS.slice().sort(SORTERS.score).slice(0, 8).reverse();
    if (!chartInstances.top) chartInstances.top = initChart(host);
    if (!chartInstances.top) return;
    const palette = chartPalette();
    const option = baseOption(palette);
    option.grid.left = 8;
    option.grid.right = 46;
    option.tooltip.formatter = (p) => p.name + " — " + p.value + "/10";
    option.xAxis = {
      type: "value",
      max: 10,
      maxInterval: 2,
      splitLine: { lineStyle: { color: palette.split } },
      axisLabel: { color: palette.text },
    };
    option.yAxis = {
      type: "category",
      data: top.map(shortKit),
      axisLabel: { color: palette.text, width: 118, overflow: "truncate" },
      axisLine: { lineStyle: { color: palette.split } },
    };
    option.series = [
      {
        type: "bar",
        data: top.map((k) => ({ value: k.score, name: k.name })),
        barWidth: "55%",
        itemStyle: {
          borderRadius: [0, 5, 5, 0],
          color: (p) => `hsl(228, 70%, ${78 - p.dataIndex * 4}%)`,
        },
        label: {
          show: true,
          position: "right",
          distance: 6,
          fontSize: 14,
          fontWeight: 600,
          color: palette.title,
          formatter: "{c}",
        },
      },
    ];
    chartInstances.top.setOption(option, true);
  }

  function renderCharts() {
    renderMainChart();
    renderTopChart();
  }

  function resizeCharts() {
    Object.keys(chartInstances).forEach((key) => {
      if (chartInstances[key]) chartInstances[key].resize();
    });
  }

  /* ======================================================================== *
   * 6. Shortlist
   * ======================================================================== */

  const SEED_SHORTLIST = [
    {
      kit_id: "ollama-playground",
      kit_name: "Ollama Local Playground",
      note: "Zero-cost starting point for local prototyping — seeded example.",
    },
    {
      kit_id: "vercel-ai-sdk-starter",
      kit_name: "Vercel AI SDK Starter",
      note: "Fastest route to a streaming chat feature in Next.js — seeded example.",
    },
    {
      kit_id: "langfuse-observability",
      kit_name: "Langfuse Observability Starter",
      note: "Add tracing before shipping anything to real users — seeded example.",
    },
  ];

  function renderShortlist() {
    const body = $("#shortlistBody");
    const rows = state.shortlistRows
      .slice()
      .sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0));

    setText($("#shortlistNavCount"), rows.length);

    if (rows.length === 0) {
      body.innerHTML =
        '<p class="empty-state"><i class="fas fa-star" aria-hidden="true"></i>' +
        "Your shortlist is empty. Hit <em>Shortlist</em> on any kit card to keep it here.</p>";
      return;
    }

    body.innerHTML = rows
      .map((row, index) => {
        const kit = byId[row.kit_id];
        const name = kit
          ? kit.name
          : row.kit_name || row.kit_id || "Unknown kit";
        const org = kit
          ? kit.org + " · " + kit.category
          : "Not in the current catalog";
        const repo = kit ? safeUrl(kit.repo) : "";
        return [
          '<div class="shortlist-row" data-row="' + esc(row.id) + '">',
          '  <span class="shortlist-rank">' + (index + 1) + "</span>",
          '  <div class="shortlist-info"><strong>' +
            esc(name) +
            "</strong><small>" +
            esc(org) +
            "</small></div>",
          '  <p class="shortlist-note">' +
            esc(row.note || "No note yet.") +
            "</p>",
          '  <span class="shortlist-meta">' +
            esc(formatDate(row.created_at || row.added_at) || "—") +
            "</span>",
          '  <div class="kit-actions">',
          repo
            ? '<a class="btn btn-sm" href="' +
              esc(repo) +
              '" target="_blank" rel="noopener noreferrer"><i class="fas fa-code-branch"></i></a>'
            : "",
          '    <button type="button" class="btn btn-sm btn-danger" data-remove="' +
            esc(row.id) +
            '"><i class="fas fa-trash-can"></i> Remove</button>',
          "  </div>",
          "</div>",
        ].join("");
      })
      .join("\n");
  }

  async function loadShortlist(options) {
    const rows = await listRows("shortlist");

    if (rows.length === 0 && !(options && options.skipSeed)) {
      for (let i = 0; i < SEED_SHORTLIST.length; i += 1) {
        const seed = SEED_SHORTLIST[i];
        // Stagger ids/timestamps so ordering stays stable.
        await addRow(
          "shortlist",
          Object.assign(
            { added_at: new Date().toISOString(), created_at: Date.now() + i },
            seed,
          ),
        );
      }
      state.shortlistRows = await listRows("shortlist");
    } else {
      state.shortlistRows = rows;
    }

    state.shortlist = new Set(state.shortlistRows.map((r) => r.kit_id));
    renderShortlist();
    renderCatalog();
  }

  async function addToShortlist(kitId) {
    const kit = byId[kitId];
    if (!kit) return;
    if (state.shortlist.has(kitId)) {
      toast("Already on your shortlist.", "warn");
      return;
    }
    await addRow("shortlist", {
      kit_id: kit.id,
      kit_name: kit.name,
      note: "Shortlisted from the catalog — " + kit.category + ".",
      added_at: new Date().toISOString(),
    });
    await loadShortlist({ skipSeed: true });
    toast(kit.name + " added to your shortlist.", "ok");
  }

  async function removeFromShortlist(rowId) {
    await deleteRow("shortlist", rowId);
    await loadShortlist({ skipSeed: true });
    toast("Removed from your shortlist.", "ok");
  }

  /* ======================================================================== *
   * 7. Misc — theme, nav, export, wiring, boot
   * ======================================================================== */

  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    const button = $("#themeToggle");
    if (button) {
      button.setAttribute("aria-pressed", String(theme === "light"));
      const icon = $("i", button);
      if (icon)
        icon.className = theme === "light" ? "fas fa-sun" : "fas fa-moon";
      button.title =
        theme === "light" ? "Switch to dark mode" : "Switch to light mode";
    }
    try {
      window.localStorage.setItem("skr:theme", theme);
    } catch (err) {
      /* ignore */
    }
  }

  function initTheme() {
    let theme = "dark";
    try {
      const saved = window.localStorage.getItem("skr:theme");
      if (saved === "light" || saved === "dark") {
        theme = saved;
      } else if (
        window.matchMedia &&
        window.matchMedia("(prefers-color-scheme: light)").matches
      ) {
        theme = "light";
      }
    } catch (err) {
      /* ignore */
    }
    applyTheme(theme);
  }

  function initNavHighlight() {
    const links = Array.prototype.slice.call(
      document.querySelectorAll(".topnav-link"),
    );
    const sections = links
      .map((link) => document.querySelector(link.getAttribute("href")))
      .filter(Boolean);
    if (!sections.length || typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          links.forEach((link) => {
            link.classList.toggle(
              "active",
              link.getAttribute("href") === "#" + entry.target.id,
            );
          });
        });
      },
      { rootMargin: "-88px 0px -65% 0px", threshold: 0 },
    );
    sections.forEach((section) => observer.observe(section));
  }

  function exportCsv() {
    const headers = [
      "name",
      "org",
      "category",
      "license",
      "languages",
      "models",
      "difficulty",
      "difficulty_label",
      "time_to_hello_world_min",
      "maturity",
      "ecosystem",
      "docs_quality",
      "activity",
      "cost_friendliness",
      "popularity",
      "stars",
      "score",
      "local_first",
      "requires_key",
      "has_ui",
      "has_evals",
      "repo",
    ];
    const csvEscape = (value) => '"' + String(value).replace(/"/g, '""') + '"';
    const lines = [headers.join(",")];
    visibleKits().forEach((kit) => {
      lines.push(
        [
          kit.name,
          kit.org,
          kit.category,
          kit.license,
          kit.languages.join(" / "),
          kit.models.join(" / "),
          kit.difficulty,
          difficultyLabel(kit.difficulty),
          kit.timeToHelloWorld,
          kit.maturity,
          kit.ecosystem,
          kit.docsQuality,
          kit.activityScore,
          kit.costFriendliness,
          kit.popularity,
          kit.stars,
          kit.score,
          kit.localFirst,
          kit.requiresKey,
          kit.hasUI,
          kit.hasEvals,
          kit.repo,
        ]
          .map(csvEscape)
          .join(","),
      );
    });

    const blob = new Blob([lines.join("\n")], {
      type: "text/csv;charset=utf-8;",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "ai-starter-kits.csv";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast("Exported " + (lines.length - 1) + " rows to CSV.", "ok");
  }

  function fillSelect(select, values, allLabel) {
    if (!select) return;
    select.innerHTML = '<option value="">' + esc(allLabel) + "</option>";
    values.forEach((value) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value;
      select.appendChild(option);
    });
  }

  function populateSelects() {
    fillSelect($("#categorySelect"), CATEGORIES, "All categories");
    fillSelect($("#languageSelect"), LANGUAGES, "All languages");
    fillSelect($("#licenseSelect"), LICENSES, "Any licence");
  }

  function wireControls() {
    const onFilterChange = () => {
      state.search = $("#searchInput").value;
      state.category = $("#categorySelect").value;
      state.language = $("#languageSelect").value;
      state.license = $("#licenseSelect").value;
      state.maxDifficulty = Number($("#maxDifficulty").value);
      state.maxTTW = Number($("#maxTTW").value);
      state.requiresLocal = $("#filterLocal").checked;
      state.requiresKeyless = $("#filterKeyless").checked;
      state.requiresUI = $("#filterUI").checked;
      state.requiresEvals = $("#filterEvals").checked;
      state.sort = $("#sortSelect").value;
      renderCatalog();
      renderMainChart();
    };

    $("#searchInput").addEventListener("input", debounce(onFilterChange, 160));
    [
      "#categorySelect",
      "#languageSelect",
      "#licenseSelect",
      "#maxDifficulty",
      "#maxTTW",
      "#sortSelect",
    ].forEach((sel) => {
      $(sel).addEventListener("change", onFilterChange);
    });
    ["#filterLocal", "#filterKeyless", "#filterUI", "#filterEvals"].forEach(
      (sel) => {
        $(sel).addEventListener("change", onFilterChange);
      },
    );

    $("#resetFilters").addEventListener("click", () => {
      $("#searchInput").value = "";
      $("#categorySelect").value = "";
      $("#languageSelect").value = "";
      $("#licenseSelect").value = "";
      $("#maxDifficulty").value = "5";
      $("#maxTTW").value = "999";
      $("#sortSelect").value = "score";
      ["#filterLocal", "#filterKeyless", "#filterUI", "#filterEvals"].forEach(
        (sel) => {
          $(sel).checked = false;
        },
      );
      onFilterChange();
      toast("Filters reset.", "ok");
    });

    $("#viewCards").addEventListener("click", () => setView("cards"));
    $("#viewTable").addEventListener("click", () => setView("table"));

    document.querySelectorAll("[data-chart]").forEach((button) => {
      button.addEventListener("click", () => {
        state.chart = button.getAttribute("data-chart");
        document.querySelectorAll("[data-chart]").forEach((other) => {
          const active = other === button;
          other.classList.toggle("active", active);
          other.setAttribute("aria-pressed", String(active));
        });
        renderMainChart();
      });
    });

    $("#clearCompare").addEventListener("click", () => {
      state.compare = [];
      renderCompare();
      renderCatalog();
    });

    $("#refreshShortlist").addEventListener("click", async () => {
      await loadShortlist({ skipSeed: true });
      toast("Shortlist refreshed.", "ok");
    });

    $("#themeToggle").addEventListener("click", () => {
      const next =
        document.documentElement.getAttribute("data-theme") === "light"
          ? "dark"
          : "light";
      applyTheme(next);
      renderCharts();
    });

    $("#exportBtn").addEventListener("click", exportCsv);

    // Delegated handlers for dynamically rendered cards / rows.
    document.addEventListener("click", (event) => {
      const actionButton = event.target.closest("[data-action]");
      if (actionButton) {
        const kitId = actionButton.getAttribute("data-kit");
        if (actionButton.getAttribute("data-action") === "compare")
          toggleCompare(kitId);
        if (actionButton.getAttribute("data-action") === "shortlist")
          addToShortlist(kitId);
        return;
      }
      const removeShortlist = event.target.closest("[data-remove]");
      if (removeShortlist) {
        removeFromShortlist(removeShortlist.getAttribute("data-remove"));
        return;
      }
    });

    window.addEventListener("resize", debounce(resizeCharts, 180));
  }

  function setView(view) {
    state.view = view;
    const isCards = view === "cards";
    $("#viewCards").classList.toggle("active", isCards);
    $("#viewTable").classList.toggle("active", !isCards);
    $("#viewCards").setAttribute("aria-pressed", String(isCards));
    $("#viewTable").setAttribute("aria-pressed", String(!isCards));
    renderCatalog();
  }

  /** Cheap integrity check on the seed catalog — silent unless something is wrong. */
  function validateCatalog() {
    const seen = new Set();
    KITS.forEach((kit) => seen.add(kit.id));
    if (seen.size !== KITS.length) {
      console.error(
        "kits-data.js: duplicate kit ids detected (" +
          KITS.length +
          " entries, " +
          seen.size +
          " unique)",
      );
    }
    if (typeof echarts === "undefined") {
      console.warn("ECharts did not load; insight charts are unavailable.");
    }
    console.info(
      "StarterKit Radar: catalog loaded with " +
        KITS.length +
        " kits across " +
        CATEGORIES.length +
        " categories.",
    );
  }

  function boot() {
    validateCatalog();
    initTheme();
    populateSelects();
    wireControls();
    renderStats();
    renderCatalog();
    renderCompare();
    initNavHighlight();

    if (typeof echarts !== "undefined") {
      renderCharts();
    } else {
      toast(
        "Chart library failed to load — tables and filters still work.",
        "warn",
      );
    }

    loadShortlist({});
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
