/* Root · Comparador de acciones
 * Lee el universo desde data.json (snapshot) y los históricos de Yahoo Finance
 * via CORS proxy. Todo client-side, sin build step.
 */

const DATA_URL =
  "https://cdn.jsdelivr.net/gh/dkardjian/root-dashboard-data@main/data.json";

const CORS_PROXIES = [
  (u) => "https://corsproxy.io/?" + encodeURIComponent(u),
  (u) => "https://api.allorigins.win/raw?url=" + encodeURIComponent(u),
  (u) => "https://api.codetabs.com/v1/proxy/?quest=" + encodeURIComponent(u),
];

const MAX_TICKERS = 8;
const LINE_COLORS = [
  "#2ee6b8", "#6bb1ff", "#f4a261", "#e76f51",
  "#b084f5", "#ffd166", "#c0c6d1", "#ef476f",
];

const state = {
  universe: [],
  selected: [],          // [{ symbol, label, market, color }]
  priceCache: {},        // symbol -> { timestamps:[], prices:[] }
  range: "YTD",
  customFrom: null,
  customTo: null,
  activeSuggestion: -1,
  suggestionItems: [],
};

let chart = null;

/* ---------- Boot ---------- */

document.addEventListener("DOMContentLoaded", async () => {
  bindControls();
  try {
    const data = await (await fetch(DATA_URL)).json();
    buildUniverse(data);
    setUpdated(data._updated);
  } catch (e) {
    setUpdated("no se pudo cargar el universo");
    console.error(e);
  }
  renderChips();
  renderTable();
  setDefaultCustomDates();
});

function setUpdated(s) {
  const el = document.getElementById("data-updated");
  el.textContent = s ? `Snapshot · ${s}` : "";
}

function setDefaultCustomDates() {
  const to = new Date();
  const from = new Date(to);
  from.setMonth(from.getMonth() - 12);
  document.getElementById("date-from").value = isoDate(from);
  document.getElementById("date-to").value = isoDate(to);
}

/* ---------- Universe ---------- */

function buildUniverse(data) {
  const seen = new Set();
  const uni = [];
  for (const r of data.NYSE_DATA || []) {
    const sym = (r.yahoo_symbol || r.ticker || "").trim().toUpperCase();
    if (!sym || seen.has(sym)) continue;
    seen.add(sym);
    uni.push({
      symbol: sym,
      label: r.descripcion || sym,
      market: r.mercado || "NYSE",
    });
  }
  for (const r of data.ACCIONES_CEDEARS || []) {
    if (r.mercado !== "MERVAL") continue;
    const sym = (r.ticker || "").trim().toUpperCase() + ".BA";
    if (seen.has(sym)) continue;
    seen.add(sym);
    uni.push({
      symbol: sym,
      label: r.desc || sym,
      market: "MERVAL",
    });
  }
  // Atajos populares
  const popular = [
    { symbol: "SPY",  label: "SPDR S&P 500 ETF",            market: "NYSE" },
    { symbol: "QQQ",  label: "Invesco QQQ (Nasdaq 100)",    market: "NASDAQ" },
    { symbol: "IWM",  label: "iShares Russell 2000 ETF",    market: "NYSE" },
    { symbol: "EEM",  label: "iShares MSCI Emerging Mkts",  market: "NYSE" },
    { symbol: "EWZ",  label: "iShares MSCI Brazil ETF",     market: "NYSE" },
    { symbol: "ARGT", label: "Global X MSCI Argentina ETF", market: "NYSE" },
  ];
  for (const p of popular) {
    if (!seen.has(p.symbol)) { seen.add(p.symbol); uni.push(p); }
  }
  uni.sort((a, b) => a.symbol.localeCompare(b.symbol));
  state.universe = uni;
}

/* ---------- Controls binding ---------- */

function bindControls() {
  const input = document.getElementById("ticker-input");
  input.addEventListener("input", onSearch);
  input.addEventListener("focus", onSearch);
  input.addEventListener("keydown", onSearchKey);
  input.addEventListener("blur", () => {
    setTimeout(() => hideSuggestions(), 120);
  });

  document.querySelectorAll(".range-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document
        .querySelectorAll(".range-tab")
        .forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.range = btn.dataset.range;
      document.getElementById("custom-range").hidden = state.range !== "CUSTOM";
      update();
    });
  });

  document.getElementById("apply-custom").addEventListener("click", () => {
    state.customFrom = document.getElementById("date-from").value;
    state.customTo = document.getElementById("date-to").value;
    update();
  });

  document.getElementById("btn-fullscreen").addEventListener("click", toggleFullscreen);
  document.addEventListener("fullscreenchange", onFullscreenChange);
  document.getElementById("btn-export").addEventListener("click", exportPng);
}

/* ---------- Fullscreen ---------- */

function toggleFullscreen() {
  const panel = document.querySelector(".panel-chart");
  if (!document.fullscreenElement) {
    (panel.requestFullscreen?.() || panel.webkitRequestFullscreen?.() || Promise.reject())
      .catch(() => {
        // Fallback: CSS-based fullscreen for browsers without the API
        panel.classList.add("is-fullscreen");
        document.body.style.overflow = "hidden";
        setFullscreenIcon(true);
        if (chart) chart.resize();
      });
  } else {
    document.exitFullscreen?.();
  }
}
function onFullscreenChange() {
  const isFs = Boolean(document.fullscreenElement);
  setFullscreenIcon(isFs);
  if (!isFs) {
    document.querySelector(".panel-chart").classList.remove("is-fullscreen");
    document.body.style.overflow = "";
  }
  if (chart) setTimeout(() => chart.resize(), 50);
}
function setFullscreenIcon(isFs) {
  document.getElementById("icon-expand").hidden = isFs;
  document.getElementById("icon-collapse").hidden = !isFs;
  document.getElementById("btn-fullscreen").title = isFs ? "Salir de pantalla completa" : "Pantalla completa";
}

/* ---------- Export PNG ---------- */

async function exportPng() {
  const area = document.getElementById("snapshot-area");
  if (!state.selected.length) { flashHint("Agregá tickers primero"); return; }
  if (typeof html2canvas !== "function") { flashHint("html2canvas no cargó"); return; }

  const wm = document.createElement("div");
  wm.className = "export-watermark";
  wm.textContent = "dkardjian.github.io/root-dashboard-data · " + new Date().toLocaleString("es-AR");
  area.querySelector(".panel-chart").appendChild(wm);
  area.classList.add("is-exporting");

  // Swap the Chart.js canvas for an <img> so html2canvas doesn't re-scale
  // it with the device pixel ratio (which caused the overlap bug).
  const canvasEl = document.getElementById("chart");
  const rect = canvasEl.getBoundingClientRect();
  const dataUrl = chart ? chart.toBase64Image("image/png", 1) : canvasEl.toDataURL("image/png");
  const img = new Image();
  img.src = dataUrl;
  img.style.width = rect.width + "px";
  img.style.height = rect.height + "px";
  img.style.display = "block";
  canvasEl.style.display = "none";
  canvasEl.parentNode.insertBefore(img, canvasEl);

  try {
    await new Promise((resolve, reject) => {
      if (img.complete && img.naturalWidth) return resolve();
      img.onload = resolve;
      img.onerror = reject;
    });
    const out = await html2canvas(area, {
      backgroundColor: "#0a0d12",
      scale: 2,
      useCORS: true,
      logging: false,
    });
    const link = document.createElement("a");
    link.download = `root-comparador-${state.range}-${isoDate(new Date())}.png`;
    link.href = out.toDataURL("image/png");
    link.click();
  } catch (e) {
    console.error(e);
    flashHint("error al exportar");
  } finally {
    img.remove();
    canvasEl.style.display = "";
    area.classList.remove("is-exporting");
    wm.remove();
  }
}

/* ---------- Autocomplete ---------- */

function onSearch() {
  const q = document.getElementById("ticker-input").value.trim().toUpperCase();
  const box = document.getElementById("suggestions");
  if (!q) { hideSuggestions(); return; }
  const matches = [];
  for (const u of state.universe) {
    if (u.symbol.startsWith(q)) matches.push({ u, rank: 0 });
    else if (u.symbol.includes(q)) matches.push({ u, rank: 1 });
    else if ((u.label || "").toUpperCase().includes(q)) matches.push({ u, rank: 2 });
    if (matches.length >= 60) break;
  }
  matches.sort((a, b) => a.rank - b.rank || a.u.symbol.localeCompare(b.u.symbol));
  const top = matches.slice(0, 20).map((m) => m.u);
  if (top.length === 0) {
    box.innerHTML = `<div class="suggestion-item"><span class="suggestion-ticker">${escapeHtml(q)}</span>
      <span class="suggestion-desc muted">Usar como ticker libre (Yahoo)</span></div>`;
    state.suggestionItems = [{ symbol: q, label: q, market: "custom" }];
  } else {
    box.innerHTML = top
      .map(
        (u, i) => `
        <div class="suggestion-item" data-i="${i}">
          <span class="suggestion-ticker">${escapeHtml(u.symbol)}</span>
          <span class="suggestion-desc">${escapeHtml(u.label || "")}</span>
          <span class="suggestion-badge">${escapeHtml(u.market || "")}</span>
        </div>`,
      )
      .join("");
    state.suggestionItems = top;
  }
  state.activeSuggestion = 0;
  box.hidden = false;
  box.querySelectorAll(".suggestion-item").forEach((el, i) => {
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      pickSuggestion(i);
    });
    el.addEventListener("mouseover", () => highlightSuggestion(i));
  });
  highlightSuggestion(0);
}

function onSearchKey(e) {
  const box = document.getElementById("suggestions");
  if (box.hidden) return;
  if (e.key === "ArrowDown") {
    e.preventDefault();
    highlightSuggestion(Math.min(state.activeSuggestion + 1, state.suggestionItems.length - 1));
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    highlightSuggestion(Math.max(state.activeSuggestion - 1, 0));
  } else if (e.key === "Enter") {
    e.preventDefault();
    if (state.activeSuggestion >= 0) pickSuggestion(state.activeSuggestion);
  } else if (e.key === "Escape") {
    hideSuggestions();
  }
}

function highlightSuggestion(i) {
  state.activeSuggestion = i;
  document.querySelectorAll(".suggestion-item").forEach((el, idx) => {
    el.classList.toggle("active", idx === i);
  });
}

function hideSuggestions() {
  document.getElementById("suggestions").hidden = true;
  state.activeSuggestion = -1;
}

function pickSuggestion(i) {
  const item = state.suggestionItems[i];
  if (!item) return;
  addTicker(item);
  document.getElementById("ticker-input").value = "";
  hideSuggestions();
}

/* ---------- Selection ---------- */

function addTicker(item) {
  const symbol = item.symbol.toUpperCase();
  if (state.selected.find((s) => s.symbol === symbol)) return;
  if (state.selected.length >= MAX_TICKERS) {
    flashHint(`Máximo ${MAX_TICKERS} acciones`);
    return;
  }
  const color = nextColor();
  state.selected.push({
    symbol,
    label: item.label || symbol,
    market: item.market || "",
    color,
  });
  renderChips();
  renderTable();
  update();
}

function removeTicker(symbol) {
  state.selected = state.selected.filter((s) => s.symbol !== symbol);
  renderChips();
  renderTable();
  update();
}

function nextColor() {
  const used = new Set(state.selected.map((s) => s.color));
  for (const c of LINE_COLORS) if (!used.has(c)) return c;
  return LINE_COLORS[state.selected.length % LINE_COLORS.length];
}

function flashHint(msg) {
  const hint = document.querySelector(".hint");
  const prev = hint.textContent;
  hint.textContent = msg;
  hint.style.color = "var(--neg)";
  setTimeout(() => {
    hint.textContent = prev;
    hint.style.color = "";
  }, 1800);
}

/* ---------- Render ---------- */

function renderChips() {
  const box = document.getElementById("chips");
  document.getElementById("chip-count").textContent = state.selected.length;
  box.innerHTML = state.selected
    .map(
      (s) => `
      <span class="chip" data-symbol="${escapeAttr(s.symbol)}">
        <span class="chip-dot" style="background:${s.color}"></span>
        <span class="chip-ticker">${escapeHtml(s.symbol)}</span>
        <button class="chip-remove" aria-label="Quitar ${escapeAttr(s.symbol)}">×</button>
      </span>`,
    )
    .join("");
  box.querySelectorAll(".chip").forEach((el) => {
    el.querySelector(".chip-remove").addEventListener("click", () =>
      removeTicker(el.dataset.symbol),
    );
  });
}

function renderTable(rows) {
  const tbody = document.querySelector("#returns-table tbody");
  if (!state.selected.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="5">Agregá tickers para ver los retornos</td></tr>`;
    return;
  }
  tbody.innerHTML = state.selected
    .map((s) => {
      const r = rows && rows[s.symbol];
      if (!r) {
        return `<tr class="row-loading" data-s="${escapeAttr(s.symbol)}">
          <td><span class="ticker-cell"><span class="chip-dot" style="background:${s.color}"></span>${escapeHtml(s.symbol)}</span></td>
          <td class="muted">${escapeHtml(s.label)}</td>
          <td class="num muted">—</td><td class="num muted">—</td><td class="num muted">cargando…</td>
        </tr>`;
      }
      if (r.error) {
        return `<tr class="row-error" data-s="${escapeAttr(s.symbol)}">
          <td><span class="ticker-cell"><span class="chip-dot" style="background:${s.color}"></span>${escapeHtml(s.symbol)}</span></td>
          <td class="muted">${escapeHtml(s.label)}</td>
          <td class="num">—</td><td class="num">—</td><td class="num">${escapeHtml(r.error)}</td>
        </tr>`;
      }
      const pct = r.ret * 100;
      const cls = pct >= 0 ? "pos" : "neg";
      const sign = pct >= 0 ? "+" : "";
      return `<tr data-s="${escapeAttr(s.symbol)}">
        <td><span class="ticker-cell"><span class="chip-dot" style="background:${s.color}"></span>${escapeHtml(s.symbol)}</span></td>
        <td class="muted">${escapeHtml(s.label)}</td>
        <td class="num">${fmtPrice(r.start)}</td>
        <td class="num">${fmtPrice(r.end)}</td>
        <td class="num ${cls}">${sign}${pct.toFixed(2)} %</td>
      </tr>`;
    })
    .join("");
}

/* ---------- Data / Chart ---------- */

async function update() {
  if (!state.selected.length) {
    toggleEmpty(true);
    destroyChart();
    renderTable();
    setChartStatus("");
    return;
  }
  toggleEmpty(false);

  setChartStatus("cargando históricos…");
  const { from, to } = getRange();
  if (!from || !to || from >= to) {
    setChartStatus("rango inválido", true);
    updateRangeLabels(from, to);
    return;
  }
  updateRangeLabels(from, to);

  const results = {};
  await Promise.all(
    state.selected.map(async (s) => {
      try {
        const series = await getPrices(s.symbol);
        const sliced = sliceSeries(series, from, to);
        if (!sliced.prices.length) {
          results[s.symbol] = { error: "sin datos" };
          return;
        }
        const start = sliced.prices[0];
        const end = sliced.prices[sliced.prices.length - 1];
        results[s.symbol] = {
          timestamps: sliced.timestamps,
          prices: sliced.prices,
          start,
          end,
          ret: end / start - 1,
        };
      } catch (err) {
        console.error(s.symbol, err);
        results[s.symbol] = { error: "error al consultar" };
      }
    }),
  );

  renderTable(results);
  drawChart(results);
  const anyError = Object.values(results).some((r) => r.error);
  setChartStatus(anyError ? "algunos tickers fallaron" : "", anyError);
}

function getRange() {
  const now = new Date();
  let from, to = now;
  switch (state.range) {
    case "MTD":
      from = new Date(now.getFullYear(), now.getMonth(), 1);
      break;
    case "YTD":
      from = new Date(now.getFullYear(), 0, 1);
      break;
    case "3M":
      from = new Date(now);
      from.setMonth(from.getMonth() - 3);
      break;
    case "6M":
      from = new Date(now);
      from.setMonth(from.getMonth() - 6);
      break;
    case "1Y":
      from = new Date(now);
      from.setFullYear(from.getFullYear() - 1);
      break;
    case "CUSTOM": {
      const fromVal = state.customFrom || document.getElementById("date-from").value;
      const toVal = state.customTo || document.getElementById("date-to").value;
      if (!fromVal || !toVal) return {};
      from = new Date(fromVal);
      to = new Date(toVal);
      break;
    }
  }
  return { from, to };
}

async function getPrices(symbol) {
  if (state.priceCache[symbol]) return state.priceCache[symbol];
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?range=5y&interval=1d&includeAdjustedClose=true`;

  let lastErr;
  for (const wrap of CORS_PROXIES) {
    try {
      const resp = await fetch(wrap(url));
      if (!resp.ok) { lastErr = new Error("HTTP " + resp.status); continue; }
      const json = await resp.json();
      const res = json?.chart?.result?.[0];
      if (!res) throw new Error("sin datos");
      const ts = res.timestamp || [];
      const adj = res.indicators?.adjclose?.[0]?.adjclose
        || res.indicators?.quote?.[0]?.close
        || [];
      const timestamps = [];
      const prices = [];
      for (let i = 0; i < ts.length; i++) {
        const p = adj[i];
        if (p == null) continue;
        timestamps.push(ts[i] * 1000);
        prices.push(p);
      }
      const series = { timestamps, prices };
      state.priceCache[symbol] = series;
      return series;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("fetch failed");
}

function sliceSeries(series, from, to) {
  const fromMs = from.getTime();
  const toMs = to.getTime();
  const timestamps = [];
  const prices = [];
  for (let i = 0; i < series.timestamps.length; i++) {
    const t = series.timestamps[i];
    if (t < fromMs || t > toMs) continue;
    timestamps.push(t);
    prices.push(series.prices[i]);
  }
  return { timestamps, prices };
}

function drawChart(results) {
  const ctx = document.getElementById("chart");
  const datasets = state.selected
    .map((s) => {
      const r = results[s.symbol];
      if (!r || r.error) return null;
      const base = r.prices[0];
      return {
        label: s.symbol,
        data: r.timestamps.map((t, i) => ({
          x: t,
          y: (r.prices[i] / base - 1) * 100,
        })),
        borderColor: s.color,
        backgroundColor: s.color + "22",
        borderWidth: 1.8,
        pointRadius: 0,
        pointHoverRadius: 3,
        tension: 0.15,
        spanGaps: true,
      };
    })
    .filter(Boolean);

  if (chart) chart.destroy();
  chart = new Chart(ctx, {
    type: "line",
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: {
          position: "top",
          align: "end",
          labels: {
            color: "#9aa4b2",
            usePointStyle: true,
            pointStyle: "rectRounded",
            boxWidth: 10,
            padding: 14,
            font: { family: "Inter", size: 12 },
          },
        },
        tooltip: {
          backgroundColor: "rgba(10,13,18,0.95)",
          borderColor: "#2a323f",
          borderWidth: 1,
          titleColor: "#e6e9ef",
          bodyColor: "#e6e9ef",
          titleFont: { family: "Inter", size: 12, weight: "600" },
          bodyFont: { family: "JetBrains Mono", size: 12 },
          padding: 10,
          callbacks: {
            title: (items) => {
              const d = new Date(items[0].parsed.x);
              return d.toLocaleDateString("es-AR", {
                day: "2-digit", month: "short", year: "numeric",
              });
            },
            label: (item) => {
              const v = item.parsed.y;
              const sign = v >= 0 ? "+" : "";
              return ` ${item.dataset.label}   ${sign}${v.toFixed(2)} %`;
            },
          },
        },
      },
      scales: {
        x: {
          type: "time",
          time: {
            tooltipFormat: "PP",
            displayFormats: { day: "dd MMM", month: "MMM yy", year: "yyyy" },
          },
          grid: { color: "rgba(255,255,255,0.04)", drawBorder: false },
          ticks: { color: "#6b7380", font: { family: "Inter", size: 11 }, maxRotation: 0 },
        },
        y: {
          grid: { color: "rgba(255,255,255,0.05)", drawBorder: false },
          ticks: {
            color: "#6b7380",
            font: { family: "JetBrains Mono", size: 11 },
            callback: (v) => (v >= 0 ? "+" : "") + v.toFixed(1) + " %",
          },
        },
      },
    },
  });
}

function destroyChart() {
  if (chart) { chart.destroy(); chart = null; }
}

function toggleEmpty(show) {
  document.getElementById("chart-empty").style.display = show ? "flex" : "none";
}

function setChartStatus(msg, isError = false) {
  const el = document.getElementById("chart-status");
  el.textContent = msg || "";
  el.classList.toggle("error", Boolean(isError));
}

const RANGE_LABELS = {
  MTD: "MTD", YTD: "YTD", "3M": "3M", "6M": "6M", "1Y": "1 año", CUSTOM: "Personalizado",
};
function updateRangeLabels(from, to) {
  document.getElementById("range-label").textContent = RANGE_LABELS[state.range] || state.range;
  const el = document.getElementById("range-dates");
  if (from && to) {
    el.textContent = `${fmtShortDate(from)} → ${fmtShortDate(to)}`;
  } else {
    el.textContent = "—";
  }
}
function fmtShortDate(d) {
  return d.toLocaleDateString("es-AR", { day: "2-digit", month: "short", year: "numeric" });
}

/* ---------- Utils ---------- */

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}
function fmtPrice(v) {
  if (v == null) return "—";
  if (v >= 1000) return v.toLocaleString("es-AR", { maximumFractionDigits: 2 });
  return v.toFixed(2);
}
function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function escapeAttr(s) { return escapeHtml(s); }
