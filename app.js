"use strict";

// =================== Config ===================
const LAYERS = [
  { id: "sea",         file: "sea.png",                 label: "Sea fill",               on: true,  opacity: 1.00, hidden: true },
  { id: "continent",   file: "Continent Meat.png",      label: "Outline",                on: true,  opacity: 1.00 },
  { id: "terrain",     file: "Terrain.png",             label: "Terrain",                on: true,  opacity: 1.00 },
  { id: "core",        file: "core commanderies.png",      label: "Core commanderies",      on: false, opacity: 1.00 },
  { id: "frontier",    file: "frontier commanderies.png",  label: "Frontier commanderies",  on: false, opacity: 1.00 },
  { id: "provinces",   file: "provinces commanderies.png", label: "Province commanderies",  on: false, opacity: 1.00 },
  { id: "rivers",      file: "rivers.png",              label: "Rivers",                 on: true,  opacity: 1.00 },
  { id: "roads",       file: "Roads.png",               label: "Roads",                  on: true,  opacity: 1.00 },
  { id: "ctf",         file: "citiestownsforts.png",    label: "Cities / towns / forts", on: true,  opacity: 1.00 },
  { id: "simple",      file: "simple grid.png",         label: "Hex grid",               on: false, opacity: 0.40 },
  { id: "base",        file: "Ravages_ver_6.3_hex.png", label: "Hex ID map",             on: false, opacity: 1.00 },
];
const CLASSES = ["Flatlands", "Plains", "Woodland", "Hills", "Mountains", "Peaks", "Lake", "Sea", "Ocean", "Embark"];
const DEFAULT_WEIGHTS = {
  "Flatlands": 1, "Plains": 1, "Woodland": 2,
  "Hills": 2, "Mountains": 5, "Peaks": 8,
  // Water hex traversal weights (used directly when sailing water->water).
  // Sailing is faster than overland, so lakes and seas are cheap; ocean
  // is the slowest water but still cheaper than rough land.
  "Lake": 0.5, "Sea": 0.5, "Ocean": 1,
  // Embark — land <-> water boundary crossing (loading or unloading a ship).
  "Embark": 3,
};
// Road column of the traversal-weight matrix. When the destination hex has the
// "Road" flag set in the sheet, we use THIS table's value for the terrain
// instead of the default column — i.e., roads shave weight off a hex's
// inherent terrain cost. Embark/disembark and water-to-water still use the
// default column (a road doesn't help you load a ship or sail faster).
const DEFAULT_ROAD_WEIGHTS = {
  "Flatlands": 0.5, "Plains": 0.5, "Woodland": 1,
  "Hills": 1, "Mountains": 2, "Peaks": 4,
  // Water and embark mirror the default column (roads don't help shipping).
  "Lake": 0.5, "Sea": 0.5, "Ocean": 1,
  "Embark": 3,
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
// Debug: when on, the binary mask routeThroughMask actually fed to A* is
// painted over hl-canvas as a translucent magenta overlay so you can see
// exactly which pixels are passable (and which got restricted away).
let DEBUG_SHOW_MASK = false;
let _lastRouteMask = null;   // { mask: Uint8Array, mw, mh, bx0, by0 } from the most recent routeThroughMask
let ISOCHRONE_MODE = false;
let ISOCHRONE_BUDGET = 10;
let ISOCHRONE_COLOR = [120, 220, 255], ISOCHRONE_ALPHA = 110;
let isochroneSourceId = null;        // clicked subhex id
let isochroneHexIds = null;          // Set of hex ids reachable within budget
let isochroneSubhexIds = null;       // Set of subhex ids for the mask fill

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
const isoEl       = document.getElementById("isochrone");
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
let roadWeights = Object.assign({}, DEFAULT_ROAD_WEIGHTS);
// Binary masks over the full map image. Built once after layers load.
// ROAD_PIXEL_MASK  = roads.png ∪ citiestownsforts.png — used for the per-hex
//                    road restriction.
// RIVER_PIXEL_MASK = rivers.png alone — merged in with the road mask for
//                    hexes flagged as BOTH road AND river, so the restriction
//                    in a road+river hex follows either the road or the river.
let ROAD_PIXEL_MASK = null;
let RIVER_PIXEL_MASK = null;
// Pre-decoded per-pixel index buffers, populated once at load. They turn the
// inner routing loop's per-pixel cost from "4 byte reads + bit-ops + a Map
// lookup" into a single typed-array read.
//   SUBHEX_ID_PX[fullIdx]  = subhex id at that pixel
//   HEX_ID_PX[fullIdx]     = its containing hex id (0 if outside any hex)
// Memory: ~35 MB + ~17 MB respectively for the 4400×2037 board.
let SUBHEX_ID_PX = null;
let HEX_ID_PX = null;
// Pre-computed set of hex ids that contain at least one road pixel. Replaces
// the per-call hexHasRoadPixels bbox scan with O(1) membership.
let HEX_HAS_ROAD = null;
// Per-hex pixel lists in FULL-IMAGE coordinates. Let routeThroughMask skip
// the per-route bbox scan entirely — we iterate only the pixels that belong
// to relevant hexes, not the whole bbox (which on a long route can be 5-10×
// the relevant-pixel area). All three are Map<hex_id, Uint32Array>.
//   HEX_PIXELS       — every pixel of the hex
//   HEX_ROAD_PIXELS  — pixels of the hex that are road pixels
//   HEX_RIVER_PIXELS — pixels of the hex that are river pixels
let HEX_PIXELS = null;
let HEX_ROAD_PIXELS = null;
let HEX_RIVER_PIXELS = null;
// For each hex whose CSV terrain is land but whose pixels include Ocean/Sea/
// Lake subhexes, the full-image pixel indices of those water subhexes.
// routeThroughMask attempts to clear these pixels from the mask; if doing so
// keeps From->To reachable, the exclusion sticks; otherwise the hex's water
// pixels are restored and the hex is added to skipHexes.
let LAND_HEX_WATER_PIXELS = null;
let fromId = null, toId = null;
// Exact click pixels for From / To. These are what the path line actually
// starts / ends at — the subhex id is still tracked because it controls cost,
// the route mask, and the From/To highlight, but the visual road runs to the
// pixel the user actually clicked rather than the subhex centroid.
let fromPx = null, toPx = null;
let pathIds = null, pathSet = null;
let pathHexIds = null;          // ordered hex ids on the path
let pathSubhexIds = null;        // Set of subhex ids included in the drawing mask
let HEX_TERRAIN = null;          // Map<hex_id, terrain_string>
let HEX_STRONGHOLD = null;       // Map<hex_id, bool>
let HEX_RIVER = null;            // Map<hex_id, bool>
let HEX_ROAD = null;             // Map<hex_id, bool>
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

// Recognize a CSV cell as a "yes" flag. Tolerates "yes"/"y"/"true"/"1"/"x"
// (case-insensitive). Empty cells and any other value are false.
function isYes(v) {
  if (v == null) return false;
  const s = String(v).trim().toLowerCase();
  return s === "yes" || s === "y" || s === "true" || s === "1" || s === "x";
}

// Fetch the public spreadsheet CSV and parse all per-hex columns we care about:
// Terrain (main terrain type, used for movement cost) plus the yes/no flag
// columns Stronghold / River / Road. Populates HEX_TERRAIN and the three
// HEX_<flag> module globals. Returns HEX_TERRAIN for the loader's convenience.
async function loadHexTerrains() {
  HEX_STRONGHOLD = new Map();
  HEX_RIVER = new Map();
  HEX_ROAD = new Map();
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
    // Optional flag columns — find by header name; missing column => all false.
    const iStronghold = header.findIndex(h => /stronghold|fort|castle/i.test(h));
    const iRiver      = header.findIndex(h => /river/i.test(h));
    const iRoad       = header.findIndex(h => /road/i.test(h));
    const out = new Map();
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row.length === 0) continue;
      const id = parseInt(row[iId], 10);
      if (!Number.isFinite(id)) continue;
      const terrain = (row[iTerrain] || "").trim();
      if (terrain) out.set(id, terrain);
      if (iStronghold >= 0 && isYes(row[iStronghold])) HEX_STRONGHOLD.set(id, true);
      if (iRiver      >= 0 && isYes(row[iRiver]))      HEX_RIVER.set(id, true);
      if (iRoad       >= 0 && isYes(row[iRoad]))       HEX_ROAD.set(id, true);
    }
    console.log(`Loaded ${out.size} hex terrain entries from sheet `
      + `(${HEX_STRONGHOLD.size} strongholds, ${HEX_RIVER.size} rivers, ${HEX_ROAD.size} roads).`);
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
  loadingEl.textContent = "Indexing pixels…";
  precomputeHexIndexes();
  precomputeLandHexWaterPixels();
  loadingEl.textContent = "Loading map layers…";
  await Promise.all(LAYERS.map(async (l) => {
    try { IMAGES[l.id] = await loadImage(encodeURI(l.file)); }
    catch (e) { console.warn("Layer load failed:", l.id, e); IMAGES[l.id] = null; }
  }));
  for (const c of [mapCanvas, hlCanvas]) {
    c.width = HEX_DATA.image_width; c.height = HEX_DATA.image_height;
  }
  buildPixelMasks();
  precomputeHexRoadRiverPixels();
  loadingEl.classList.add("hidden");
}

// Rasterize a list of map layers into a single binary mask. A pixel counts
// as set if it has meaningful alpha (cutoff 32/255 catches anti-aliased
// edges) in ANY of the source layers — i.e. the layers are OR'd together.
// Returns null if none of the layers loaded.
function buildBinaryMaskFromLayers(layerIds) {
  const sources = layerIds.map(id => IMAGES[id]).filter(Boolean);
  if (sources.length === 0) return null;
  const W = sources[0].naturalWidth, H = sources[0].naturalHeight;
  const mask = new Uint8Array(W * H);
  for (const img of sources) {
    const c = document.createElement("canvas");
    c.width = W; c.height = H;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const px = ctx.getImageData(0, 0, W, H).data;
    for (let i = 0, j = 0; i < mask.length; i++, j += 4) {
      if (px[j + 3] > 32) mask[i] = 1;
    }
  }
  return mask;
}

// Build both pixel masks used by the per-hex routing restriction.
// Cities/towns/forts are unioned into the road mask only here (so streets
// through a town still count as road); the Layers panel toggles them
// separately. Rivers stay in their own mask so they're only mixed in for
// hexes flagged as BOTH road AND river.
function buildPixelMasks() {
  ROAD_PIXEL_MASK  = buildBinaryMaskFromLayers(["roads", "ctf"]);
  RIVER_PIXEL_MASK = buildBinaryMaskFromLayers(["rivers"]);
}

// Pre-decode the RGBA subhex-id image into flat typed arrays, then group
// pixels by their containing hex. Three things come out of this pass:
//   SUBHEX_ID_PX[i] = subhex id at pixel i           (Uint32)
//   HEX_ID_PX[i]    = hex id at pixel i, 0 if none   (Uint16)
//   HEX_PIXELS[hid] = Uint32Array of pixel indices for hex hid
// Lets the routing inner loop read pixel→subhex/hex in one typed-array hit
// AND iterate only the pixels that belong to relevant hexes (skipping the
// bbox-scan altogether for long routes).
function precomputeHexIndexes() {
  if (!SUBHEX_ID_IMG_DATA || !SUBHEX_INDEX) return;
  const W = SUBHEX_ID_IMG_DATA.width, H = SUBHEX_ID_IMG_DATA.height;
  const N = W * H;
  const data = SUBHEX_ID_IMG_DATA.data;
  SUBHEX_ID_PX = new Uint32Array(N);
  HEX_ID_PX = new Uint16Array(N);
  // Pass 1: decode subhex/hex ids, count pixels per hex.
  const maxHex = (HEX_DATA && HEX_DATA.rows)
    ? (HEX_DATA.rows.length * HEX_DATA.cols_per_row + 1)
    : 65536;
  const counts = new Int32Array(maxHex);
  for (let i = 0, j = 0; i < N; i++, j += 4) {
    const sid = data[j] | (data[j+1] << 8) | (data[j+2] << 16);
    SUBHEX_ID_PX[i] = sid;
    const sub = SUBHEX_INDEX.get(sid);
    if (sub) {
      HEX_ID_PX[i] = sub.hex;
      counts[sub.hex]++;
    }
  }
  // Pass 2: allocate per-hex pixel arrays, fill them in image-scan order.
  HEX_PIXELS = new Map();
  for (let hid = 1; hid < maxHex; hid++) {
    if (counts[hid] > 0) HEX_PIXELS.set(hid, new Uint32Array(counts[hid]));
  }
  const fillIdx = new Int32Array(maxHex);
  for (let i = 0; i < N; i++) {
    const hid = HEX_ID_PX[i];
    if (!hid) continue;
    HEX_PIXELS.get(hid)[fillIdx[hid]++] = i;
  }
}

// For every hex whose CSV terrain is land, walk its precomputed pixel list
// and pull out the pixels whose subhex class is Ocean/Sea/Lake. The result
// (LAND_HEX_WATER_PIXELS[hex_id]) lets routeThroughMask quickly attempt a
// water-exclusion-per-hex without re-scanning pixels at route time.
function precomputeLandHexWaterPixels() {
  LAND_HEX_WATER_PIXELS = new Map();
  if (!HEX_TERRAIN || !HEX_PIXELS || !SUBHEX_ID_PX || !SUBHEX_INDEX) return;
  for (const [hid, terrain] of HEX_TERRAIN) {
    if (!terrain || WATER_TERRAINS.has(terrain)) continue;
    const pixels = HEX_PIXELS.get(hid);
    if (!pixels) continue;
    const waterIdxs = [];
    for (let i = 0; i < pixels.length; i++) {
      const fullIdx = pixels[i];
      const sub = SUBHEX_INDEX.get(SUBHEX_ID_PX[fullIdx]);
      if (sub && WATER_TERRAINS.has(sub.class)) waterIdxs.push(fullIdx);
    }
    if (waterIdxs.length > 0) LAND_HEX_WATER_PIXELS.set(hid, new Uint32Array(waterIdxs));
  }
}

// Walk each hex's pixel list once and split out the road / river pixels.
// Also populates HEX_HAS_ROAD as a side effect — it's just "hexes with a
// non-empty HEX_ROAD_PIXELS entry", so we set both in the same loop.
function precomputeHexRoadRiverPixels() {
  HEX_ROAD_PIXELS = new Map();
  HEX_RIVER_PIXELS = new Map();
  HEX_HAS_ROAD = new Set();
  if (!HEX_PIXELS) return;
  for (const [hid, pixels] of HEX_PIXELS) {
    let roadCount = 0, riverCount = 0;
    // Count first, then allocate exactly — avoids growing temporaries.
    if (ROAD_PIXEL_MASK) {
      for (let i = 0; i < pixels.length; i++) if (ROAD_PIXEL_MASK[pixels[i]]) roadCount++;
    }
    if (RIVER_PIXEL_MASK) {
      for (let i = 0; i < pixels.length; i++) if (RIVER_PIXEL_MASK[pixels[i]]) riverCount++;
    }
    if (roadCount > 0) {
      const arr = new Uint32Array(roadCount);
      let k = 0;
      for (let i = 0; i < pixels.length; i++) if (ROAD_PIXEL_MASK[pixels[i]]) arr[k++] = pixels[i];
      HEX_ROAD_PIXELS.set(hid, arr);
      HEX_HAS_ROAD.add(hid);
    }
    if (riverCount > 0) {
      const arr = new Uint32Array(riverCount);
      let k = 0;
      for (let i = 0; i < pixels.length; i++) if (RIVER_PIXEL_MASK[pixels[i]]) arr[k++] = pixels[i];
      HEX_RIVER_PIXELS.set(hid, arr);
    }
  }
}

// O(1) lookup backed by the precomputed HEX_HAS_ROAD set. Returns false if
// the precompute hasn't run yet (defensive — shouldn't happen post-load).
function hexHasRoadPixels(hid) {
  return HEX_HAS_ROAD ? HEX_HAS_ROAD.has(hid) : false;
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


// =================== Isochrone (reachability) ===================
// Dijkstra outward from the source hex using the same edge-cost model as the
// path finder, but stopped at ISOCHRONE_BUDGET. Result: the set of reachable
// hexes (and the subhexes inside them) within that budget.
function computeIsochrone() {
  isochroneHexIds = null; isochroneSubhexIds = null;
  if (isochroneSourceId == null) return;
  const sub = SUBHEX_INDEX.get(isochroneSourceId);
  if (!sub) return;
  const srcHex = sub.hex;
  const dist = new Map();
  dist.set(srcHex, 0);
  const heap = new MinHeap();
  heap.push([0, srcHex]);
  const reached = new Set([srcHex]);
  while (heap.size() > 0) {
    const [d, u] = heap.pop();
    if (d > (dist.get(u) ?? Infinity)) continue;
    const uTerrain = HEX_TERRAIN ? HEX_TERRAIN.get(u) : null;
    const uIsWater = uTerrain ? WATER_TERRAINS.has(uTerrain) : false;
    for (const v of hexNeighbors(u)) {
      const vTerrain = HEX_TERRAIN ? HEX_TERRAIN.get(v) : null;
      if (!vTerrain) continue;
      const vIsWater = WATER_TERRAINS.has(vTerrain);
      const vHasRoad = HEX_ROAD && HEX_ROAD.get(v);
      const w = (uIsWater !== vIsWater)
        ? (+weights["Embark"])
        : (+(vHasRoad ? roadWeights : weights)[vTerrain]);
      if (!isFinite(w) || w <= 0) continue;
      const nd = d + w;
      if (nd > ISOCHRONE_BUDGET) continue;
      if (nd < (dist.get(v) ?? Infinity)) {
        dist.set(v, nd);
        reached.add(v);
        heap.push([nd, v]);
      }
    }
  }
  isochroneHexIds = reached;
  const subSet = new Set();
  for (const hid of reached) {
    for (const s of (SUBHEXES_BY_HEX.get(hid) || [])) subSet.add(s.id);
  }
  isochroneSubhexIds = subSet;
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
      const vHasRoad = HEX_ROAD && HEX_ROAD.get(v);
      // Edge cost depends on which side(s) of shore we're on.
      // Water->water uses the destination water hex's own weight (Lake/Sea/Ocean).
      // Land<->water pays the Embark/disembark cost. Land->land pays terrain,
      // pulling from the ROAD column of the weight matrix when v is flagged as
      // a Road hex — i.e., the road shaves some weight off the inherent terrain.
      let w;
      if (uIsWater !== vIsWater)       w = +weights["Embark"];
      else                             w = +(vHasRoad ? roadWeights : weights)[vTerrain];
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
// the From pixel to the To pixel through it. Each Road-flagged hex on the
// path is then evaluated INDIVIDUALLY: we RESTRICT that hex's passable area
// down to its road/city pixels (so A* can only cross the hex by walking the
// painted road), and keep the restriction only if From can still reach To.
// A bad/disconnected road hex falls back to its full mask while the other
// road hexes still snap to the road — so the rendered path follows the
// painted road wherever the road is contiguous from edge to edge.
function routeThroughMask(subSet) {
  const sStart = SUBHEX_INDEX.get(fromId), sEnd = SUBHEX_INDEX.get(toId);
  if (!sStart || !sEnd) return [];
  if (fromId === toId) {
    const p = fromPx || { x: sStart.centroid[0], y: sStart.centroid[1] };
    return [{ x: p.x, y: p.y }];
  }
  // Road hexes on the path, PLUS *every* hex directly adjacent to a path
  // road hex — REGARDLESS of whether the neighbor is itself flagged Road
  // in the sheet. Some hexes have bits of painted road bleeding through
  // them without earning the Road flag; by sweeping every neighbor into
  // the restriction loop we catch those stray road pixels. Neighbors with
  // no road pixels at all are made impassable by the restriction (their
  // mask gets cleared and there's nothing to re-set) — which is fine,
  // because A* never *had* to traverse them and revert-on-fail still
  // saves any hex whose absence would actually break From->To.
  const pathRoadSet = new Set();
  if (pathHexIds && HEX_ROAD) {
    for (const hid of pathHexIds) if (HEX_ROAD.get(hid)) pathRoadSet.add(hid);
  }
  // mergedHexes = path hexes whose restriction set is roads ∪ rivers. Covers
  // two cases:
  //   (a) hex is flagged BOTH road AND river in the sheet, OR
  //   (b) hex is flagged river AND has any road pixels painted through it
  //       (even without the Road flag) — caught visually by scanning the hex's
  //       subhex bboxes against ROAD_PIXEL_MASK. (b) lets us treat river
  //       crossings that incidentally have a road overlay as road+river even
  //       when the spreadsheet hasn't been updated.
  const mergedHexes = new Set();
  if (HEX_RIVER && RIVER_PIXEL_MASK && pathHexIds) {
    for (const hid of pathHexIds) {
      if (!HEX_RIVER.get(hid)) continue;
      if (pathRoadSet.has(hid) || hexHasRoadPixels(hid)) mergedHexes.add(hid);
    }
  }
  // Hexes that get restricted (road-flagged path hexes + merged hexes that
  // aren't road-flagged). Adjacents expand from this combined set.
  const restrictPathHexes = new Set([...pathRoadSet, ...mergedHexes]);
  const adjAnyHexes = new Set();
  for (const hid of restrictPathHexes) {
    for (const nb of hexNeighbors(hid)) {
      if (!restrictPathHexes.has(nb)) adjAnyHexes.add(nb);
    }
  }
  const roadHexList = [...restrictPathHexes, ...adjAnyHexes];

  const W = SUBHEX_ID_IMG_DATA.width, H = SUBHEX_ID_IMG_DATA.height;
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  const grow = (s) => {
    if (s.bbox[0] < bx0) bx0 = s.bbox[0];
    if (s.bbox[1] < by0) by0 = s.bbox[1];
    if (s.bbox[2] > bx1) bx1 = s.bbox[2];
    if (s.bbox[3] > by1) by1 = s.bbox[3];
  };
  for (const sid of subSet) {
    const s = SUBHEX_INDEX.get(sid);
    if (s) grow(s);
  }
  // Bbox must cover every subhex of every road hex so XOR can reach road
  // pixels that fall in subhexes filtered out of subSet (e.g., Peaks subhexes
  // of a Mountains road hex).
  for (const hid of roadHexList) {
    for (const s of (SUBHEXES_BY_HEX.get(hid) || [])) grow(s);
  }
  if (!isFinite(bx0)) return [];
  bx0 = Math.max(0, bx0 - 1); by0 = Math.max(0, by0 - 1);
  bx1 = Math.min(W - 1, bx1 + 1); by1 = Math.min(H - 1, by1 + 1);
  const mw = bx1 - bx0 + 1, mh = by1 - by0 + 1;

  // Build the standard mask. Also collect, per road hex, the mask-local indices
  // of (a) every pixel that belongs to the hex and (b) just the road pixels
  // within the hex. We use these below to RESTRICT each road hex's passable
  // area down to the painted road, so A* must follow the road through that
  // hex instead of cutting through open terrain alongside it.
  //
  // For the passable check we use an EXTENDED set that adds every subhex of
  // every adjacent road hex on top of the caller's subSet — subhexes of the
  // adj road hexes aren't in subSet (those hexes aren't on the hex path) but
  // we still want their pixels to be passable so A* can route through them.
  const extSubSet = adjAnyHexes.size > 0 ? new Set(subSet) : subSet;
  if (extSubSet !== subSet) {
    for (const hid of adjAnyHexes) {
      for (const s of (SUBHEXES_BY_HEX.get(hid) || [])) extSubSet.add(s.id);
    }
  }
  const mask = new Uint8Array(mw * mh);
  // Parallel "path-only" mask: same shape as `mask` but only flips on for
  // pixels in subSet (the caller's path-hex subhexes), not the broadened
  // extSubSet. Water exclusion below uses THIS mask for its contiguity
  // check, so the question becomes "can From still reach To through the
  // PATH hexes alone after removing this hex's water?" — neighbors only
  // come into play AFTER water exclusion, for the road-restriction step.
  const pathOnlyMask = new Uint8Array(mw * mh);
  const hexPxByHex  = new Map();   // hex_id -> all mask indices belonging to the hex
  const roadPxByHex = new Map();   // hex_id -> subset of those that are road pixels
  for (const hid of roadHexList) { hexPxByHex.set(hid, []); roadPxByHex.set(hid, []); }
  // Pull typed-array references into locals so the JIT doesn't re-resolve.
  const subhexPx = SUBHEX_ID_PX;
  // Iterate ONLY the pixels of the hexes that matter for the route — path
  // hexes (for mask building from subSet) and adj hexes (whose subhexes
  // are added to extSubSet). HEX_PIXELS gives the full pixel list per hex
  // in image-scan order. This replaces a full bbox scan (which on long
  // routes can be 5-10× the relevant-pixel area).
  const relevantHexes = new Set(adjAnyHexes);
  if (pathHexIds) for (const hid of pathHexIds) relevantHexes.add(hid);
  for (const hid of relevantHexes) {
    const pixels = HEX_PIXELS ? HEX_PIXELS.get(hid) : null;
    if (!pixels) continue;
    const isRoadHex = hexPxByHex.has(hid);
    const allList   = isRoadHex ? hexPxByHex.get(hid)  : null;
    for (let pi = 0; pi < pixels.length; pi++) {
      const fullIdx = pixels[pi];
      const fullY = (fullIdx / W) | 0;
      const fullX = fullIdx - fullY * W;
      if (fullX < bx0 || fullX > bx1 || fullY < by0 || fullY > by1) continue;
      const idx = (fullY - by0) * mw + (fullX - bx0);
      const sidHere = subhexPx[fullIdx];
      if (extSubSet.has(sidHere))   mask[idx]         = 1;
      if (subSet.has(sidHere))      pathOnlyMask[idx] = 1;
      if (isRoadHex) allList.push(idx);
    }
    // Populate the "restricted-to" set from the precomputed per-hex pixel
    // lists. Road pixels always count; river pixels only count when the
    // hex is in mergedHexes (road+river, or river with road pixels through it).
    if (isRoadHex) {
      const roadList = roadPxByHex.get(hid);
      const roadSrc = HEX_ROAD_PIXELS ? HEX_ROAD_PIXELS.get(hid) : null;
      if (roadSrc) {
        for (let pi = 0; pi < roadSrc.length; pi++) {
          const fullIdx = roadSrc[pi];
          const fullY = (fullIdx / W) | 0;
          const fullX = fullIdx - fullY * W;
          if (fullX < bx0 || fullX > bx1 || fullY < by0 || fullY > by1) continue;
          roadList.push((fullY - by0) * mw + (fullX - bx0));
        }
      }
      if (mergedHexes.has(hid)) {
        const riverSrc = HEX_RIVER_PIXELS ? HEX_RIVER_PIXELS.get(hid) : null;
        if (riverSrc) {
          for (let pi = 0; pi < riverSrc.length; pi++) {
            const fullIdx = riverSrc[pi];
            const fullY = (fullIdx / W) | 0;
            const fullX = fullIdx - fullY * W;
            if (fullX < bx0 || fullX > bx1 || fullY < by0 || fullY > by1) continue;
            roadList.push((fullY - by0) * mw + (fullX - bx0));
          }
        }
      }
    }
  }

  const startPt = fromPx ? { x: fromPx.x, y: fromPx.y } : { x: sStart.centroid[0], y: sStart.centroid[1] };
  const endPt   = toPx   ? { x: toPx.x,   y: toPx.y   } : { x: sEnd.centroid[0],   y: sEnd.centroid[1]   };

  // For each road hex IN roadHexList (path road hexes AND adjacent road
  // hexes — both kinds get restricted): tentatively RESTRICT the mask within
  // that hex to just the road/city pixels (clear everything else in the hex,
  // re-set only the road pixels). Verify From->To still reaches. Keep on
  // success, revert on failure. Each hex is decided on its own; a road hex
  // whose road doesn't actually span the hex falls back to its full mask
  // and the other road hexes still take effect.
  //
  // EXCEPTIONS to restriction:
  //  - The From and To hexes — if restricted, snapToMask would jump the click
  //    pixel straight to the nearest road pixel and produce a sharp diagonal.
  //    Leaving them unrestricted lets A* find the shortest pixel route from
  //    the click through allowed subhexes to the road's hex-border entry
  //    (the next hex IS restricted, so A* still has to enter it on a road
  //    pixel) — a smooth optimal connection.
  //  - Path hexes flagged as River BUT NOT Road — restricting to the road
  //    can produce a weird detour around the ford, and there's no road to
  //    restrict to anyway. Better to let A* route freely through the full
  //    hex mask there. Scoped to MAIN-PATH hexes only (pathHexIds), NOT
  //    adjacent road hexes — those still get restricted even if they're
  //    rivers (off-path "courtesy" additions shouldn't swell open terrain).
  //  - Road+river path hexes: NOT skipped — we DO restrict them, but the
  //    restriction set is roads ∪ rivers (see mergedHexes below), so A*
  //    can follow either the painted road or the river through the hex.
  const skipHexes = new Set();
  if (sStart) skipHexes.add(sStart.hex);
  if (sEnd)   skipHexes.add(sEnd.hex);
  if (HEX_RIVER && pathHexIds) {
    for (const hid of pathHexIds) {
      // Skip only river path hexes that AREN'T being merged-restricted —
      // i.e. true river-only hexes with no road pixels at all. Hexes in
      // mergedHexes (road+river by flag, or river with road pixels) go
      // through the restriction loop normally.
      if (HEX_RIVER.get(hid) && !mergedHexes.has(hid)) skipHexes.add(hid);
    }
  }

  // Water-subhex exclusion pass. For each path hex marked as LAND in the
  // sheet that contains Ocean/Sea/Lake-class subhexes, tentatively clear
  // those subhex pixels from BOTH the main mask AND the path-only mask,
  // then check connectivity on the path-only mask (so the question is
  // "is From still reachable through path hexes alone?"). If yes, keep
  // the exclusion in both. If the mask becomes non-contiguous WITHOUT
  // help from adjacent neighbors, restore the hex's water pixels in both
  // masks AND add the hex to skipHexes so the road-restriction loop below
  // doesn't re-clear them. The skipHexes add applies to every such hex,
  // including road+river ones — "restore the entire hex".
  if (LAND_HEX_WATER_PIXELS && pathHexIds) {
    for (const hid of pathHexIds) {
      if (skipHexes.has(hid)) continue;
      const waterPixels = LAND_HEX_WATER_PIXELS.get(hid);
      if (!waterPixels || waterPixels.length === 0) continue;
      const maskIdxs = [];
      const savedFull = [];
      const savedPath = [];
      for (let pi = 0; pi < waterPixels.length; pi++) {
        const fullIdx = waterPixels[pi];
        const fullY = (fullIdx / W) | 0;
        const fullX = fullIdx - fullY * W;
        if (fullX < bx0 || fullX > bx1 || fullY < by0 || fullY > by1) continue;
        const idx = (fullY - by0) * mw + (fullX - bx0);
        maskIdxs.push(idx);
        savedFull.push(mask[idx]);
        savedPath.push(pathOnlyMask[idx]);
        mask[idx]         = 0;
        pathOnlyMask[idx] = 0;
      }
      if (maskIdxs.length === 0) continue;
      if (!maskHasRoute(pathOnlyMask, mw, mh, bx0, by0, startPt, endPt)) {
        for (let i = 0; i < maskIdxs.length; i++) {
          mask[maskIdxs[i]]         = savedFull[i];
          pathOnlyMask[maskIdxs[i]] = savedPath[i];
        }
        skipHexes.add(hid);
      }
    }
  }

  // Restriction is applied in TWO passes so the path-hex acceptance check
  // sees the actual final-mask state, not a still-broadened version:
  //   Pass 1 — adjacent hexes: tentatively restrict to road pixels (or kill
  //            entirely if no road pixels). Check on the full mask, since
  //            adjacents only existed in the mask via broadening anyway —
  //            their disappearance can legitimately break the route and we
  //            need revert-on-fail for that.
  //   Pass 2 — path hexes that earned road restriction (pathRoadSet ∪
  //            mergedHexes): tentatively restrict, then check on the full
  //            mask AFTER Pass 1 has already removed adjacent broadening.
  //            So the route now has to flow through path hexes and the
  //            adjacents' road pixels — i.e. the real route network.
  //            A restriction that would split THAT mask reverts.
  const restrict = (hid) => {
    const allPx  = hexPxByHex.get(hid)  || [];
    const roadPx = roadPxByHex.get(hid) || [];
    if (allPx.length === 0) return;
    const saved = new Uint8Array(allPx.length);
    for (let i = 0; i < allPx.length; i++) {
      saved[i] = mask[allPx[i]];
      mask[allPx[i]] = 0;
    }
    for (const i of roadPx) mask[i] = 1;
    if (!maskHasRoute(mask, mw, mh, bx0, by0, startPt, endPt)) {
      for (let i = 0; i < allPx.length; i++) mask[allPx[i]] = saved[i];
    }
  };
  for (const hid of adjAnyHexes)       { if (!skipHexes.has(hid)) restrict(hid); }
  for (const hid of restrictPathHexes) { if (!skipHexes.has(hid)) restrict(hid); }

  // Stash the final mask for the debug overlay so the next render can paint
  // exactly what A* saw.
  _lastRouteMask = { mask, mw, mh, bx0, by0 };
  return routeInBinaryMask(mask, mw, mh, bx0, by0, startPt, endPt) || [];
}

// Cheap contiguity check: snap From and To into the mask and run BFS. Returns
// true iff a route exists. Used by the per-hex restriction acceptance loop —
// BFS (no heap, no heuristic) is enough for a yes/no reachability question,
// and the scratch buffers below are reused across calls so we don't pay
// allocation cost on every restriction.
function maskHasRoute(mask, mw, mh, bx0, by0, startPt, endPt) {
  const sX = snapToMask(mask, mw, mh, Math.round(startPt.x - bx0), Math.round(startPt.y - by0));
  const eX = snapToMask(mask, mw, mh, Math.round(endPt.x   - bx0), Math.round(endPt.y   - by0));
  if (!sX || !eX) return false;
  return maskBfsReachable(mask, mw, mh, sX[0], sX[1], eX[0], eX[1]);
}

// Reusable scratch buffers for maskBfsReachable. Re-allocated only when the
// mask grows beyond the previous capacity; cleared via fill() per call.
let _bfsVisited = null, _bfsQueue = null;

// 8-connected BFS reachability test. Returns true iff (sx, sy) reaches
// (tx, ty) in `mask`. Diagonals require both orthogonal neighbors to be
// passable (no corner-cutting), matching aStarInMask's semantics.
function maskBfsReachable(mask, mw, mh, sx, sy, tx, ty) {
  if (sx < 0 || sx >= mw || sy < 0 || sy >= mh) return false;
  if (tx < 0 || tx >= mw || ty < 0 || ty >= mh) return false;
  const start = sy * mw + sx, goal = ty * mw + tx;
  if (!mask[start] || !mask[goal]) return false;
  const N = mw * mh;
  if (!_bfsVisited || _bfsVisited.length < N) {
    _bfsVisited = new Uint8Array(N);
    _bfsQueue   = new Int32Array(N);
  } else {
    _bfsVisited.fill(0, 0, N);
  }
  const visited = _bfsVisited, queue = _bfsQueue;
  let qHead = 0, qTail = 0;
  visited[start] = 1;
  queue[qTail++] = start;
  while (qHead < qTail) {
    const cur = queue[qHead++];
    if (cur === goal) return true;
    const cy = (cur / mw) | 0;
    const cx = cur - cy * mw;
    for (let dy = -1; dy <= 1; dy++) {
      const ny = cy + dy;
      if (ny < 0 || ny >= mh) continue;
      const nyMw = ny * mw;
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = cx + dx;
        if (nx < 0 || nx >= mw) continue;
        const ni = nyMw + nx;
        if (visited[ni] || !mask[ni]) continue;
        // No corner-cutting: both orthogonal neighbors must be passable.
        if (dx !== 0 && dy !== 0) {
          if (!mask[cy * mw + nx] || !mask[nyMw + cx]) continue;
        }
        visited[ni] = 1;
        queue[qTail++] = ni;
      }
    }
  }
  return false;
}

// A* in a binary mask + string-pull smoothing, returning the pixel polyline in
// FULL-IMAGE coordinates (or null if From/To aren't reachable in this mask).
function routeInBinaryMask(mask, mw, mh, bx0, by0, startPt, endPt) {
  const sX = snapToMask(mask, mw, mh, Math.round(startPt.x - bx0), Math.round(startPt.y - by0));
  const eX = snapToMask(mask, mw, mh, Math.round(endPt.x   - bx0), Math.round(endPt.y   - by0));
  if (!sX || !eX) return null;
  const rawPath = aStarInMask(mask, mw, mh, sX[0], sX[1], eX[0], eX[1]);
  if (!rawPath) return null;
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

function drawPathLine(pts) {
  pts = pts || buildPathLinePoints();
  if (!pts || pts.length < 2) return;
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
// Layer ids that should be drawn ABOVE the isochrone overlay. Anything in
// this set sits on top of the iso fill; everything not in it sits below.
// Result: iso fill is sandwiched between commanderies (below) and rivers
// (above), exactly as requested.
const LAYERS_ABOVE_ISO = new Set(["rivers", "roads", "ctf", "simple", "base"]);

function renderLayers() {
  mapCtx.clearRect(0, 0, mapCanvas.width, mapCanvas.height);
  let drewIso = false;
  for (const l of LAYERS) {
    // Insert the iso overlay JUST before the first "above" layer in the stack.
    if (!drewIso && LAYERS_ABOVE_ISO.has(l.id)) {
      drawIsoOnMap();
      drewIso = true;
    }
    if (!l.on || !IMAGES[l.id]) continue;
    mapCtx.globalAlpha = l.opacity;
    mapCtx.drawImage(IMAGES[l.id], 0, 0);
  }
  // If no "above" layers exist in LAYERS, draw iso at the top of the stack.
  if (!drewIso) drawIsoOnMap();
  mapCtx.globalAlpha = 1.0;
}

// Iso fill, rendered ONTO mapCtx (so it can sit between map layers, not above
// everything like hl-canvas content). One full-image pass through the subhex
// id buffer, painting iso color + alpha wherever the subhex id is reachable.
function drawIsoOnMap() {
  if (!ISOCHRONE_MODE || !isochroneSubhexIds || isochroneSubhexIds.size === 0) return;
  if (!SUBHEX_ID_IMG_DATA) return;
  const W = SUBHEX_ID_IMG_DATA.width, H = SUBHEX_ID_IMG_DATA.height;
  if (_isoCanvas.width !== W || _isoCanvas.height !== H) {
    _isoCanvas.width = W; _isoCanvas.height = H;
  } else {
    _isoCtx.clearRect(0, 0, W, H);
  }
  const img = _isoCtx.createImageData(W, H);
  const px = SUBHEX_ID_IMG_DATA.data;
  let oi = 0;
  for (let i = 0; i < W * H; i++) {
    const p = i * 4;
    const id = px[p] | (px[p+1] << 8) | (px[p+2] << 16);
    if (isochroneSubhexIds.has(id)) {
      img.data[oi]   = ISOCHRONE_COLOR[0]; img.data[oi+1] = ISOCHRONE_COLOR[1];
      img.data[oi+2] = ISOCHRONE_COLOR[2]; img.data[oi+3] = ISOCHRONE_ALPHA;
    }
    oi += 4;
  }
  _isoCtx.putImageData(img, 0, 0);
  mapCtx.globalAlpha = 1.0;
  mapCtx.drawImage(_isoCanvas, 0, 0);
}
const _scratchCanvas = document.createElement("canvas");
const _scratchCtx = _scratchCanvas.getContext("2d");
// Fill every pixel whose subhex id is in subSet with rgba(rgb, alpha).
// One full-image pass via a single offscreen canvas for efficiency.
const _isoCanvas = document.createElement("canvas");
const _isoCtx = _isoCanvas.getContext("2d");
// Scratch buffer for the debug route-mask overlay (sized per call to the
// bounding box of the last computed mask).
const _dbgMaskCanvas = document.createElement("canvas");
const _dbgMaskCtx = _dbgMaskCanvas.getContext("2d");

// Paint the binary mask the routing actually used onto hl-canvas, in
// translucent magenta. No-op when DEBUG_SHOW_MASK is off, no mask exists,
// or there is no active route to display — the mask should appear and
// disappear together with the path line, so it can't outlive the route.
function drawDebugMask() {
  if (!DEBUG_SHOW_MASK || !_lastRouteMask) return;
  if (!pathIds || pathIds.length < 2) return;
  const { mask, mw, mh, bx0, by0 } = _lastRouteMask;
  if (_dbgMaskCanvas.width !== mw || _dbgMaskCanvas.height !== mh) {
    _dbgMaskCanvas.width = mw; _dbgMaskCanvas.height = mh;
  } else {
    _dbgMaskCtx.clearRect(0, 0, mw, mh);
  }
  const img = _dbgMaskCtx.createImageData(mw, mh);
  // Bright magenta @ ~45% alpha — distinct from path/iso/terrain colors.
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const p = i * 4;
    img.data[p]     = 255;
    img.data[p + 1] = 0;
    img.data[p + 2] = 255;
    img.data[p + 3] = 115;
  }
  _dbgMaskCtx.putImageData(img, 0, 0);
  hlCtx.drawImage(_dbgMaskCanvas, bx0, by0);
}

function fillSubhexSet(subSet, rgb, alpha) {
  if (!subSet || subSet.size === 0 || !SUBHEX_ID_IMG_DATA) return;
  const W = SUBHEX_ID_IMG_DATA.width, H = SUBHEX_ID_IMG_DATA.height;
  if (_isoCanvas.width !== W || _isoCanvas.height !== H) {
    _isoCanvas.width = W; _isoCanvas.height = H;
  } else {
    _isoCtx.clearRect(0, 0, W, H);
  }
  const img = _isoCtx.createImageData(W, H);
  const px = SUBHEX_ID_IMG_DATA.data;
  let oi = 0;
  for (let i = 0; i < W * H; i++) {
    const p = i * 4;
    const id = px[p] | (px[p+1] << 8) | (px[p+2] << 16);
    if (subSet.has(id)) {
      img.data[oi]   = rgb[0]; img.data[oi+1] = rgb[1];
      img.data[oi+2] = rgb[2]; img.data[oi+3] = alpha;
    }
    oi += 4;
  }
  _isoCtx.putImageData(img, 0, 0);
  hlCtx.drawImage(_isoCanvas, 0, 0);
}

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
    return { hexes: 0, subhexes: 0, cost: 0, byTerrain: {}, strongholds: 0, rivers: 0, roads: 0 };
  }
  let cost = 0;
  const byTerrain = {};
  let embarks = 0;
  let strongholds = 0, rivers = 0, roads = 0;
  for (let i = 0; i < pathHexIds.length; i++) {
    const hid = pathHexIds[i];
    const terrain = HEX_TERRAIN ? HEX_TERRAIN.get(hid) : null;
    if (terrain) byTerrain[terrain] = (byTerrain[terrain] || 0) + 1;
    if (HEX_STRONGHOLD && HEX_STRONGHOLD.get(hid)) strongholds++;
    if (HEX_RIVER      && HEX_RIVER.get(hid))      rivers++;
    if (HEX_ROAD       && HEX_ROAD.get(hid))       roads++;
    if (i > 0 && terrain) {
      const prevTerrain = HEX_TERRAIN ? HEX_TERRAIN.get(pathHexIds[i - 1]) : null;
      const prevIsWater = prevTerrain ? WATER_TERRAINS.has(prevTerrain) : false;
      const curIsWater  = WATER_TERRAINS.has(terrain);
      const curHasRoad  = HEX_ROAD && HEX_ROAD.get(hid);
      let w;
      if (prevIsWater !== curIsWater) { w = +weights["Embark"]; embarks++; }
      else                             { w = +(curHasRoad ? roadWeights : weights)[terrain]; }
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
    cost, byTerrain, embarks,
    strongholds, rivers, roads,
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
  // NOTE: the reachability fill now lives on map-canvas (sandwiched between
  // commanderies and rivers in the layer stack), drawn by renderLayers via
  // drawIsoOnMap. Any code path that mutates iso state must call renderLayers
  // after renderSelection so the map-canvas overlay is kept in sync.
  if (pathIds && pathIds.length > 0) {
    for (const sid of pathIds) {
      if (sid === fromId || sid === toId) continue;
      fillSubhex(SUBHEX_INDEX.get(sid), PATH_COLOR, PATH_ALPHA);
    }
  }
  if (fromId != null) fillSubhex(SUBHEX_INDEX.get(fromId), START_COLOR, START_ALPHA);
  if (toId   != null) fillSubhex(SUBHEX_INDEX.get(toId),   END_COLOR,   END_ALPHA);
  // Build the line points first so _lastRouteMask is refreshed before the
  // debug overlay reads it; without that we'd paint the mask from the
  // previous render and the route line from the current one.
  const linePts = (pathIds && pathIds.length > 1) ? buildPathLinePoints() : null;
  if (linePts) drawPathLine(linePts);
  drawHexOutlines();
  // Debug overlay goes LAST so the magenta sits on top of everything else
  // on hl-canvas (path line + hex outlines) and you can see exactly what
  // pixels A* could traverse for the route currently displayed.
  drawDebugMask();
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
      // Per-hex yes/no flags from the spreadsheet.
      const flags = [];
      if (HEX_ROAD && HEX_ROAD.get(hx.id)) flags.push("Road");
      if (HEX_RIVER && HEX_RIVER.get(hx.id)) flags.push("River");
      if (HEX_STRONGHOLD && HEX_STRONGHOLD.get(hx.id)) flags.push("Stronghold");
      const flagsStr = flags.length ? `  ·  ${flags.join(", ")}` : "";
      tooltipEl.textContent = `${pad4(hx.id)}${terrainStr}${flagsStr}${sname ? `  ·  ${sname}` : ""}`;
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
  if (ISOCHRONE_MODE) {
    isochroneSourceId = sid;
    computeIsochrone();
    renderLayers(); renderSelection(); updateStatus();
    return;
  }
  const clickPx = { x: ipt.x, y: ipt.y };
  if (fromId == null) {
    fromId = sid; fromPx = clickPx;
    toId = null;  toPx   = null;
    pathIds = null; pathSet = null; pathHexIds = null; pathSubhexIds = null;
  } else if (toId == null && sid !== fromId) {
    toId = sid; toPx = clickPx;
    recomputePath();
  } else {
    fromId = sid; fromPx = clickPx;
    toId = null;  toPx   = null;
    pathIds = null; pathSet = null; pathHexIds = null; pathSubhexIds = null;
  }
  renderSelection(); updateEndpoints(); updatePathInfo(); updateStatus();
}

// =================== Init ===================
(async () => {
  buildLayerControls();
  buildWeightControls();
  buildColorControls();
  buildLineControls();
  buildIsochroneControls();
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

// === GARBAGE BELOW — DEAD CODE, IGNORE ===
/*
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
  // NOTE: the reachability fill now lives on map-canvas (sandwiched between
  // commanderies and rivers in the layer stack), drawn by renderLayers via
  // drawIsoOnMap. Any code path that mutates iso state must call renderLayers
  // after renderSelection so the map-canvas overlay is kept in sync.
  if (pathIds && pathIds.length > 0) {
    for (const sid of pathIds) {
      if (sid === fromId || sid === toId) continue;
      fillSubhex(SUBHEX_INDEX.get(sid), PATH_COLOR, PATH_ALPHA);
    }
  }
  if (fromId != null) fillSubhex(SUBHEX_INDEX.get(fromId), START_COLOR, START_ALPHA);
  if (toId   != null) fillSubhex(SUBHEX_INDEX.get(toId),   END_COLOR,   END_ALPHA);
  // Build the line points first so _lastRouteMask is refreshed before the
  // debug overlay reads it; without that we'd paint the mask from the
  // previous render and the route line from the current one.
  const linePts = (pathIds && pathIds.length > 1) ? buildPathLinePoints() : null;
  if (linePts) drawPathLine(linePts);
  drawHexOutlines();
  // Debug overlay goes LAST so the magenta sits on top of everything else
  // on hl-canvas (path line + hex outlines) and you can see exactly what
  // pixels A* could traverse for the route currently displayed.
  drawDebugMask();
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
      // Per-hex yes/no flags from the spreadsheet.
      const flags = [];
      if (HEX_ROAD && HEX_ROAD.get(hx.id)) flags.push("Road");
      if (HEX_RIVER && HEX_RIVER.get(hx.id)) flags.push("River");
      if (HEX_STRONGHOLD && HEX_STRONGHOLD.get(hx.id)) flags.push("Stronghold");
      const flagsStr = flags.length ? `  ·  ${flags.join(", ")}` : "";
      tooltipEl.textContent = `${pad4(hx.id)}${terrainStr}${flagsStr}${sname ? `  ·  ${sname}` : ""}`;
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
  if (ISOCHRONE_MODE) {
    isochroneSourceId = sid;
    computeIsochrone();
    renderLayers(); renderSelection(); updateStatus();
    return;
  }
  const clickPx = { x: ipt.x, y: ipt.y };
  if (fromId == null) {
    fromId = sid; fromPx = clickPx;
    toId = null;  toPx   = null;
    pathIds = null; pathSet = null; pathHexIds = null; pathSubhexIds = null;
  } else if (toId == null && sid !== fromId) {
    toId = sid; toPx = clickPx;
    recomputePath();
  } else {
    fromId = sid; fromPx = clickPx;
    toId = null;  toPx   = null;
    pathIds = null; pathSet = null; pathHexIds = null; pathSubhexIds = null;
  }
  renderSelection(); updateEndpoints(); updatePathInfo(); updateStatus();
}

// =================== Init ===================
(async () => {
  buildLayerControls();
  buildWeightControls();
  buildColorControls();
  buildLineControls();
  buildIsochroneControls();
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
*/
