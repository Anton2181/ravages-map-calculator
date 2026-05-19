"use strict";

// =================== Config ===================
const LAYERS = [
  { id: "sea",         file: "sea.png",                 label: "Sea fill",               on: true,  opacity: 1.00 },
  { id: "continent",   file: "Continent Meat.png",      label: "Continent meat",         on: false, opacity: 1.00 },
  { id: "terrain",     file: "Terrain.png",             label: "Terrain (elevation)",    on: true,  opacity: 1.00 },
  { id: "rivers",      file: "rivers.png",              label: "Rivers",                 on: false, opacity: 1.00 },
  { id: "roads",       file: "Roads.png",               label: "Roads",                  on: false, opacity: 1.00 },
  { id: "ctf",         file: "citiestownsforts.png",    label: "Cities / towns / forts", on: false, opacity: 1.00 },
  { id: "simple",      file: "simple grid.png",         label: "Simple grid",            on: false, opacity: 0.40 },
  { id: "base",        file: "Ravages_ver_6.3_hex.png", label: "Player map (base)",      on: false, opacity: 1.00 },
];
const CLASSES = ["Flatlands", "Plains", "Woodland", "Hills", "Mountains", "Peaks", "Lake", "Sea", "Ocean", "Sailing", "Embark"];
const DEFAULT_WEIGHTS = {
  "Flatlands": 1, "Plains": 1, "Woodland": 2,
  "Hills": 2, "Mountains": 5, "Peaks": 8,
  "Lake": 15, "Sea": 20, "Ocean": 20,
  // Special edge weights (not hex terrain types):
  //   Sailing — water -> water step (cheap; ships travel fast).
  //   Embark  — land <-> water boundary crossing (loading or unloading a ship).
  "Sailing": 1, "Embark": 5,
};

// Hex terrains classified as water. Used to pick which edge weight applies.
const WATER_TERRAINS = new Set(["Ocean", "Sea", "Lake"]);
// URL of the public Google Sheet that maps hex id -> main terrain (refetched
// each session so edits in the sheet immediately affect pathfinding).
const HEX_TERRAIN_CSV_URL = "https://docs.google.com/spreadsheets/d/1jC2kO_Hidhg4WoL-jBGw1lKKD5s6a1-xoqv1omTZR_k/gviz/tq?tqx=out:csv&gid=0";
let START_COLOR = [98, 224, 192];
let END_COLOR   = [255, 108, 140];
let PATH_COLOR  = [255, 208, 96];
let PATH_LINE_COLOR = [255, 0, 0];
let START_ALPHA = 0, END_ALPHA = 0, PATH_ALPHA = 0, LINE_ALPHA = 255;
let LINE_WIDTH = 3, POINT_SIZE = 0, LINE_AA = false;
let SHOW_HEX_OUTLINE = false;
let HEX_OUTLINE_COLOR = [0, 0, 0], HEX_OUTLINE_ALPHA = 255;
let HEX_OUTLINE_WIDTH = 1, HEX_OUTLINE_AA = false;

// =================== DOM ===================
const stage       = document.getElementById("stage");
const mapCanvas   = document.getElementById("map-canvas");
const hlCanvas    = document.getElementById("hl-canvas");
const mapCtx      = mapCanvas.getContext("2d");
const hlCtx       = hlCanvas.getContext("2d");
const layersEl    = document.getElementById("layers");
const endpointsEl = document.getElementById("endpoints");
const pathInfoEl  = document.getElementById("path-info");
const weightsEl   = document.getElementById("weights");
const colorsEl    = document.getElementById("colors");
const lineEl      = document.getElementById("line-style");
const tooltipEl   = document.getElementById("hover-tooltip");
const statusEl    = document.getElementById("status");
const loadingEl   = document.getElementById("loading");

// =================== State ===================
let HEX_DATA = null;
let SUBHEX_INDEX = null;
let SUBHEX_ID_IMG_DATA = null;
let NEIGHBORS = null;
let IMAGES = {};
let view = { x: 0, y: 0, scale: 1.0 };
let weights = Object.assign({}, DEFAULT_WEIGHTS);
let fromId = null, toId = null;
let pathIds = null, pathSet = null;
let pathHexIds = null;          // ordered hex ids on the path
let pathSubhexIds = null;        // Set of subhex ids included in the drawing mask
let HEX_TERRAIN = null;          // Map<hex_id, terrain_string>
let SUBHEXES_BY_HEX = null;      // Map<hex_id, array of subhex objects>

// =================== Loading ===================
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to load " + src));
    img.src = src;
  });
}

// Fetch the public spreadsheet CSV and parse Hexcode -> Terrain.
async function loadHexTerrains() {
  try {
    const r = await fetch(HEX_TERRAIN_CSV_URL, { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const text = await r.text();
    const rows = parseCSV(text);
    if (rows.length === 0) throw new Error("empty CSV");
    const header = rows[0];
    let iId = header.findIndex(h => /hex/i.test(h));
    let iTerrain = header.findIndex(h => /terrain/i.test(h));
    if (iId < 0) iId = 0;
    if (iTerrain < 0) iTerrain = 1;
    const out = new Map();
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row.length === 0) continue;
      const id = parseInt(row[iId], 10);
      const terrain = (row[iTerrain] || "").trim();
      if (Number.isFinite(id) && terrain) out.set(id, terrain);
    }
    console.log(`Loaded ${out.size} hex terrain entries from sheet.`);
    return out;
  } catch (e) {
    console.warn("Failed to load terrain CSV:", e);
    return new Map();
  }
}

// Minimal RFC-4180-ish CSV parser. Handles quoted fields, escaped quotes
// ('""'), and CRLF line endings inside or outside quotes.
function parseCSV(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += c;
      }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else if (c === "\r") { /* swallow */ }
      else field += c;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

// Six neighbors of a hex id in pointy-top offset (odd rows offset RIGHT).
function hexNeighbors(hid) {
  const cpr = HEX_DATA.cols_per_row;
  const totalRows = HEX_DATA.rows.length;
  const row = Math.floor((hid - 1) / cpr);
  const col = (hid - 1) % cpr;
  let nbrs;
  if (row % 2 === 0) {
    nbrs = [[row-1,col],[row,col+1],[row+1,col],[row+1,col-1],[row,col-1],[row-1,col-1]];
  } else {
    nbrs = [[row-1,col+1],[row,col+1],[row+1,col+1],[row+1,col],[row,col-1],[row-1,col]];
  }
  const out = [];
  for (const [r, c] of nbrs) {
    if (r < 0 || r >= totalRows || c < 0 || c >= cpr) continue;
    out.push(r * cpr + c + 1);
  }
  return out;
}
async function loadAll() {
  loadingEl.textContent = "Loading hex data…";
  HEX_DATA = await (await fetch("hex_data.json")).json();
  loadingEl.textContent = "Loading subhex data…";
  const sub = await (await fetch("subhex_data.json")).json();
  SUBHEX_INDEX = new Map();
  SUBHEXES_BY_HEX = new Map();
  for (const s of sub.subhexes) {
    SUBHEX_INDEX.set(s.id, s);
    if (!SUBHEXES_BY_HEX.has(s.hex)) SUBHEXES_BY_HEX.set(s.hex, []);
    SUBHEXES_BY_HEX.get(s.hex).push(s);
  }
  loadingEl.textContent = "Loading terrain table…";
  HEX_TERRAIN = await loadHexTerrains();
  loadingEl.textContent = "Loading neighbor graph…";
  const ng = await (await fetch("neighbors.json")).json();
  NEIGHBORS = new Map();
  for (const [k, v] of Object.entries(ng.neighbors)) NEIGHBORS.set(+k, v);
  loadingEl.textContent = "Loading subhex map…";
  const sIm = await loadImage("subhex_id_map.png");
  const sc = document.createElement("canvas");
  sc.width = sIm.naturalWidth; sc.height = sIm.naturalHeight;
  const sctx = sc.getContext("2d", { willReadFrequently: true });
  sctx.drawImage(sIm, 0, 0);
  SUBHEX_ID_IMG_DATA = sctx.getImageData(0, 0, sc.width, sc.height);
  loadingEl.textContent = "Loading map layers…";
  await Promise.all(LAYERS.map(async (l) => {
    try { IMAGES[l.id] = await loadImage(encodeURI(l.file)); }
    catch (e) { console.warn("Layer load failed:", l.id, e); IMAGES[l.id] = null; }
  }));
  for (const c of [mapCanvas, hlCanvas]) {
    c.width = HEX_DATA.image_width; c.height = HEX_DATA.image_height;
  }
  loadingEl.classList.add("hidden");
}

// =================== Hex math ===================
function hexIdFromRC(row, col) { return row * HEX_DATA.cols_per_row + col + 1; }
function pointToHex(x, y) {
  const g = HEX_DATA.geometry;
  const ry = (y - g.first_cy) / g.row_spacing;
  const r_lo = Math.floor(ry);
  let best = null, bestD = Infinity;
  for (const r of [r_lo, r_lo + 1]) {
    if (r < 0 || r >= HEX_DATA.rows.length) continue;
    const cx0 = (r % 2 === 0) ? g.first_cx_even : g.first_cx_odd;
    const cf = (x - cx0) / g.hex_width;
    for (const c of [Math.floor(cf), Math.floor(cf) + 1]) {
      if (c < 0 || c >= HEX_DATA.cols_per_row) continue;
      const cx = cx0 + c * g.hex_width;
      const cy = g.first_cy + r * g.row_spacing;
      const d = (x - cx) ** 2 + (y - cy) ** 2;
      if (d < bestD) { bestD = d; best = { row: r, col: c, id: hexIdFromRC(r, c) }; }
    }
  }
  return best;
}

// =================== Pathfinding wrapper ===================
function recomputePath() {
  pathIds = null; pathSet = null;
  pathHexIds = null; pathSubhexIds = null;
  if (fromId == null || toId == null) return;
  const fromSub = SUBHEX_INDEX.get(fromId), toSub = SUBHEX_INDEX.get(toId);
  if (!fromSub || !toSub) return;
  // Dijkstra on the hex graph using the sheet's terrain per hex.
  const srcHex = fromSub.hex, dstHex = toSub.hex;
  const dist = new Map();
  const prev = new Map();
  const heap = new MinHeap();
  dist.set(srcHex, 0);
  heap.push([0, srcHex]);
  while (heap.size() > 0) {
    const [d, u] = heap.pop();
    if (u === dstHex) break;
    if (d > dist.get(u)) continue;
    const uTerrain = HEX_TERRAIN ? HEX_TERRAIN.get(u) : null;
    const uIsWater = uTerrain ? WATER_TERRAINS.has(uTerrain) : false;
    for (const v of hexNeighbors(u)) {
      const vTerrain = HEX_TERRAIN ? HEX_TERRAIN.get(v) : null;
      if (!vTerrain) continue;
      const vIsWater = WATER_TERRAINS.has(vTerrain);
      // Edge cost depends on which side(s) of shore we're on.
      let w;
      if (uIsWater && vIsWater)        w = +weights["Sailing"];
      else if (uIsWater !== vIsWater)  w = +weights["Embark"];
      else                             w = +weights[vTerrain];
      if (!isFinite(w) || w <= 0) continue;  // impassable / unknown
      const nd = d + w;
      if (!dist.has(v) || nd < dist.get(v)) {
        dist.set(v, nd); prev.set(v, u);
        heap.push([nd, v]);
      }
    }
  }
  if (!dist.has(dstHex)) return;
  // Reconstruct hex path.
  const hexPath = [];
  let cur = dstHex;
  while (cur != null) {
    hexPath.push(cur);
    if (cur === srcHex) break;
    cur = prev.get(cur);
  }
  hexPath.reverse();
  pathHexIds = hexPath;
  // Drawing mask: for each path hex, include every subhex whose CLASS weight
  // is <= the hex's main-terrain weight. Always include start and end subhexes
  // so the user's clicked endpoints are visible / reachable.
  const subSet = new Set([fromId, toId]);
  for (const hid of hexPath) {
    const terrain = HEX_TERRAIN ? HEX_TERRAIN.get(hid) : null;
    const hexW = terrain ? +weights[terrain] : NaN;
    if (!isFinite(hexW)) continue;
    const subs = SUBHEXES_BY_HEX.get(hid) || [];
    for (const sub of subs) {
      const sw = +weights[sub.class];
      if (isFinite(sw) && sw <= hexW) subSet.add(sub.id);
    }
  }
  pathSubhexIds = subSet;
  pathIds = Array.from(subSet);   // legacy alias
  pathSet = subSet;
}

// =================== Border midpoint between two adjacent subhexes ===================
// Scans the bbox intersection (+1 px margin) of the two subhexes for pixels of
// idA that are 4-adjacent to a pixel of idB, and averages the midpoints of
// those adjacencies. Returns null if the subhexes aren't actually pixel-adjacent
// (shouldn't happen for true graph neighbors).
function findBorderMidpoint(idA, idB) {
  const sA = SUBHEX_INDEX.get(idA), sB = SUBHEX_INDEX.get(idB);
  if (!sA || !sB) return null;
  const x0 = Math.max(sA.bbox[0], sB.bbox[0]) - 1;
  const y0 = Math.max(sA.bbox[1], sB.bbox[1]) - 1;
  const x1 = Math.min(sA.bbox[2], sB.bbox[2]) + 1;
  const y1 = Math.min(sA.bbox[3], sB.bbox[3]) + 1;
  const data = SUBHEX_ID_IMG_DATA.data;
  const W = SUBHEX_ID_IMG_DATA.width, H = SUBHEX_ID_IMG_DATA.height;
  const xa = Math.max(0, x0), xb = Math.min(W - 1, x1);
  const ya = Math.max(0, y0), yb = Math.min(H - 1, y1);
  if (xb < xa || yb < ya) return null;
  // Collect every edge midpoint between an A pixel and a B pixel. Then return
  // the BBOX CENTER of those midpoints (geometric middle of the shared border
  // extent) rather than the centroid (which would weight by edge density and
  // skew toward dense or curved sections of the border).
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  let found = false;
  function note(mx, my) {
    found = true;
    if (mx < minX) minX = mx; if (mx > maxX) maxX = mx;
    if (my < minY) minY = my; if (my > maxY) maxY = my;
  }
  for (let y = ya; y <= yb; y++) {
    for (let x = xa; x <= xb; x++) {
      const p = (y * W + x) * 4;
      const id = data[p] | (data[p+1] << 8) | (data[p+2] << 16);
      if (id !== idA) continue;
      if (x + 1 <= W - 1) {
        const q = (y * W + x + 1) * 4;
        if ((data[q] | (data[q+1] << 8) | (data[q+2] << 16)) === idB) note(x + 0.5, y);
      }
      if (x - 1 >= 0) {
        const q = (y * W + x - 1) * 4;
        if ((data[q] | (data[q+1] << 8) | (data[q+2] << 16)) === idB) note(x - 0.5, y);
      }
      if (y + 1 <= H - 1) {
        const q = ((y + 1) * W + x) * 4;
        if ((data[q] | (data[q+1] << 8) | (data[q+2] << 16)) === idB) note(x, y + 0.5);
      }
      if (y - 1 >= 0) {
        const q = ((y - 1) * W + x) * 4;
        if ((data[q] | (data[q+1] << 8) | (data[q+2] << 16)) === idB) note(x, y - 0.5);
      }
    }
  }
  if (!found) return null;
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
}

function buildPathLinePoints() {
  if (!pathSubhexIds || pathSubhexIds.size === 0) return [];
  // First attempt: route through the user-requested filtered mask.
  let pts = routeThroughMask(pathSubhexIds);
  if (pts.length === 0 && pathHexIds && pathHexIds.length > 0) {
    // Fallback: the filtered mask is non-contiguous from from->to. Include
    // ALL subhexes of every path hex so the road can still be drawn.
    const fallback = new Set();
    if (fromId != null) fallback.add(fromId);
    if (toId   != null) fallback.add(toId);
    for (const hid of pathHexIds) {
      for (const sub of (SUBHEXES_BY_HEX.get(hid) || [])) fallback.add(sub.id);
    }
    pts = routeThroughMask(fallback);
  }
  return pts;
}

// Build the union mask of the given subhex id set, then A* + string-pull from
// the From centroid to the To centroid through it. Returns [] if either
// endpoint isn't reachable.
function routeThroughMask(subSet) {
  const sStart = SUBHEX_INDEX.get(fromId), sEnd = SUBHEX_INDEX.get(toId);
  if (!sStart || !sEnd) return [];
  if (fromId === toId) {
    return [{ x: sStart.centroid[0], y: sStart.centroid[1] }];
  }
  const data = SUBHEX_ID_IMG_DATA.data;
  const W = SUBHEX_ID_IMG_DATA.width, H = SUBHEX_ID_IMG_DATA.height;
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  for (const sid of subSet) {
    const s = SUBHEX_INDEX.get(sid);
    if (!s) continue;
    if (s.bbox[0] < bx0) bx0 = s.bbox[0];
    if (s.bbox[1] < by0) by0 = s.bbox[1];
    if (s.bbox[2] > bx1) bx1 = s.bbox[2];
    if (s.bbox[3] > by1) by1 = s.bbox[3];
  }
  if (!isFinite(bx0)) return [];
  bx0 = Math.max(0, bx0 - 1); by0 = Math.max(0, by0 - 1);
  bx1 = Math.min(W - 1, bx1 + 1); by1 = Math.min(H - 1, by1 + 1);
  const mw = bx1 - bx0 + 1, mh = by1 - by0 + 1;
  const mask = new Uint8Array(mw * mh);
  for (let y = 0; y < mh; y++) {
    const rowOff = (y + by0) * W;
    for (let x = 0; x < mw; x++) {
      const p = (rowOff + (x + bx0)) * 4;
      const id = data[p] | (data[p+1] << 8) | (data[p+2] << 16);
      if (subSet.has(id)) mask[y * mw + x] = 1;
    }
  }
  const startPt = { x: sStart.centroid[0], y: sStart.centroid[1] };
  const endPt   = { x: sEnd.centroid[0],   y: sEnd.centroid[1]   };
  const sX = snapToMask(mask, mw, mh, Math.round(startPt.x - bx0), Math.round(startPt.y - by0));
  const eX = snapToMask(mask, mw, mh, Math.round(endPt.x   - bx0), Math.round(endPt.y   - by0));
  if (!sX || !eX) return [];
  const rawPath = aStarInMask(mask, mw, mh, sX[0], sX[1], eX[0], eX[1]);
  if (!rawPath) return [];
  const smoothed = stringPull(rawPath, mask, mw, mh);
  const pts = [startPt];
  for (const [px, py] of smoothed) pts.push({ x: px + bx0, y: py + by0 });
  pts.push(endPt);
  const cleaned = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const prev = cleaned[cleaned.length - 1];
    if (Math.hypot(pts[i].x - prev.x, pts[i].y - prev.y) > 0.75) cleaned.push(pts[i]);
  }
  return cleaned;
}

function drawPathLine() {
  const pts = buildPathLinePoints();
  if (pts.length < 2) return;
  const rgba = `rgba(${PATH_LINE_COLOR.join(",")},${LINE_ALPHA/255})`;
  if (LINE_AA) {
    hlCtx.strokeStyle = rgba;
    hlCtx.lineWidth = LINE_WIDTH;
    hlCtx.lineCap = "round";
    hlCtx.lineJoin = "round";
    hlCtx.beginPath();
    hlCtx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) hlCtx.lineTo(pts[i].x, pts[i].y);
    hlCtx.stroke();
    if (POINT_SIZE > 0) {
      hlCtx.fillStyle = rgba;
      for (const p of pts) {
        hlCtx.beginPath();
        hlCtx.arc(p.x, p.y, POINT_SIZE, 0, Math.PI * 2);
        hlCtx.fill();
      }
    }
  } else {
    // Pixel-perfect: Bresenham segments + integer-sized square dots.
    hlCtx.fillStyle = rgba;
    const thick = Math.max(1, Math.round(LINE_WIDTH));
    const half  = Math.floor(thick / 2);
    for (let i = 0; i < pts.length - 1; i++) {
      drawLineBresenham(pts[i].x, pts[i].y, pts[i+1].x, pts[i+1].y, thick, half);
    }
    if (POINT_SIZE > 0) {
      const side = Math.max(1, Math.round(POINT_SIZE * 2));
      const ofs  = Math.floor(side / 2);
      for (const p of pts) {
        hlCtx.fillRect(Math.round(p.x) - ofs, Math.round(p.y) - ofs, side, side);
      }
    }
  }
}

// Bresenham with optional thickness: stamps a thick x thick square at every step.
function drawLineBresenham(x0, y0, x1, y1, thick, half) {
  x0 = Math.round(x0); y0 = Math.round(y0);
  x1 = Math.round(x1); y1 = Math.round(y1);
  const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
  const dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  while (true) {
    if (thick <= 1) hlCtx.fillRect(x0, y0, 1, 1);
    else hlCtx.fillRect(x0 - half, y0 - half, thick, thick);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

// =================== Rendering ===================
function renderLayers() {
  mapCtx.clearRect(0, 0, mapCanvas.width, mapCanvas.height);
  for (const l of LAYERS) {
    if (!l.on || !IMAGES[l.id]) continue;
    mapCtx.globalAlpha = l.opacity;
    mapCtx.drawImage(IMAGES[l.id], 0, 0);
  }
  mapCtx.globalAlpha = 1.0;
}
const _scratchCanvas = document.createElement("canvas");
const _scratchCtx = _scratchCanvas.getContext("2d");
function fillSubhex(sub, rgb, alpha) {
  if (!sub) return;
  const [x0, y0, x1, y1] = sub.bbox;
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  if (_scratchCanvas.width !== w || _scratchCanvas.height !== h) {
    _scratchCanvas.width = w; _scratchCanvas.height = h;
  } else {
    _scratchCtx.clearRect(0, 0, w, h);
  }
  const img = _scratchCtx.createImageData(w, h);
  const px = SUBHEX_ID_IMG_DATA.data;
  const W = SUBHEX_ID_IMG_DATA.width;
  let oi = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = ((y + y0) * W + (x + x0)) * 4;
      const id = px[p] | (px[p+1] << 8) | (px[p+2] << 16);
      if (id === sub.id) {
        img.data[oi]   = rgb[0]; img.data[oi+1] = rgb[1];
        img.data[oi+2] = rgb[2]; img.data[oi+3] = alpha;
      }
      oi += 4;
    }
  }
  _scratchCtx.putImageData(img, 0, 0);
  hlCtx.drawImage(_scratchCanvas, x0, y0);
}


// Hex-graph path statistics for display. Cost = sum of weights[HEX_TERRAIN[h]]
// over hexes the path enters (excludes the starting hex).
function pathStats() {
  if (!pathHexIds || pathHexIds.length === 0) {
    return { hexes: 0, subhexes: 0, cost: 0, byTerrain: {} };
  }
  let cost = 0;
  const byTerrain = {};
  let embarks = 0, sails = 0;
  for (let i = 0; i < pathHexIds.length; i++) {
    const hid = pathHexIds[i];
    const terrain = HEX_TERRAIN ? HEX_TERRAIN.get(hid) : null;
    if (terrain) byTerrain[terrain] = (byTerrain[terrain] || 0) + 1;
    if (i > 0 && terrain) {
      const prevTerrain = HEX_TERRAIN ? HEX_TERRAIN.get(pathHexIds[i - 1]) : null;
      const prevIsWater = prevTerrain ? WATER_TERRAINS.has(prevTerrain) : false;
      const curIsWater  = WATER_TERRAINS.has(terrain);
      let w;
      if (prevIsWater && curIsWater)        { w = +weights["Sailing"]; sails++; }
      else if (prevIsWater !== curIsWater)  { w = +weights["Embark"];  embarks++; }
      else                                   { w = +weights[terrain]; }
      if (isFinite(w)) cost += w;
    }
  }
  // One hex of movement = 30 miles. Distance is the count of inter-hex
  // transitions (hexes - 1), since the starting hex is where you begin.
  const miles = Math.max(0, pathHexIds.length - 1) * 30;
  const km    = miles * 1.609344;
  return {
    hexes: pathHexIds.length,
    subhexes: pathSubhexIds ? pathSubhexIds.size : 0,
    cost, byTerrain, embarks, sails,
    miles, km,
  };
}
function drawHexOutlines() {
  if (!SHOW_HEX_OUTLINE || !pathIds || pathIds.length === 0) return;
  if (!pathHexIds || pathHexIds.length === 0) return;
  const hexIds = new Set(pathHexIds);
  const g = HEX_DATA.geometry;
  const s = g.hex_size, hw = g.hex_width / 2;
  const cpr = HEX_DATA.cols_per_row;
  const rgba = `rgba(${HEX_OUTLINE_COLOR.join(",")},${HEX_OUTLINE_ALPHA/255})`;
  const thick = Math.max(1, Math.round(HEX_OUTLINE_WIDTH));
  const half  = Math.floor(thick / 2);
  if (HEX_OUTLINE_AA) {
    hlCtx.strokeStyle = rgba;
    hlCtx.lineWidth = HEX_OUTLINE_WIDTH;
    hlCtx.lineCap = "round";
    hlCtx.lineJoin = "round";
  } else {
    hlCtx.fillStyle = rgba;
  }

  function hidOf(row, col) {
    if (row < 0 || col < 0 || col >= cpr) return -1;
    return row * cpr + col + 1;
  }
  function hasHex(row, col) {
    const id = hidOf(row, col);
    return id > 0 && hexIds.has(id);
  }

  for (const hid of hexIds) {
    const row = Math.floor((hid - 1) / cpr);
    const col = (hid - 1) % cpr;
    const cx0 = (row % 2 === 0) ? g.first_cx_even : g.first_cx_odd;
    const cx  = cx0 + col * g.hex_width;
    const cy  = g.first_cy + row * g.row_spacing;
    // Pointy-top vertices, clockwise from top.
    const verts = [
      [cx,      cy - s],       // 0 top
      [cx + hw, cy - s/2],     // 1 top-right
      [cx + hw, cy + s/2],     // 2 bot-right
      [cx,      cy + s],       // 3 bot
      [cx - hw, cy + s/2],     // 4 bot-left
      [cx - hw, cy - s/2],     // 5 top-left
    ];
    // Neighbor (row, col) per edge index. Edge i = verts[i] -> verts[(i+1)%6].
    // Edge 0 = NE, 1 = E, 2 = SE, 3 = SW, 4 = W, 5 = NW. Offset row offsets RIGHT.
    let nbrs;
    if (row % 2 === 0) {
      nbrs = [
        [row - 1, col    ], // NE
        [row,     col + 1], // E
        [row + 1, col    ], // SE
        [row + 1, col - 1], // SW
        [row,     col - 1], // W
        [row - 1, col - 1], // NW
      ];
    } else {
      nbrs = [
        [row - 1, col + 1], // NE
        [row,     col + 1], // E
        [row + 1, col + 1], // SE
        [row + 1, col    ], // SW
        [row,     col - 1], // W
        [row - 1, col    ], // NW
      ];
    }
    if (HEX_OUTLINE_AA) {
      hlCtx.beginPath();
      for (let i = 0; i < 6; i++) {
        const [nr, nc] = nbrs[i];
        if (hasHex(nr, nc)) continue;          // internal border — skip
        const a = verts[i], b = verts[(i + 1) % 6];
        hlCtx.moveTo(a[0], a[1]);
        hlCtx.lineTo(b[0], b[1]);
      }
      hlCtx.stroke();
    } else {
      for (let i = 0; i < 6; i++) {
        const [nr, nc] = nbrs[i];
        if (hasHex(nr, nc)) continue;
        const a = verts[i], b = verts[(i + 1) % 6];
        drawLineBresenham(a[0], a[1], b[0], b[1], thick, half);
      }
    }
  }
}

function renderSelection() {
  hlCtx.clearRect(0, 0, hlCanvas.width, hlCanvas.height);
  if (pathIds && pathIds.length > 0) {
    for (const sid of pathIds) {
      if (sid === fromId || sid === toId) continue;
      fillSubhex(SUBHEX_INDEX.get(sid), PATH_COLOR, PATH_ALPHA);
    }
  }
  if (fromId != null) fillSubhex(SUBHEX_INDEX.get(fromId), START_COLOR, START_ALPHA);
  if (toId   != null) fillSubhex(SUBHEX_INDEX.get(toId),   END_COLOR,   END_ALPHA);
  if (pathIds && pathIds.length > 1) drawPathLine();
  drawHexOutlines();
}

// =================== Pan/Zoom ===================
function applyView() {
  const t = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
  mapCanvas.style.transform = t;
  hlCanvas.style.transform = t;
  updateStatus();
}
function resetView() {
  const r = stage.getBoundingClientRect();
  const sx = r.width / HEX_DATA.image_width;
  const sy = r.height / HEX_DATA.image_height;
  view.scale = Math.min(sx, sy);
  view.x = (r.width - HEX_DATA.image_width * view.scale) / 2;
  view.y = (r.height - HEX_DATA.image_height * view.scale) / 2;
  applyView();
}
function zoomAt(clientX, clientY, factor) {
  const r = stage.getBoundingClientRect();
  const lx = clientX - r.left, ly = clientY - r.top;
  const ix = (lx - view.x) / view.scale;
  const iy = (ly - view.y) / view.scale;
  view.scale = Math.max(0.05, Math.min(8, view.scale * factor));
  view.x = lx - ix * view.scale;
  view.y = ly - iy * view.scale;
  applyView();
}
function stageToImage(clientX, clientY) {
  const r = stage.getBoundingClientRect();
  const ix = (clientX - r.left - view.x) / view.scale;
  const iy = (clientY - r.top  - view.y) / view.scale;
  if (ix < 0 || iy < 0 || ix >= HEX_DATA.image_width || iy >= HEX_DATA.image_height) return null;
  return { x: ix, y: iy };
}
function lookupSubhex(px, py) {
  if (!SUBHEX_ID_IMG_DATA) return 0;
  const W = SUBHEX_ID_IMG_DATA.width, H = SUBHEX_ID_IMG_DATA.height;
  if (px < 0 || py < 0 || px >= W || py >= H) return 0;
  const i = (py * W + px) * 4;
  const d = SUBHEX_ID_IMG_DATA.data;
  return d[i] | (d[i+1] << 8) | (d[i+2] << 16);
}

// =================== Interaction ===================
let panning = false, panStart = null, mouseDownPos = null;
stage.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  panning = true;
  panStart = { x: e.clientX - view.x, y: e.clientY - view.y };
  mouseDownPos = { x: e.clientX, y: e.clientY };
  stage.classList.add("panning");
});
window.addEventListener("mousemove", (e) => {
  if (panning) {
    view.x = e.clientX - panStart.x;
    view.y = e.clientY - panStart.y;
    applyView();
  }
});
window.addEventListener("mouseup", (e) => {
  if (!panning) return;
  panning = false;
  stage.classList.remove("panning");
  const moved = Math.hypot(e.clientX - mouseDownPos.x, e.clientY - mouseDownPos.y);
  if (moved < 4) handleClick(e);
});
stage.addEventListener("mousemove", (e) => {
  const ipt = stageToImage(e.clientX, e.clientY);
  if (ipt) {
    const hx = pointToHex(ipt.x, ipt.y);
    if (hx) {
      const sid = lookupSubhex(ipt.x | 0, ipt.y | 0);
      const sname = sid ? SUBHEX_INDEX.get(sid)?.name : null;
      const terrain = HEX_TERRAIN ? HEX_TERRAIN.get(hx.id) : null;
      const tw = (terrain && weights[terrain] != null) ? +weights[terrain] : null;
      const terrainStr = terrain ? `  ·  ${terrain}${isFinite(tw) ? ` (w ${tw})` : ""}` : "";
      tooltipEl.textContent = `${pad4(hx.id)}${terrainStr}${sname ? `  ·  ${sname}` : ""}`;
      const r = stage.getBoundingClientRect();
      tooltipEl.style.left = (e.clientX - r.left) + "px";
      tooltipEl.style.top  = (e.clientY - r.top)  + "px";
      tooltipEl.classList.remove("hidden");
      return;
    }
  }
  tooltipEl.classList.add("hidden");
});
stage.addEventListener("mouseleave", () => tooltipEl.classList.add("hidden"));
stage.addEventListener("wheel", (e) => {
  e.preventDefault();
  zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015));
}, { passive: false });

function handleClick(e) {
  const ipt = stageToImage(e.clientX, e.clientY);
  if (!ipt) return;
  const sid = lookupSubhex(ipt.x | 0, ipt.y | 0);
  if (!sid) return;
  if (fromId == null) {
    fromId = sid; toId = null; pathIds = null; pathSet = null; pathHexIds = null; pathSubhexIds = null;
  } else if (toId == null && sid !== fromId) {
    toId = sid;
    recomputePath();
  } else {
    fromId = sid; toId = null; pathIds = null; pathSet = null; pathHexIds = null; pathSubhexIds = null;
  }
  renderSelection(); updateEndpoints(); updatePathInfo(); updateStatus();
}

// =================== Init ===================
(async () => {
  buildLayerControls();
  buildWeightControls();
  buildColorControls();
  buildLineControls();
  updateEndpoints();
  try { await loadAll(); }
  catch (e) {
    loadingEl.textContent = "Failed to load: " + (e?.message || e);
    console.error(e);
    return;
  }
  renderLayers();
  resetView();
})();
