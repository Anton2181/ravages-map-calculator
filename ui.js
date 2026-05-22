"use strict";

// Sidebar UI: layer toggles, weight inputs, multi-route list (waypoint badges,
// per-route stats, totals). Reads globals from app.js (LAYERS, CLASSES,
// weights, ROUTES, ACTIVE_ROUTE_ID, ...) and calls back into rendering /
// route lifecycle (newRoute, addWaypointToActive, removeWaypoint, ...).

function pad4(n) { return String(n).padStart(4, "0"); }
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Make a small read-only value span editable on double-click.
// onParse(text) -> parsed value or null on invalid.
// onApply(value) -> store + propagate; should also update the matching slider.
// reformat() -> string to display after committing (read from current state).
function makeEditable(span, onParse, onApply, reformat) {
  span.style.cursor = "text";
  span.title = "Double-click to edit";
  span.addEventListener("dblclick", () => {
    const input = document.createElement("input");
    input.type = "text";
    input.value = span.textContent;
    input.size = 4;
    input.className = "editable-val";
    // Inline style as a belt-and-braces guard against flex parents (.weight-row)
    // that have no constraints on their other children — without this the input
    // can balloon to its UA default ~150px width and push the row off the panel.
    input.style.flex = "0 0 56px";
    input.style.width = "56px";
    input.style.maxWidth = "56px";
    input.style.minWidth = "0";
    input.style.boxSizing = "border-box";
    span.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    function commit(save) {
      if (done) return; done = true;
      if (save) {
        const v = onParse(input.value);
        if (v != null) onApply(v);
      }
      span.textContent = reformat();
      input.replaceWith(span);
    }
    input.addEventListener("blur", () => commit(true));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); commit(true); }
      else if (e.key === "Escape") { e.preventDefault(); commit(false); }
    });
  });
}


function buildLayerControls() {
  layersEl.innerHTML = "";
  for (const l of LAYERS) {
    if (l.hidden) continue;
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

const WEIGHT_LABELS = { "Embark": "Embark / disembark" };
function buildWeightControls() {
  weightsEl.innerHTML = "";
  // Header row above the two input columns.
  const head = document.createElement("div");
  head.className = "weight-row";
  const headStyle = "width:70px;color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:0.08em;text-align:center;";
  head.innerHTML = `<span class="swatch" style="visibility:hidden"></span>`
    + `<span class="name"></span>`
    + `<span style="${headStyle}">Default</span>`
    + `<span style="${headStyle}">Road</span>`;
  weightsEl.appendChild(head);
  for (const cls of CLASSES) {
    const row = document.createElement("div");
    row.className = "weight-row";
    const label = WEIGHT_LABELS[cls] || cls;
    row.innerHTML = `<span class="swatch ${cls}"></span><span class="name">${escapeHtml(label)}</span>`
      + `<input type="number" min="0" step="0.5" value="${weights[cls]}" data-col="default" />`
      + `<input type="number" min="0" step="0.5" value="${roadWeights[cls]}" data-col="road" />`;
    const inputs = row.querySelectorAll("input");
    const reroute = () => {
      if (ROUTES.length > 0) {
        recomputePath(); renderSelection(); updateEndpoints(); updatePathInfo(); updateStatus();
      }
      if (ISOCHRONE_MODE && isochroneSourceId != null) {
        computeIsochrone(); renderLayers(); renderSelection(); updateStatus();
      }
    };
    inputs[0].addEventListener("change", (e) => {
      const v = parseFloat(e.target.value);
      weights[cls] = (isFinite(v) && v > 0) ? v : DEFAULT_WEIGHTS[cls];
      e.target.value = weights[cls];
      reroute();
    });
    inputs[1].addEventListener("change", (e) => {
      const v = parseFloat(e.target.value);
      roadWeights[cls] = (isFinite(v) && v > 0) ? v : DEFAULT_ROAD_WEIGHTS[cls];
      e.target.value = roadWeights[cls];
      reroute();
    });
    weightsEl.appendChild(row);
  }
}

// Render the routes-list (per-route header + waypoint chips + per-route stats).
// Click on the route header to make it active (next map click extends it).
// Each waypoint chip has an "x" to delete just that waypoint; each route
// header has an "x" to delete the whole route.
const routesListEl = document.getElementById("routes-list");
function rgbCss(c) { return `rgb(${c[0]},${c[1]},${c[2]})`; }
function fmtMiKm(miles, km) {
  return `${Math.round(miles).toLocaleString()} mi / ${Math.round(km).toLocaleString()} km`;
}
function updateEndpoints() {
  if (!routesListEl) return;
  if (ROUTES.length === 0) {
    routesListEl.innerHTML = `<div class="empty-routes">No routes yet. Click the map to drop a waypoint.</div>`;
    return;
  }
  const frag = document.createDocumentFragment();
  ROUTES.forEach((route, rIdx) => {
    const card = document.createElement("div");
    card.className = "route-card" + (route.id === ACTIVE_ROUTE_ID ? " active" : "");
    card.style.borderLeftColor = rgbCss(route.color);

    // Header: swatch, label, "make active" click target, delete button.
    const header = document.createElement("div");
    header.className = "route-header";
    header.innerHTML =
        `<span class="route-color" style="background:${rgbCss(route.color)}"></span>`
      + `<span class="route-name">Route ${rIdx + 1}</span>`
      + `<span class="route-meta">${route.waypoints.length} pt${route.waypoints.length===1?"":"s"}</span>`
      + `<span class="route-del" title="Delete route">×</span>`;
    header.querySelector(".route-name").addEventListener("click", () => {
      setActiveRoute(route.id);
      updateEndpoints(); updatePathInfo(); updateStatus(); renderSelection();
    });
    header.querySelector(".route-color").addEventListener("click", () => {
      // Quick color reroll: cycle to the next palette slot. Keeps editing
      // light-touch — full color picker can be added later if needed.
      const cur = ROUTE_PALETTE.findIndex(c => c[0]===route.color[0] && c[1]===route.color[1] && c[2]===route.color[2]);
      const next = ROUTE_PALETTE[(cur + 1 + ROUTE_PALETTE.length) % ROUTE_PALETTE.length];
      route.color = next.slice();
      updateEndpoints(); renderSelection();
    });
    header.querySelector(".route-del").addEventListener("click", (e) => {
      e.stopPropagation();
      removeRoute(route.id);
      updateEndpoints(); updatePathInfo(); updateStatus(); renderSelection();
    });
    card.appendChild(header);

    // Waypoint list
    if (route.waypoints.length > 0) {
      const wpList = document.createElement("div");
      wpList.className = "wp-list";
      route.waypoints.forEach((wp, i) => {
        const sub = SUBHEX_INDEX.get(wp.subhexId);
        const wpRow = document.createElement("div");
        wpRow.className = "wp-row";
        const label = sub ? `${i+1}. ${escapeHtml(sub.name)}` : `${i+1}. (unknown)`;
        wpRow.innerHTML =
            `<span class="wp-idx">${i + 1}</span>`
          + (sub ? `<span class="swatch ${sub.class}"></span>` : `<span class="swatch"></span>`)
          + `<span class="wp-name">${sub ? escapeHtml(sub.name) : "(unknown)"}</span>`
          + `<span class="wp-del" title="Remove this waypoint">×</span>`;
        wpRow.querySelector(".wp-del").addEventListener("click", () => {
          removeWaypoint(route.id, i);
          updateEndpoints(); updatePathInfo(); updateStatus(); renderSelection();
        });
        wpList.appendChild(wpRow);
      });
      card.appendChild(wpList);
    }

    // Per-route stats (only meaningful with >=1 waypoint).
    if (route.totals && route.waypoints.length > 0) {
      const t = route.totals;
      const stats = document.createElement("div");
      stats.className = "route-stats";
      const dist = fmtMiKm(t.miles, t.km);
      let h = `<div class="row"><span>Hexes</span><span>${t.hexes}</span></div>`
            + `<div class="row"><span>Distance</span><span>${dist}</span></div>`
            + `<div class="row"><span>Cost</span><span>${t.cost.toFixed(1)}</span></div>`;
      if (t.embarks)     h += `<div class="row"><span>Embarks</span><span>${t.embarks}</span></div>`;
      if (t.ferries)     h += `<div class="row"><span>Ferries</span><span>${t.ferries}</span></div>`;
      if (!t.reachable)  h += `<div class="row reach"><span>Path</span><span>unreachable</span></div>`;
      stats.innerHTML = h;
      card.appendChild(stats);

      // Expandable per-hex breakdown — every hex on the route in order,
      // with that hex's per-hex contribution to the cost (max effective
      // weight of the components dijkstra chose inside it). Ferry hexes
      // get a "+ ferry" annotation; start hex shows "start" since it's
      // free. Collapsed by default to keep the sidebar tidy.
      if (route.segments.some(s => (s.hexIds && s.hexIds.length > 0))) {
        const det = document.createElement("details");
        det.className = "hex-breakdown";
        det.innerHTML = `<summary>Hex breakdown</summary>`;
        const tbl = document.createElement("div");
        tbl.className = "hex-rows";
        // Build the deduped hex sequence across all segments so a hex
        // that's the endpoint of segment N and start of segment N+1
        // shows once.
        const flat = [];
        for (let si = 0; si < route.segments.length; si++) {
          const seg = route.segments[si];
          if (!seg.hexIds) continue;
          for (let i = 0; i < seg.hexIds.length; i++) {
            const hid = seg.hexIds[i];
            if (flat.length === 0 || flat[flat.length - 1].hid !== hid) {
              flat.push({ hid, seg, idxInSeg: i });
            }
          }
        }
        // First hex of the whole route is the "start" (free).
        for (let k = 0; k < flat.length; k++) {
          const { hid, seg } = flat[k];
          const terrain = (typeof HEX_TERRAIN !== "undefined" && HEX_TERRAIN) ? HEX_TERRAIN.get(hid) : null;
          const w = seg.hexWeights ? seg.hexWeights.get(hid) : null;
          // Determine which subhex class(es) dijkstra actually traversed
          // in THIS hex. Cost is per-subhex-component, so the hex's sheet
          // terrain alone doesn't explain why two routes through the same
          // hex can have different costs — they may have visited
          // different subhexes within it. canonicalSubhexClass maps Plains
          // → Flatlands (etc.) so the displayed class lines up with the
          // weight column it's billed under.
          const visitedClasses = [];
          if (seg.subhexPath && typeof SUBHEX_INDEX !== "undefined") {
            const seen = new Set();
            for (const sid of seg.subhexPath) {
              const sub = SUBHEX_INDEX.get(sid);
              if (!sub || sub.hex !== hid) continue;
              const cls = (typeof canonicalSubhexClass === "function") ? canonicalSubhexClass(sub) : sub.class;
              if (cls && !seen.has(cls)) { seen.add(cls); visitedClasses.push(cls); }
            }
          }
          const visitedStr = visitedClasses.length > 0 ? visitedClasses.join("+") : (terrain || "?");
          const sheetSuffix = (terrain && visitedClasses.length > 0 && visitedClasses[0] !== terrain)
            ? `<span class="hex-sheet" title="Sheet terrain: ${escapeHtml(terrain)}"> · ${escapeHtml(terrain)}</span>`
            : "";

          // Start of the whole route is free; otherwise show this hex's
          // per-hex cost contribution.
          let costStr;
          if (k === 0) {
            costStr = `<span class="cost free">start</span>`;
          } else if (isFinite(w)) {
            costStr = `<span class="cost">${(+w).toFixed(2)}</span>`;
          } else {
            costStr = `<span class="cost muted">—</span>`;
          }
          // Annotations: ferry crossing tag.
          const tags = [];
          if (seg.usedFerryHexes && seg.usedFerryHexes.has(hid)) {
            const fw = (typeof weights !== "undefined" && weights["Ferry"] != null) ? +weights["Ferry"] : null;
            tags.push(`<span class="tag ferry" title="Ferry crossing">⛴${isFinite(fw) ? ` +${fw}` : ""}</span>`);
          }
          const row = document.createElement("div");
          row.className = "hex-row" + (k === 0 ? " is-start" : "") + (k === flat.length - 1 ? " is-end" : "");
          row.innerHTML =
              `<span class="hex-num">${k + 1}</span>`
            + `<span class="hex-id">${hid}</span>`
            + `<span class="hex-terrain">${escapeHtml(visitedStr)}${sheetSuffix}</span>`
            + tags.join("")
            + costStr;
          tbl.appendChild(row);
        }
        det.appendChild(tbl);
        card.appendChild(det);
      }
    }
    frag.appendChild(card);
  });
  routesListEl.innerHTML = "";
  routesListEl.appendChild(frag);
}

// Grand-total panel under the route list (only shown when there's >1 route or
// the single route has more than 2 waypoints — otherwise the per-route stats
// in the card already say everything).
function updatePathInfo() {
  if (ROUTES.length === 0) { pathInfoEl.innerHTML = ""; return; }
  const showTotals = ROUTES.length > 1
    || (ROUTES.length === 1 && ROUTES[0].waypoints.length > 2);
  if (!showTotals) { pathInfoEl.innerHTML = ""; return; }
  const t = allRoutesStats();
  const dist = fmtMiKm(t.miles, t.km);
  let h = `<div class="path-stats path-totals">`
        + `<div class="row totals-head"><span>Total across ${t.routes} route${t.routes===1?"":"s"}</span><span></span></div>`
        + `<div class="row"><span>Waypoints</span><span>${t.waypoints}</span></div>`
        + `<div class="row"><span>Hexes</span><span>${t.hexes}</span></div>`
        + `<div class="row"><span>Distance</span><span>${dist}</span></div>`
        + `<div class="row"><span>Cost</span><span>${t.cost.toFixed(1)}</span></div>`;
  if (t.embarks) h += `<div class="row"><span>Embarks</span><span>${t.embarks}</span></div>`;
  if (t.ferries) h += `<div class="row"><span>Ferries</span><span>${t.ferries}</span></div>`;
  h += `</div>`;
  pathInfoEl.innerHTML = h;
}

function updateStatus() {
  let s = `zoom ${(view.scale * 100).toFixed(0)}%`;
  const t = allRoutesStats();
  if (t.routes > 0) {
    s += `  ·  ${t.routes} route${t.routes===1?"":"s"}, ${t.waypoints} waypoint${t.waypoints===1?"":"s"}`;
    if (t.hexes > 0) s += `  ·  ${t.hexes} hexes (${Math.round(t.miles)} mi / ${Math.round(t.km)} km), cost ${t.cost.toFixed(1)}`;
  }
  statusEl.textContent = s;
}

function clearSelection() {
  clearAllRoutes();
  _lastRouteMask = null;
  renderSelection(); updateEndpoints(); updatePathInfo(); updateStatus();
}

document.getElementById("reset-view").addEventListener("click", () => resetView());
document.getElementById("reset-layers").addEventListener("click", () => {
  const onIds = new Set(["sea", "continent", "terrain", "rivers", "roads", "ctf"]);
  for (const l of LAYERS) { l.on = onIds.has(l.id); l.opacity = 1.0; }
  buildLayerControls(); renderLayers();
});
document.getElementById("new-route").addEventListener("click", () => {
  newRoute();
  updateEndpoints(); updatePathInfo(); updateStatus(); renderSelection();
});
document.getElementById("undo-waypoint").addEventListener("click", () => {
  if (popActiveWaypoint()) {
    updateEndpoints(); updatePathInfo(); updateStatus(); renderSelection();
  }
});
document.getElementById("clear-sel").addEventListener("click", clearSelection);
window.addEventListener("keydown", (e) => {
  // Escape clears everything; Ctrl/Cmd-Z pops the last waypoint of the active
  // route (with full route-drop on the last waypoint). Ignored when focus is
  // inside an editable input so the number inputs keep their normal undo.
  const tag = (e.target && e.target.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea") return;
  if (e.key === "Escape") clearSelection();
  else if ((e.ctrlKey || e.metaKey) && (e.key === "z" || e.key === "Z")) {
    e.preventDefault();
    if (popActiveWaypoint()) {
      updateEndpoints(); updatePathInfo(); updateStatus(); renderSelection();
    }
  }
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
    makeEditable(alphaVal,
      (t) => { const n = parseFloat(t); return isFinite(n) ? Math.max(0, Math.min(100, n)) : null; },
      (v) => { c.setA(Math.round((v / 100) * 255)); alphaInput.value = v; renderSelection(); },
      () => Math.round((c.getA() / 255) * 100) + "%");
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
  makeEditable(lwLabel,
    (t) => { const n = parseFloat(t); return isFinite(n) ? Math.max(1, Math.min(10, n)) : null; },
    (v) => { LINE_WIDTH = v; lwSlider.value = v; renderSelection(); },
    () => LINE_WIDTH + "px");
  lineEl.appendChild(lwRow);

  // Minimum centerline pixels a hex needs along the rendered line before
  // it counts toward the route's hex count and cost. Lets the user tune
  // out brief detours where the line dips into an adjacent hex for a few
  // road pixels (and back) — those would otherwise inflate "Hexes" and
  // distance even though the user never really left the main hex. Changing
  // this rebuilds all routes so the totals reflect the new threshold.
  const mpRow = document.createElement("div");
  mpRow.className = "weight-row";
  mpRow.innerHTML = `<span class="name">Min line px / hex</span>`
    + `<input type="range" min="0" max="500" step="1" value="${MIN_PIXELS_PER_PATH_HEX}" />`
    + `<span class="alpha-val">${MIN_PIXELS_PER_PATH_HEX}px</span>`;
  const mpSlider = mpRow.querySelector("input");
  const mpLabel  = mpRow.querySelector(".alpha-val");
  const applyMp = () => {
    mpLabel.textContent = MIN_PIXELS_PER_PATH_HEX + "px";
    if (ROUTES.length > 0) {
      recomputePath(); renderSelection(); updateEndpoints(); updatePathInfo(); updateStatus();
    }
  };
  mpSlider.addEventListener("input", (e) => {
    MIN_PIXELS_PER_PATH_HEX = +e.target.value;
    applyMp();
  });
  makeEditable(mpLabel,
    (t) => { const n = parseInt(t, 10); return isFinite(n) ? Math.max(0, Math.min(5000, n)) : null; },
    (v) => { MIN_PIXELS_PER_PATH_HEX = v; mpSlider.value = v; applyMp(); },
    () => MIN_PIXELS_PER_PATH_HEX + "px");
  lineEl.appendChild(mpRow);

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
  makeEditable(psLabel,
    (t) => { const n = parseFloat(t); return isFinite(n) ? Math.max(0, Math.min(10, n)) : null; },
    (v) => { POINT_SIZE = v; psSlider.value = v; renderSelection(); },
    () => POINT_SIZE + "px");
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
  makeEditable(owLabel,
    (t) => { const n = parseFloat(t); return isFinite(n) ? Math.max(1, Math.min(10, n)) : null; },
    (v) => { HEX_OUTLINE_WIDTH = v; owSlider.value = v; renderSelection(); },
    () => HEX_OUTLINE_WIDTH + "px");
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

  // [debug] Route-mask overlay — paints the binary mask routeThroughMask
  // actually fed to A* as a translucent magenta layer over hl-canvas. Useful
  // for confirming which pixels are restricted to road and which subhexes
  // are passable in a given route.
  const dbgRow = document.createElement("div");
  dbgRow.className = "layer-row";
  dbgRow.innerHTML = `<input type="checkbox" id="debug-mask" ${DEBUG_SHOW_MASK ? "checked" : ""} />`
    + `<label for="debug-mask">[debug] Route mask</label>`;
  dbgRow.querySelector("input").addEventListener("change", (e) => {
    DEBUG_SHOW_MASK = e.target.checked;
    renderSelection();
  });
  lineEl.appendChild(dbgRow);

  // [debug] River-type overlay — paints river pixels by classification:
  //   green  = thin (1-px wide, fordable)
  //   red    = thick core (≥3 4-connected river neighbors)
  //   orange = 1-px halo around thick river (AA / bank, also impassable)
  // Helps verify why a route does or doesn't go through a given river.
  const dbgRiverRow = document.createElement("div");
  dbgRiverRow.className = "layer-row";
  dbgRiverRow.innerHTML = `<input type="checkbox" id="debug-river" ${DEBUG_SHOW_RIVER_TYPES ? "checked" : ""} />`
    + `<label for="debug-river">[debug] River types</label>`;
  dbgRiverRow.querySelector("input").addEventListener("change", (e) => {
    DEBUG_SHOW_RIVER_TYPES = e.target.checked;
    renderSelection();
  });
  lineEl.appendChild(dbgRiverRow);

  // [debug] Ferry hexes — translucent yellow tint over every hex whose
  // artwork has road pixels overlaid on thick-river pixels. Quick visual
  // check that the ferry detector picked up a crossing you can see in the
  // art.
  const dbgFerryRow = document.createElement("div");
  dbgFerryRow.className = "layer-row";
  dbgFerryRow.innerHTML = `<input type="checkbox" id="debug-ferry" ${DEBUG_SHOW_FERRY_HEXES ? "checked" : ""} />`
    + `<label for="debug-ferry">[debug] Ferry hexes</label>`;
  dbgFerryRow.querySelector("input").addEventListener("change", (e) => {
    DEBUG_SHOW_FERRY_HEXES = e.target.checked;
    renderSelection();
  });
  lineEl.appendChild(dbgFerryRow);

  // [debug] Subhex types — paints every pixel by its routing CATEGORY:
  //   blue   = Naval (Sea / Lake / Ocean class)
  //   orange = Infrastructure (road or city pixel)
  //   green  = Land that passes the assigned-weight check (subhex class
  //            weight ≤ parent hex's terrain weight, so dijkstra can
  //            enter it). Heavier land is left untinted.
  // Useful for verifying that the three-category split matches what
  // routeThroughMask actually treats as passable.
  const dbgSubhexTypesRow = document.createElement("div");
  dbgSubhexTypesRow.className = "layer-row";
  dbgSubhexTypesRow.innerHTML = `<input type="checkbox" id="debug-subhex-types" ${DEBUG_SHOW_SUBHEX_TYPES ? "checked" : ""} />`
    + `<label for="debug-subhex-types">[debug] Subhex types (Land / Infra / Naval)</label>`;
  dbgSubhexTypesRow.querySelector("input").addEventListener("change", (e) => {
    DEBUG_SHOW_SUBHEX_TYPES = e.target.checked;
    // Assigned-weight classification depends on the per-class weights
    // table; if those change, the overlay's land-vs-heavy decisions
    // shift too. Invalidate the cached canvas on every toggle so the
    // classification reflects the current weights.
    invalidateDebugSubhexTypes();
    renderSelection();
  });
  lineEl.appendChild(dbgSubhexTypesRow);
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

// ----- Reachability (isochrone) panel -----
function buildIsochroneControls() {
  isoEl.innerHTML = "";

  const onRow = document.createElement("div");
  onRow.className = "layer-row";
  onRow.innerHTML = `<input type="checkbox" id="iso-on" ${ISOCHRONE_MODE ? "checked" : ""} />`
    + `<label for="iso-on">Enable (click to set origin)</label>`;
  onRow.querySelector("input").addEventListener("change", (e) => {
    ISOCHRONE_MODE = e.target.checked;
    if (!ISOCHRONE_MODE) {
      isochroneSourceId = null;
      isochroneHexIds = null;
      isochroneSubhexIds = null;
    } else if (isochroneSourceId != null) {
      computeIsochrone();
    }
    renderLayers(); renderSelection(); updateStatus();
  });
  isoEl.appendChild(onRow);

  const bRow = document.createElement("div");
  bRow.className = "weight-row";
  bRow.innerHTML = `<span class="name">Budget</span>`
    + `<input type="range" min="1" max="200" step="1" value="${ISOCHRONE_BUDGET}" />`
    + `<span class="alpha-val">${ISOCHRONE_BUDGET}</span>`;
  const bSlider = bRow.querySelector("input");
  const bLabel  = bRow.querySelector(".alpha-val");
  bSlider.addEventListener("input", (e) => {
    ISOCHRONE_BUDGET = +e.target.value;
    bLabel.textContent = ISOCHRONE_BUDGET;
    if (ISOCHRONE_MODE && isochroneSourceId != null) {
      computeIsochrone();
      renderLayers(); renderSelection(); updateStatus();
    }
  });
  makeEditable(bLabel,
    (t) => { const n = parseFloat(t); return isFinite(n) && n > 0 ? n : null; },
    (v) => {
      ISOCHRONE_BUDGET = v; bSlider.value = v;
      if (ISOCHRONE_MODE && isochroneSourceId != null) { computeIsochrone(); renderLayers(); renderSelection(); updateStatus(); }
    },
    () => String(ISOCHRONE_BUDGET));
  isoEl.appendChild(bRow);

  const cRow = document.createElement("div");
  cRow.className = "color-row";
  const hex = rgbToHex(ISOCHRONE_COLOR);
  const aPct = Math.round((ISOCHRONE_ALPHA / 255) * 100);
  cRow.innerHTML = `<span class="name">Color</span>`
    + `<input type="color" value="${hex}" />`
    + `<input type="range" class="alpha" min="0" max="100" value="${aPct}" title="opacity" />`
    + `<span class="alpha-val">${aPct}%</span>`;
  const colorInput = cRow.querySelector("input[type=color]");
  const alphaInput = cRow.querySelector("input[type=range]");
  const alphaVal   = cRow.querySelector(".alpha-val");
  colorInput.addEventListener("input", (e) => {
    ISOCHRONE_COLOR = hexToRgb(e.target.value);
    renderLayers();
  });
  alphaInput.addEventListener("input", (e) => {
    const pct = +e.target.value;
    ISOCHRONE_ALPHA = Math.round((pct / 100) * 255);
    alphaVal.textContent = pct + "%";
    renderLayers();
  });
  makeEditable(alphaVal,
    (t) => { const n = parseFloat(t); return isFinite(n) ? Math.max(0, Math.min(100, n)) : null; },
    (v) => { ISOCHRONE_ALPHA = Math.round((v / 100) * 255); alphaInput.value = v; renderLayers(); },
    () => Math.round((ISOCHRONE_ALPHA / 255) * 100) + "%");
  isoEl.appendChild(cRow);
}
// Reachability section show/hide toggle (mirrors the Settings panel pattern:
// the heading + body live in a sibling panel-section that gets hidden, so the
// whole section vanishes when collapsed and only the toggle button remains).
{
  const tbtn = document.getElementById("reach-toggle");
  const tpanels = document.getElementById("reach-panels");
  if (tbtn && tpanels) {
    tbtn.addEventListener("click", () => {
      const isHidden = tpanels.classList.toggle("hidden");
      tbtn.textContent = isHidden ? "Show reachability" : "Hide reachability";
      if (isHidden && ISOCHRONE_MODE) {
        // Collapse the panel -> also turn off the click-capture mode so normal
        // From/To clicking comes back. Keeps state in case you re-open it.
        ISOCHRONE_MODE = false;
        renderLayers(); renderSelection();
        buildIsochroneControls();
      }
    });
  }
}
