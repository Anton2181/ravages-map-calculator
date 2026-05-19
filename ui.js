"use strict";

// Sidebar UI: layer toggles, weight inputs, endpoint badges, path stats.
// All functions read globals from app.js (LAYERS, CLASSES, weights, fromId,
// toId, pathIds, etc.) and call back into rendering/pathfinding.

function pad4(n) { return String(n).padStart(4, "0"); }
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function buildLayerControls() {
  layersEl.innerHTML = "";
  for (const l of LAYERS) {
    const row = document.createElement("div");
    row.className = "layer-row";
    row.innerHTML = `<input type="checkbox" id="layer-${l.id}" ${l.on ? "checked" : ""} />`
      + `<label for="layer-${l.id}">${escapeHtml(l.label)}</label>`
      + `<div class="opacity"><input type="range" min="0" max="100" value="${(l.opacity*100)|0}" /></div>`;
    row.querySelector("input[type=checkbox]").addEventListener("change", (e) => {
      l.on = e.target.checked; renderLayers();
    });
    row.querySelector("input[type=range]").addEventListener("input", (e) => {
      l.opacity = (+e.target.value) / 100; renderLayers();
    });
    layersEl.appendChild(row);
  }
}

function buildWeightControls() {
  weightsEl.innerHTML = "";
  for (const cls of CLASSES) {
    const row = document.createElement("div");
    row.className = "weight-row";
    row.innerHTML = `<span class="swatch ${cls}"></span><span class="name">${cls}</span>`
      + `<input type="number" min="0" step="0.5" value="${weights[cls]}" />`;
    row.querySelector("input").addEventListener("change", (e) => {
      const v = parseFloat(e.target.value);
      weights[cls] = (isFinite(v) && v > 0) ? v : DEFAULT_WEIGHTS[cls];
      e.target.value = weights[cls];
      if (fromId != null && toId != null) {
        recomputePath(); renderSelection(); updatePathInfo(); updateStatus();
      }
    });
    weightsEl.appendChild(row);
  }
}

function updateEndpoints() {
  const fromS = fromId ? SUBHEX_INDEX.get(fromId) : null;
  const toS   = toId   ? SUBHEX_INDEX.get(toId)   : null;
  const fromHtml = fromS
    ? `<span class="swatch ${fromS.class}"></span>${escapeHtml(fromS.name)}`
    : "—";
  const toHtml = toS
    ? `<span class="swatch ${toS.class}"></span>${escapeHtml(toS.name)}`
    : "—";
  endpointsEl.innerHTML =
      `<div class="endpoint from ${fromS ? "" : "empty"}">`
    +   `<span class="label">From</span><span class="name">${fromHtml}</span>`
    + `</div>`
    + `<div class="endpoint to ${toS ? "" : "empty"}">`
    +   `<span class="label">To</span><span class="name">${toHtml}</span>`
    + `</div>`;
}

function updatePathInfo() {
  if (!pathHexIds || pathHexIds.length === 0) {
    pathInfoEl.innerHTML = (fromId && toId)
      ? `<div class="path-stats"><div class="row"><span>Path</span><span>unreachable</span></div></div>`
      : "";
    return;
  }
  const st = pathStats();
  let html = `<div class="path-stats">`
    + `<div class="row"><span>Hexes</span><span>${st.hexes}</span></div>`
    + `<div class="row"><span>Subhexes in mask</span><span>${st.subhexes}</span></div>`
    + `<div class="row"><span>Cost</span><span>${st.cost.toFixed(1)}</span></div>`;
  const terrains = Object.keys(st.byTerrain).sort();
  for (const t of terrains) {
    html += `<div class="row"><span>${escapeHtml(t)}</span><span>${st.byTerrain[t]}</span></div>`;
  }
  html += `</div>`;
  pathInfoEl.innerHTML = html;
}

function updateStatus() {
  let s = `zoom ${(view.scale * 100).toFixed(0)}%`;
  if (fromId) s += `  ·  From: ${SUBHEX_INDEX.get(fromId).name}`;
  if (toId)   s += `  ·  To: ${SUBHEX_INDEX.get(toId).name}`;
  if (pathHexIds && pathHexIds.length > 0) {
    const st = pathStats();
    s += `  ·  ${st.hexes} hexes, cost ${st.cost.toFixed(1)}`;
  }
  statusEl.textContent = s;
}

function clearSelection() {
  fromId = toId = null; pathIds = null; pathSet = null;
  pathHexIds = null; pathSubhexIds = null;
  renderSelection(); updateEndpoints(); updatePathInfo(); updateStatus();
}

document.getElementById("reset-view").addEventListener("click", () => resetView());
document.getElementById("reset-layers").addEventListener("click", () => {
  for (const l of LAYERS) { l.on = (l.id === "sea" || l.id === "terrain"); l.opacity = 1.0; }
  buildLayerControls(); renderLayers();
});
document.getElementById("swap").addEventListener("click", () => {
  const t = fromId; fromId = toId; toId = t;
  if (fromId != null && toId != null) recomputePath();
  else { pathIds = null; pathSet = null; pathHexIds = null; pathSubhexIds = null; }
  renderSelection(); updateEndpoints(); updatePathInfo(); updateStatus();
});
document.getElementById("clear-sel").addEventListener("click", clearSelection);
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") clearSelection();
});

// ----- Colors panel -----
const COLOR_CONTROLS = [
  { label: "Start",     get: () => START_COLOR,     set: (v) => { START_COLOR = v; },     getA: () => START_ALPHA, setA: (v) => { START_ALPHA = v; } },
  { label: "End",       get: () => END_COLOR,       set: (v) => { END_COLOR = v; },       getA: () => END_ALPHA,   setA: (v) => { END_ALPHA = v; } },
  { label: "Path fill", get: () => PATH_COLOR,      set: (v) => { PATH_COLOR = v; },      getA: () => PATH_ALPHA,  setA: (v) => { PATH_ALPHA = v; } },
  { label: "Path line", get: () => PATH_LINE_COLOR, set: (v) => { PATH_LINE_COLOR = v; }, getA: () => LINE_ALPHA,  setA: (v) => { LINE_ALPHA = v; } },
  { label: "Hex outline", get: () => HEX_OUTLINE_COLOR, set: (v) => { HEX_OUTLINE_COLOR = v; }, getA: () => HEX_OUTLINE_ALPHA, setA: (v) => { HEX_OUTLINE_ALPHA = v; } },
];

function rgbToHex(rgb) {
  return "#" + rgb.map(v => Math.max(0, Math.min(255, v|0)).toString(16).padStart(2, "0")).join("");
}
function hexToRgb(hex) {
  return [parseInt(hex.slice(1,3),16), parseInt(hex.slice(3,5),16), parseInt(hex.slice(5,7),16)];
}

function buildColorControls() {
  colorsEl.innerHTML = "";
  for (const c of COLOR_CONTROLS) {
    const hex = rgbToHex(c.get());
    const aPct = Math.round((c.getA() / 255) * 100);
    const row = document.createElement("div");
    row.className = "color-row";
    row.innerHTML =
        `<span class="name">${c.label}</span>`
      + `<input type="color" value="${hex}" />`
      + `<input type="range" class="alpha" min="0" max="100" value="${aPct}" title="opacity" />`
      + `<span class="alpha-val">${aPct}%</span>`;
    const colorInput = row.querySelector("input[type=color]");
    const alphaInput = row.querySelector("input[type=range]");
    const alphaVal   = row.querySelector(".alpha-val");
    colorInput.addEventListener("input", (e) => {
      c.set(hexToRgb(e.target.value));
      renderSelection();
    });
    alphaInput.addEventListener("input", (e) => {
      const pct = +e.target.value;
      c.setA(Math.round((pct / 100) * 255));
      alphaVal.textContent = pct + "%";
      renderSelection();
    });
    colorsEl.appendChild(row);
  }
}

// ----- Path line style panel -----
function buildLineControls() {
  lineEl.innerHTML = "";
  const lwRow = document.createElement("div");
  lwRow.className = "weight-row";
  lwRow.innerHTML = `<span class="name">Line width</span>`
    + `<input type="range" min="1" max="10" step="0.5" value="${LINE_WIDTH}" />`
    + `<span class="alpha-val">${LINE_WIDTH}px</span>`;
  const lwSlider = lwRow.querySelector("input");
  const lwLabel  = lwRow.querySelector(".alpha-val");
  lwSlider.addEventListener("input", (e) => {
    LINE_WIDTH = +e.target.value;
    lwLabel.textContent = LINE_WIDTH + "px";
    renderSelection();
  });
  lineEl.appendChild(lwRow);

  const psRow = document.createElement("div");
  psRow.className = "weight-row";
  psRow.innerHTML = `<span class="name">Point size</span>`
    + `<input type="range" min="0" max="10" step="0.5" value="${POINT_SIZE}" />`
    + `<span class="alpha-val">${POINT_SIZE}px</span>`;
  const psSlider = psRow.querySelector("input");
  const psLabel  = psRow.querySelector(".alpha-val");
  psSlider.addEventListener("input", (e) => {
    POINT_SIZE = +e.target.value;
    psLabel.textContent = POINT_SIZE + "px";
    renderSelection();
  });
  lineEl.appendChild(psRow);

  const aaRow = document.createElement("div");
  aaRow.className = "layer-row";
  aaRow.innerHTML = `<input type="checkbox" id="line-aa" ${LINE_AA ? "checked" : ""} />`
    + `<label for="line-aa">Anti-aliasing</label>`;
  aaRow.querySelector("input").addEventListener("change", (e) => {
    LINE_AA = e.target.checked;
    renderSelection();
  });
  lineEl.appendChild(aaRow);

  const hoRow = document.createElement("div");
  hoRow.className = "layer-row";
  hoRow.innerHTML = `<input type="checkbox" id="show-hex-outline" ${SHOW_HEX_OUTLINE ? "checked" : ""} />`
    + `<label for="show-hex-outline">Hex outlines</label>`;
  hoRow.querySelector("input").addEventListener("change", (e) => {
    SHOW_HEX_OUTLINE = e.target.checked;
    renderSelection();
  });
  lineEl.appendChild(hoRow);

  const owRow = document.createElement("div");
  owRow.className = "weight-row";
  owRow.innerHTML = `<span class="name">Outline width</span>`
    + `<input type="range" min="1" max="10" step="0.5" value="${HEX_OUTLINE_WIDTH}" />`
    + `<span class="alpha-val">${HEX_OUTLINE_WIDTH}px</span>`;
  const owSlider = owRow.querySelector("input");
  const owLabel  = owRow.querySelector(".alpha-val");
  owSlider.addEventListener("input", (e) => {
    HEX_OUTLINE_WIDTH = +e.target.value;
    owLabel.textContent = HEX_OUTLINE_WIDTH + "px";
    renderSelection();
  });
  lineEl.appendChild(owRow);

  const oaaRow = document.createElement("div");
  oaaRow.className = "layer-row";
  oaaRow.innerHTML = `<input type="checkbox" id="outline-aa" ${HEX_OUTLINE_AA ? "checked" : ""} />`
    + `<label for="outline-aa">Outline anti-aliasing</label>`;
  oaaRow.querySelector("input").addEventListener("change", (e) => {
    HEX_OUTLINE_AA = e.target.checked;
    renderSelection();
  });
  lineEl.appendChild(oaaRow);
}

// Settings panel show/hide toggle.
{
  const tbtn = document.getElementById("settings-toggle");
  const tpanels = document.getElementById("settings-panels");
  tbtn.addEventListener("click", () => {
    const isHidden = tpanels.classList.toggle("hidden");
    tbtn.textContent = isHidden ? "Show settings" : "Hide settings";
  });
}
