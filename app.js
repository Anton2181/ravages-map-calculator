"use strict";
// =================== Config =====================
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
// (legacy "endpoints" element removed in favor of #routes-list)
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
// ---- Multi-route state -----------------------------------------------------
// ROUTES is an ordered list of route objects. Each map click APPENDS a waypoint
// to the *active route* (the most recently created or selected one). The
// "New route" button creates a fresh empty route and makes it active so
// subsequent clicks land in it instead of extending the previous one.
//
// Route shape:
//   id          — unique number (for sidebar keys / Map keys)
//   color       — [r,g,b] route line + marker color (auto from palette, editable)
//   waypoints   — ordered [{ subhexId, hexId, px:{x,y} }]
//                 Two consecutive waypoints CAN share the same hex; that segment
//                 is treated as free same-hex movement (no cost, no hex added),
//                 with the line drawn as a straight segment between the click pts.
//   segments    — segments[i] = computed path from waypoints[i] -> waypoints[i+1]:
//                   { hexIds:[..], subhexIds:Set, cost, embarks,
//                     sameHex:bool, reachable:bool, linePts:[{x,y}..]|null,
//                     debugMask: { mask, mw, mh, bx0, by0 } | null }
//   totals      — aggregate route stats:
//                   { hexes, subhexes, miles, km, cost, embarks,
//                     byTerrain:{}, strongholds, rivers, roads, reachable }
let ROUTES = [];
let ACTIVE_ROUTE_ID = -1;
let NEXT_ROUTE_ID = 1;
// Distinct palette for auto-assigning route colors. Indexed by (routes-created
// count) mod palette length, so the Nth route always gets a predictable color.
const ROUTE_PALETTE = [
  [220,  64,  64], // red
  [ 70, 150, 240], // blue
  [ 70, 200, 110], // green
  [240, 175,  40], // orange
  [200, 110, 230], // violet
  [ 60, 210, 210], // teal
  [240, 130, 200], // pink
  [220, 220,  90], // yellow
  [170, 120,  70], // brown
  [120, 200, 240], // sky
];
// ---- Legacy aliases --------------------------------------------------------
// A handful of subsystems (debug mask overlay, drawHexOutlines, etc.) still
// look at "is there an active path to draw?". These reflect whatever the
// active route currently contains and are refreshed by syncActiveProjection().
// They are NOT the source of truth — ROUTES is.
let fromId = null, toId = null;
let fromPx = null, toPx = null;
let pathIds = null, pathSet = null;
let pathHexIds = null;
let pathSubhexIds = null;
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

// =================== Pathfinding (per-segment) ===================
// One hex-graph Dijkstra, factored out so each route segment between two
// adjacent waypoints can be computed independently. Returns the ordered
// hex-id list, or null if dstHex is unreachable from srcHex under the
// current terrain weights. srcHex === dstHex is treated as a trivial path.
function dijkstraHexPath(srcHex, dstHex) {
  if (srcHex === dstHex) return [srcHex];
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
  if (!dist.has(dstHex)) return null;
  const hexPath = [];
  let cur = dstHex;
  while (cur != null) {
    hexPath.push(cur);
    if (cur === srcHex) break;
    cur = prev.get(cur);
  }
  hexPath.reverse();
  return hexPath;
}

// Subhex-level Dijkstra. Each subhex is a node; the edge cost between two
// subhexes is:
//   * Hex terrain weight, paid ONCE when crossing into a new hex (uses the
//     destination hex's main terrain — Road column if flagged Road).
//   * PLUS one Embark, paid whenever the move crosses a naval/non-naval
//     subhex-class boundary (anywhere, regardless of which hex(es) the
//     subhexes belong to).
// Internal same-hex same-class moves cost 0 (movement inside a hex is free).
// Result: stranded naval subhexes inside a sheet-Land hex become "ferry
// zones" the router pays Embark to cross — so Dijkstra prefers a longer
// pure-land path over a short shortcut through water-class subhexes.
function dijkstraSubhexPath(fromSubId, toSubId) {
  if (fromSubId == null || toSubId == null) return null;
  if (fromSubId === toSubId) return [fromSubId];
  if (!NEIGHBORS) return null;
  const dist = new Map();
  const prev = new Map();
  const heap = new MinHeap();
  dist.set(fromSubId, 0);
  heap.push([0, fromSubId]);
  while (heap.size() > 0) {
    const [d, u] = heap.pop();
    if (u === toSubId) break;
    if (d > (dist.get(u) ?? Infinity)) continue;
    const uSub = SUBHEX_INDEX.get(u);
    if (!uSub) continue;
    const uIsNaval = WATER_TERRAINS.has(uSub.class);
    const adj = NEIGHBORS.get(u);
    if (!adj) continue;
    for (const v of adj) {
      const vSub = SUBHEX_INDEX.get(v);
      if (!vSub) continue;
      const vIsNaval = WATER_TERRAINS.has(vSub.class);
      let edgeCost = 0;
      if (uSub.hex !== vSub.hex) {
        // Crossing into a new hex: pay destination hex's terrain weight.
        const vTerrain = HEX_TERRAIN ? HEX_TERRAIN.get(vSub.hex) : null;
        if (!vTerrain) continue;
        const vHasRoad = HEX_ROAD && HEX_ROAD.get(vSub.hex);
        const w = +(vHasRoad ? roadWeights : weights)[vTerrain];
        if (!isFinite(w) || w <= 0) continue;   // impassable / unknown
        edgeCost += w;
      }
      // Naval boundary crossing — pay Embark regardless of which hex we're
      // in. This is what makes the router avoid sea-shortcuts through
      // sheet-Land hexes that are mostly water-class subhexes.
      if (uIsNaval !== vIsNaval) {
        const e = +weights["Embark"];
        if (isFinite(e) && e > 0) edgeCost += e;
      }
      const nd = d + edgeCost;
      if (nd < (dist.get(v) ?? Infinity)) {
        dist.set(v, nd);
        prev.set(v, u);
        heap.push([nd, v]);
      }
    }
  }
  if (!dist.has(toSubId)) return null;
  const path = [];
  let cur = toSubId;
  while (cur != null) {
    path.push(cur);
    if (cur === fromSubId) break;
    cur = prev.get(cur);
  }
  path.reverse();
  return path;
}

// Drawing mask for one hex path. Includes every subhex whose CLASS weight is
// <= the hex's main-terrain weight. Naval subhexes (Lake / Sea / Ocean) are
// kept in the mask EVERYWHERE — including inside Land-sheet hexes that
// contain stranded water. The line is free to drift across them; the
// subhex-level embark counter (countSubhexEmbarks) charges the Embark cost
// for every coastline crossing, so cutting a corner across water is no
// longer free.
//
// Helper still used by routeThroughMask's adjacent-hex broadening to skip
// road-restriction broadening into stranded naval pixels (those wouldn't be
// road pixels anyway). Doesn't affect the main mask.
function isStrandedNavalSubhex(sub) {
  if (!sub || !WATER_TERRAINS.has(sub.class)) return false;
  const parentTerrain = HEX_TERRAIN ? HEX_TERRAIN.get(sub.hex) : null;
  return !parentTerrain || !WATER_TERRAINS.has(parentTerrain);
}
function buildSubhexMaskForHexPath(hexPath, fromSubId, toSubId) {
  const subSet = new Set();
  if (fromSubId != null) subSet.add(fromSubId);
  if (toSubId   != null) subSet.add(toSubId);
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
  return subSet;
}

// Walk the rendered polyline pixel-by-pixel and count subhex-level transitions
// between naval-class subhexes (Lake / Sea / Ocean) and non-naval subhexes.
// Each transition costs one embark/disembark. This is the "naval subhexes are
// little ferry zones" rule: entry and exit incur Embark cost, but transit
// inside the naval region is free (same as movement inside any hex is free).
// Result: a route line that drifts across stranded water inside a Land hex
// pays for the coast crossings instead of getting them for free.
function countSubhexEmbarks(linePts) {
  if (!linePts || linePts.length < 2 || !SUBHEX_ID_PX || !SUBHEX_ID_IMG_DATA) return 0;
  const W = SUBHEX_ID_IMG_DATA.width, H = SUBHEX_ID_IMG_DATA.height;
  let prevIsWater = null;     // null = no sample yet
  let crossings = 0;
  const sample = (x, y) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const sid = SUBHEX_ID_PX[y * W + x];
    if (!sid) return;
    const sub = SUBHEX_INDEX.get(sid);
    if (!sub) return;
    const w = WATER_TERRAINS.has(sub.class);
    if (prevIsWater !== null && w !== prevIsWater) crossings++;
    prevIsWater = w;
  };
  for (let i = 0; i < linePts.length - 1; i++) {
    let x0 = Math.round(linePts[i].x),     y0 = Math.round(linePts[i].y);
    const x1 = Math.round(linePts[i + 1].x), y1 = Math.round(linePts[i + 1].y);
    const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
    const dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    while (true) {
      sample(x0, y0);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }
  return crossings;
}

// Compute one segment between adjacent waypoints wa -> wb. Same-hex segments
// are FREE (no cost, no hex added) — movement inside a hex doesn't accumulate
// traversal cost in our model, so two waypoints in the same hex just produce
// a visible straight-line marker that the user can use to mark sub-hex points
// of interest. Cross-hex segments run Dijkstra and aggregate the same edge
// cost terms updatePathInfo's old loop used (embark counts and all).
function computeSegment(wa, wb) {
  // Same-hex segment. Build the in-hex line up front and count subhex-level
  // embarks on it — two clicks inside a single hex can still cross a
  // shoreline if one's on a naval subhex and the other isn't.
  if (wa.hexId === wb.hexId) {
    const sameSubhex = (wa.subhexId === wb.subhexId);
    let linePts;
    if (sameSubhex) {
      linePts = [{ x: wa.px.x, y: wa.px.y }, { x: wb.px.x, y: wb.px.y }];
    } else {
      linePts = routeThroughMask(new Set([wa.subhexId, wb.subhexId]), {
        fromId: wa.subhexId, toId: wb.subhexId,
        fromPx: wa.px,       toPx: wb.px,
        pathHexIds: [wa.hexId],
        debugSink: {},
      });
      if (!linePts || linePts.length === 0) {
        linePts = [{ x: wa.px.x, y: wa.px.y }, { x: wb.px.x, y: wb.px.y }];
      }
    }
    const embarks = countSubhexEmbarks(linePts);
    return {
      hexIds: [wa.hexId],
      subhexIds: new Set([wa.subhexId, wb.subhexId]),
      cost: embarks * (+weights["Embark"]),
      embarks,
      sameHex: true, reachable: true,
      linePts,
      debugMask: null,
    };
  }
  const fromSub = SUBHEX_INDEX.get(wa.subhexId);
  const toSub   = SUBHEX_INDEX.get(wb.subhexId);
  if (!fromSub || !toSub) {
    return { hexIds: [], subhexIds: new Set(), cost: 0, embarks: 0,
             sameHex: false, reachable: false, linePts: null, debugMask: null };
  }
  // Run the subhex-level Dijkstra so the router itself accounts for naval
  // boundary crossings (not just the post-hoc tally). This is what makes
  // it choose the longer pure-land detour over the straight-line sea cut
  // when the latter would rack up multiple embarks.
  const subhexPath = dijkstraSubhexPath(wa.subhexId, wb.subhexId);
  if (!subhexPath) {
    return { hexIds: [], subhexIds: new Set(), cost: 0, embarks: 0,
             sameHex: false, reachable: false, linePts: null, debugMask: null };
  }
  // Derive the hex path (consecutive-dedupe) so the rest of the code keeps
  // working with the existing hex-level abstractions (mask building, line
  // rendering, route stats).
  const hexPath = [];
  for (const sid of subhexPath) {
    const sub = SUBHEX_INDEX.get(sid);
    if (!sub) continue;
    if (hexPath.length === 0 || hexPath[hexPath.length - 1] !== sub.hex) {
      hexPath.push(sub.hex);
    }
  }
  // Mask: chosen subhexes plus, for each path hex, every other subhex of the
  // SAME naval/non-naval class that Dijkstra used in that hex. Gives A* room
  // to maneuver around the chosen subhexes but keeps it on the same side of
  // any coastline Dijkstra decided to keep — so the rendered line can't
  // drift across naval boundaries Dijkstra avoided.
  const subSet = new Set(subhexPath);
  if (wa.subhexId != null) subSet.add(wa.subhexId);
  if (wb.subhexId != null) subSet.add(wb.subhexId);
  const hexClassUsed = new Map();   // hex_id -> Set<bool> (true = naval class used)
  for (const sid of subhexPath) {
    const sub = SUBHEX_INDEX.get(sid);
    if (!sub) continue;
    if (!hexClassUsed.has(sub.hex)) hexClassUsed.set(sub.hex, new Set());
    hexClassUsed.get(sub.hex).add(WATER_TERRAINS.has(sub.class));
  }
  for (const [hid, classes] of hexClassUsed) {
    const subs = SUBHEXES_BY_HEX.get(hid) || [];
    for (const sub of subs) {
      if (classes.has(WATER_TERRAINS.has(sub.class))) subSet.add(sub.id);
    }
  }

  // Build the rendered line EAGERLY via routeThroughMask. Embark count + final
  // cost both need the actual line now (subhex-level crossings), so deferring
  // line construction to render time would leave segment.cost stale.
  const debugSink = {};
  const ctx = {
    fromId: wa.subhexId, toId: wb.subhexId,
    fromPx: wa.px,       toPx: wb.px,
    pathHexIds: hexPath,
    debugSink,
  };
  let linePts = routeThroughMask(subSet, ctx);
  if ((!linePts || linePts.length === 0) && hexPath.length > 0) {
    // Filtered mask was non-contiguous from wa->wb. Fall back to ALL subhexes
    // of every path hex (no naval exclusion — the subhex-embark counter
    // charges for every coastline crossing, so cutting corners is no longer
    // free at cost-tally time).
    const fallback = new Set([wa.subhexId, wb.subhexId]);
    for (const hid of hexPath) {
      for (const sub of (SUBHEXES_BY_HEX.get(hid) || [])) fallback.add(sub.id);
    }
    linePts = routeThroughMask(fallback, ctx);
  }

  // Per-hex terrain cost only. The hex-level embark-on-shore-crossing term is
  // gone — embarks are now driven entirely by the subhex-level coastline
  // crossings of the rendered line.
  let terrainCost = 0;
  for (let i = 1; i < hexPath.length; i++) {
    const hid = hexPath[i];
    const terrain = HEX_TERRAIN ? HEX_TERRAIN.get(hid) : null;
    if (!terrain) continue;
    const curHasRoad = HEX_ROAD && HEX_ROAD.get(hid);
    const w = +(curHasRoad ? roadWeights : weights)[terrain];
    if (isFinite(w)) terrainCost += w;
  }

  const embarks = linePts ? countSubhexEmbarks(linePts) : 0;
  const embarkCost = embarks * (+weights["Embark"]);

  return {
    hexIds: hexPath,
    subhexIds: subSet,
    cost: terrainCost + embarkCost,
    embarks,
    sameHex: false, reachable: true,
    linePts: (linePts && linePts.length > 0) ? linePts : null,
    debugMask: debugSink.mask ? debugSink : null,
  };
}

// Line points are built eagerly in computeSegment now (we need them up-front
// to count subhex-level embark crossings into the segment's cost). This
// wrapper stays as the renderSelection entry point so call sites don't have
// to change, but it's just a getter.
function computeSegmentLinePoints(segment, /* wa, wb unused */) {
  return segment.linePts || null;
}

// Rebuild every segment of one route (after a waypoint changes, or weights/
// road flags shift). Line points stay null until the renderer asks for them.
function rebuildRoute(route) {
  route.segments = [];
  for (let i = 1; i < route.waypoints.length; i++) {
    route.segments.push(computeSegment(route.waypoints[i - 1], route.waypoints[i]));
  }
  route.totals = computeRouteTotals(route);
}
function rebuildAllRoutes() {
  for (const r of ROUTES) rebuildRoute(r);
  syncActiveProjection();
}

// Aggregate stats for one route. Hex count dedupes consecutive duplicates so
// the shared-endpoint hex between segments isn't counted twice. Distance is
// 30 miles per hex transition (hexes - 1), matching the single-segment model.
function computeRouteTotals(route) {
  const totals = {
    hexes: 0, subhexes: 0, miles: 0, km: 0,
    cost: 0, embarks: 0, byTerrain: {},
    strongholds: 0, rivers: 0, roads: 0,
    reachable: route.waypoints.length >= 2,   // 0/1 waypoint = trivially "reachable"
  };
  if (route.waypoints.length === 0) { totals.reachable = true; return totals; }
  const fullHexSeq = [];
  for (const seg of route.segments) {
    if (!seg.reachable) totals.reachable = false;
    for (const hid of seg.hexIds) {
      if (fullHexSeq.length === 0 || fullHexSeq[fullHexSeq.length - 1] !== hid) {
        fullHexSeq.push(hid);
      }
    }
    totals.cost    += seg.cost;
    totals.embarks += seg.embarks;
  }
  // Single-waypoint route: just count the waypoint's own hex.
  if (fullHexSeq.length === 0) fullHexSeq.push(route.waypoints[0].hexId);
  totals.hexes = fullHexSeq.length;
  totals.miles = Math.max(0, fullHexSeq.length - 1) * 30;
  totals.km    = totals.miles * 1.609344;
  const allSubhexes = new Set();
  for (const seg of route.segments) for (const sid of seg.subhexIds) allSubhexes.add(sid);
  totals.subhexes = allSubhexes.size;
  for (const hid of fullHexSeq) {
    const terrain = HEX_TERRAIN ? HEX_TERRAIN.get(hid) : null;
    if (terrain) totals.byTerrain[terrain] = (totals.byTerrain[terrain] || 0) + 1;
    if (HEX_STRONGHOLD && HEX_STRONGHOLD.get(hid)) totals.strongholds++;
    if (HEX_RIVER      && HEX_RIVER.get(hid))      totals.rivers++;
    if (HEX_ROAD       && HEX_ROAD.get(hid))       totals.roads++;
  }
  return totals;
}

// ---- Route lifecycle -------------------------------------------------------
function findRoute(id) { return ROUTES.find(r => r.id === id) || null; }
function getActiveRoute() { return ACTIVE_ROUTE_ID >= 0 ? findRoute(ACTIVE_ROUTE_ID) : null; }
function newRoute() {
  const route = {
    id: NEXT_ROUTE_ID++,
    color: ROUTE_PALETTE[(ROUTES.length) % ROUTE_PALETTE.length].slice(),
    waypoints: [], segments: [], totals: null,
  };
  ROUTES.push(route);
  ACTIVE_ROUTE_ID = route.id;
  rebuildRoute(route);
  return route;
}
function addWaypointToActive(subhexId, px) {
  let route = getActiveRoute();
  if (!route) route = newRoute();
  const sub = SUBHEX_INDEX.get(subhexId);
  if (!sub) return;
  route.waypoints.push({ subhexId, hexId: sub.hex, px: { x: px.x, y: px.y } });
  rebuildRoute(route);
  syncActiveProjection();
}
function removeWaypoint(routeId, idx) {
  const route = findRoute(routeId);
  if (!route || idx < 0 || idx >= route.waypoints.length) return;
  route.waypoints.splice(idx, 1);
  rebuildRoute(route);
  syncActiveProjection();
}
function popActiveWaypoint() {
  const route = getActiveRoute();
  if (!route || route.waypoints.length === 0) return false;
  route.waypoints.pop();
  // If this empties the route, drop the empty shell entirely so the sidebar
  // doesn't accumulate ghost rows. The previous route (if any) becomes active.
  if (route.waypoints.length === 0) {
    removeRoute(route.id);
  } else {
    rebuildRoute(route);
    syncActiveProjection();
  }
  return true;
}
function removeRoute(routeId) {
  const idx = ROUTES.findIndex(r => r.id === routeId);
  if (idx < 0) return;
  ROUTES.splice(idx, 1);
  if (ACTIVE_ROUTE_ID === routeId) {
    ACTIVE_ROUTE_ID = ROUTES.length > 0 ? ROUTES[ROUTES.length - 1].id : -1;
  }
  syncActiveProjection();
}
function setActiveRoute(routeId) {
  if (findRoute(routeId)) ACTIVE_ROUTE_ID = routeId;
  syncActiveProjection();
}
function clearAllRoutes() {
  ROUTES = []; ACTIVE_ROUTE_ID = -1;
  syncActiveProjection();
}

// Keep the deprecated single-route globals in sync with the active route so
// the few consumers that still read them (debug mask overlay, route-line draw
// fallbacks) keep behaving sensibly without each needing its own per-route
// loop. ROUTES is the source of truth; these are convenience views.
function syncActiveProjection() {
  const a = getActiveRoute();
  if (!a || a.waypoints.length === 0) {
    fromId = toId = null; fromPx = toPx = null;
    pathIds = pathSet = null; pathHexIds = pathSubhexIds = null;
    return;
  }
  const first = a.waypoints[0];
  const last  = a.waypoints[a.waypoints.length - 1];
  fromId = first.subhexId; fromPx = first.px;
  toId   = last.subhexId;  toPx   = last.px;
  const hexSeq = [];
  const subUnion = new Set();
  for (const seg of a.segments) {
    for (const hid of seg.hexIds) {
      if (hexSeq.length === 0 || hexSeq[hexSeq.length - 1] !== hid) hexSeq.push(hid);
    }
    for (const sid of seg.subhexIds) subUnion.add(sid);
  }
  pathHexIds   = hexSeq.length   > 0 ? hexSeq   : null;
  pathSubhexIds = subUnion.size > 0 ? subUnion : null;
  pathIds = pathSubhexIds ? Array.from(pathSubhexIds) : null;
  pathSet = pathSubhexIds;
}

// Backwards-compat thin wrapper: callers in ui.js still invoke recomputePath()
// after weight edits — that now re-routes EVERY route.
function recomputePath() { rebuildAllRoutes(); }

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

// NOTE: the old buildPathLinePoints() / single-segment routing wrapper is
// gone — segment.linePts is now built per-segment via computeSegmentLinePoints
// so a multi-waypoint route can stitch independent segment lines together
// rather than running A* across the whole union mask in one go.

// Build the union mask of the given subhex id set, then A* + string-pull from
// the From pixel to the To pixel through it. Each Road-flagged hex on the
// path is then evaluated INDIVIDUALLY: we RESTRICT that hex's passable area
// down to its road/city pixels (so A* can only cross the hex by walking the
// painted road), and keep the restriction only if From can still reach To.
// A bad/disconnected road hex falls back to its full mask while the other
// road hexes still snap to the road — so the rendered path follows the
// painted road wherever the road is contiguous from edge to edge.
//
// ctx (required for multi-segment routes) = {
//   fromId, toId,           — endpoint subhex ids (cost / mask / highlight)
//   fromPx, toPx,           — endpoint click pixels (line actually runs to these)
//   pathHexIds,             — ordered hex ids of THIS segment's path
//   debugSink (optional)    — { mask, mw, mh, bx0, by0 } target for the debug
//                             overlay. If omitted, _lastRouteMask is updated.
// }
function routeThroughMask(subSet, ctx) {
  const fromId      = ctx.fromId;
  const toId        = ctx.toId;
  const fromPx      = ctx.fromPx;
  const toPx        = ctx.toPx;
  const pathHexIds  = ctx.pathHexIds;

  const sStart = SUBHEX_INDEX.get(fromId), sEnd = SUBHEX_INDEX.get(toId);
  if (!sStart || !sEnd) return [];
  if (fromId === toId) {
    // Same-subhex case: there's no Dijkstra path. If both endpoints have
    // explicit click pixels, draw a straight in-subhex segment between them
    // (so two clicks in the same subhex still produce a visible line).
    if (fromPx && toPx) return [{ x: fromPx.x, y: fromPx.y }, { x: toPx.x, y: toPx.y }];
    const p = fromPx || toPx || { x: sStart.centroid[0], y: sStart.centroid[1] };
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
  // River pixels are intentionally NOT mixed into the road-restricted mask
  // anymore. A road+river hex (or any river-flagged hex) restricts to ROAD
  // pixels only — river pixels do not count as a valid pass-through for the
  // road restriction loop. Effect: routes follow the painted road inside
  // road+river hexes even when the river offers a wider "channel" the line
  // could otherwise drift onto.
  // Hexes that get restricted (road-flagged path hexes only).
  // Adjacents expand from this set.
  const restrictPathHexes = new Set(pathRoadSet);
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
      for (const s of (SUBHEXES_BY_HEX.get(hid) || [])) {
        // Stranded naval subhexes (water-class inside a land hex) stay out of
        // the mask even when broadening picks up an adjacent hex. Naval
        // subhexes inside a water-terrain hex are still allowed — broadening
        // never adds them in practice (adjAnyHexes are neighbors of road
        // hexes, which are land), but the rule is consistent with the path-
        // hex pass above so there's only one notion of "passable subhex".
        if (isStrandedNavalSubhex(s)) continue;
        extSubSet.add(s.id);
      }
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
    // lists. Road pixels are the ONLY source — river pixels are deliberately
    // not merged in, so road+river hexes still restrict to the painted road.
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
  //  - Path hexes flagged as River — skipped from restriction regardless of
  //    whether the hex is ALSO flagged Road. River-only hexes have no road
  //    pixels to restrict to anyway (skipping them avoids weird detours
  //    around the ford); road+river hexes used to merge in river pixels so
  //    they could be restricted, but that's been removed at the user's
  //    request — so we just skip those too and let A* route freely through
  //    the full hex mask. Scoped to MAIN-PATH hexes only (pathHexIds), NOT
  //    adjacent road hexes — those still get restricted even if they're
  //    rivers (off-path "courtesy" additions shouldn't swell open terrain).
  const skipHexes = new Set();
  if (sStart) skipHexes.add(sStart.hex);
  if (sEnd)   skipHexes.add(sEnd.hex);
  if (HEX_RIVER && pathHexIds) {
    for (const hid of pathHexIds) {
      if (HEX_RIVER.get(hid)) skipHexes.add(hid);
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
  //   Pass 2 — path road hexes (pathRoadSet — river-only and road+river
  //            hexes are NOT restricted): tentatively restrict, then check on the full
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

  // Stash the final mask. Callers that pass a debugSink get it written into
  // their own slot (used by per-segment route computation so each segment can
  // remember its mask); callers that don't fall back to the legacy global so
  // the existing debug overlay path still works.
  const stash = { mask, mw, mh, bx0, by0 };
  if (ctx.debugSink) Object.assign(ctx.debugSink, stash);
  else               _lastRouteMask = stash;
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

// Render one polyline in a given color. Callers pass the route color so each
// route can be visually distinguished; falls back to the legacy PATH_LINE_COLOR
// only when no color is supplied (no live caller does, but keeps the contract
// safe). Same line-width / AA / point-size settings apply to every route.
function drawPathLine(pts, color) {
  if (!pts || pts.length < 2) return;
  const rgb = color || PATH_LINE_COLOR;
  const rgba = `rgba(${rgb.join(",")},${LINE_ALPHA/255})`;
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

// Paint the per-segment routing masks onto hl-canvas in translucent magenta.
// Iterates every segment of every route so a multi-waypoint route shows the
// composite of all its segment masks; off when DEBUG_SHOW_MASK is false.
function drawDebugMask() {
  if (!DEBUG_SHOW_MASK) return;
  for (const route of ROUTES) {
    for (const seg of route.segments) {
      if (!seg.debugMask) continue;
      const { mask, mw, mh, bx0, by0 } = seg.debugMask;
      if (_dbgMaskCanvas.width !== mw || _dbgMaskCanvas.height !== mh) {
        _dbgMaskCanvas.width = mw; _dbgMaskCanvas.height = mh;
      } else {
        _dbgMaskCtx.clearRect(0, 0, mw, mh);
      }
      const img = _dbgMaskCtx.createImageData(mw, mh);
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
  }
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


// Active-route stats (kept for the legacy ui.js status bar). Returns the
// totals object of the active route, or a zeroed shape when nothing is
// selected. For multi-route aggregate stats use allRoutesStats().
function pathStats() {
  const a = getActiveRoute();
  if (!a || !a.totals) {
    return { hexes: 0, subhexes: 0, cost: 0, embarks: 0,
             byTerrain: {}, strongholds: 0, rivers: 0, roads: 0,
             miles: 0, km: 0 };
  }
  return a.totals;
}

// Aggregate totals across every route in ROUTES. Hex count sums the per-route
// hex counts (so routes that share a hex DO count it twice — they're separate
// trips). Used by the sidebar's grand-total row.
function allRoutesStats() {
  const out = { routes: ROUTES.length, hexes: 0, miles: 0, km: 0,
                cost: 0, embarks: 0, waypoints: 0,
                strongholds: 0, rivers: 0, roads: 0 };
  for (const r of ROUTES) {
    const t = r.totals;
    if (!t) continue;
    out.hexes       += t.hexes;
    out.miles       += t.miles;
    out.km          += t.km;
    out.cost        += t.cost;
    out.embarks     += t.embarks;
    out.waypoints   += r.waypoints.length;
    out.strongholds += t.strongholds;
    out.rivers      += t.rivers;
    out.roads       += t.roads;
  }
  return out;
}
// Draw the perimeter outline for a set of hex ids. hexIdSet is required
// (callers pass per-route hex sets). Color defaults to HEX_OUTLINE_COLOR
// when not supplied, so the legacy global-outline setting still applies if
// a caller wants the same color for everything.
function drawHexOutlines(hexIdSet, color) {
  if (!SHOW_HEX_OUTLINE) return;
  if (!hexIdSet || hexIdSet.size === 0) return;
  const hexIds = hexIdSet;
  const g = HEX_DATA.geometry;
  const s = g.hex_size, hw = g.hex_width / 2;
  const cpr = HEX_DATA.cols_per_row;
  const rgb = color || HEX_OUTLINE_COLOR;
  const rgba = `rgba(${rgb.join(",")},${HEX_OUTLINE_ALPHA/255})`;
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
  //
  // Multi-route rendering pass:
  //   1. Path-mask fills (PATH_COLOR/ALPHA) for every route, with each route's
  //      first/last waypoint subhex separated out so the START/END fills can
  //      override them. (PATH_ALPHA defaults to 0 so this is a no-op unless
  //      the Settings panel has been opened and the alpha bumped up.)
  //   2. Per-segment line points (built lazily here so segment.debugMask is
  //      populated before drawDebugMask reads it).
  //   3. Hex outlines per route — opt-in via the Path-line panel; uses the
  //      global outline color since the route line already carries identity.
  //   4. Waypoint dots in the route's own color at every click point, so two
  //      waypoints in the same hex still appear as distinct visible points
  //      along the line and the user can edit them individually.
  //   5. Debug mask overlay LAST so magenta sits on top of everything else.

  if (PATH_ALPHA > 0) {
    const allSubhexes = new Set();
    const endpointSubhexes = new Set();
    for (const route of ROUTES) {
      if (route.waypoints.length > 0) {
        endpointSubhexes.add(route.waypoints[0].subhexId);
        endpointSubhexes.add(route.waypoints[route.waypoints.length - 1].subhexId);
      }
      for (const seg of route.segments) {
        for (const sid of seg.subhexIds) allSubhexes.add(sid);
      }
    }
    for (const sid of endpointSubhexes) allSubhexes.delete(sid);
    if (allSubhexes.size > 0) fillSubhexSet(allSubhexes, PATH_COLOR, PATH_ALPHA);
  }

  for (const route of ROUTES) {
    if (route.waypoints.length === 0) continue;
    const first = route.waypoints[0];
    const last  = route.waypoints[route.waypoints.length - 1];
    if (START_ALPHA > 0) fillSubhex(SUBHEX_INDEX.get(first.subhexId), START_COLOR, START_ALPHA);
    if (END_ALPHA   > 0 && last.subhexId !== first.subhexId)
                          fillSubhex(SUBHEX_INDEX.get(last.subhexId),  END_COLOR,   END_ALPHA);
    for (let i = 0; i < route.segments.length; i++) {
      const seg = route.segments[i];
      const wa  = route.waypoints[i];
      const wb  = route.waypoints[i + 1];
      const pts = computeSegmentLinePoints(seg, wa, wb);
      if (pts && pts.length >= 2) drawPathLine(pts, route.color);
    }
  }

  if (SHOW_HEX_OUTLINE) {
    for (const route of ROUTES) {
      const hexSet = new Set();
      for (const seg of route.segments) for (const hid of seg.hexIds) hexSet.add(hid);
      if (hexSet.size > 0) drawHexOutlines(hexSet, HEX_OUTLINE_COLOR);
    }
  }

  for (const route of ROUTES) drawWaypointMarkers(route);

  drawDebugMask();
}

// Filled circle at every waypoint of the route, with an outline so the marker
// reads against the route's own line color. First and last waypoints are
// slightly larger; the active route's waypoints get a white outline so it's
// obvious which route the next click will extend.
function drawWaypointMarkers(route) {
  if (route.waypoints.length === 0) return;
  const rgba = `rgba(${route.color.join(",")},1)`;
  const isActive = route.id === ACTIVE_ROUTE_ID;
  const base = Math.max(3, Math.round(LINE_WIDTH) + 2);
  hlCtx.lineWidth = 1.5;
  for (let i = 0; i < route.waypoints.length; i++) {
    const wp = route.waypoints[i];
    const isEnd = (i === 0 || i === route.waypoints.length - 1);
    const r = isEnd ? base + 1.5 : base;
    hlCtx.beginPath();
    hlCtx.fillStyle = rgba;
    hlCtx.strokeStyle = isActive ? "rgba(255,255,255,0.9)" : "rgba(0,0,0,0.7)";
    hlCtx.arc(wp.px.x, wp.px.y, r, 0, Math.PI * 2);
    hlCtx.fill();
    hlCtx.stroke();
  }
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
  // Multi-route click: every click appends a waypoint to the active route.
  // The active route is created on demand for the first click (and by the
  // "New route" sidebar button thereafter). Multiple in-hex clicks are
  // allowed by design — segments inside a single hex are free movement.
  addWaypointToActive(sid, { x: ipt.x, y: ipt.y });
  renderSelection(); updateEndpoints(); updatePathInfo(); updateStatus();
}

// =================== Init ====================================================
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
