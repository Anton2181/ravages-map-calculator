"use strict";
// =================== Config =====================
const LAYERS = [
  { id: "sea",         file: "sea.png",                 label: "Sea fill",               on: true,  opacity: 1.00, hidden: true },
  { id: "continent",   file: "Continent Meat.png",      label: "Outline",                on: true,  opacity: 1.00 },
  { id: "terrain",     file: "Terrain.png",             label: "Terrain",                on: true,  opacity: 1.00 },
  { id: "borders",     file: "Borders.png",             label: "Borders",                on: false, opacity: 1.00 },
  { id: "core",        file: "core commanderies.png",      label: "Core commanderies",      on: false, opacity: 1.00 },
  { id: "frontier",    file: "frontier commanderies.png",  label: "Frontier commanderies",  on: false, opacity: 1.00 },
  { id: "provinces",   file: "provinces commanderies.png", label: "Province commanderies",  on: false, opacity: 1.00 },
  { id: "legions",     file: "Imperial Legions.png",    label: "Imperial Legions",       on: false, opacity: 1.00 },
  { id: "rivers",      file: "rivers.png",              label: "Rivers",                 on: true,  opacity: 1.00 },
  { id: "roads",       file: "Roads.png",               label: "Roads",                  on: true,  opacity: 1.00 },
  { id: "ctf",         file: "citiestownsforts.png",    label: "Cities / towns / forts", on: true,  opacity: 1.00 },
  { id: "simple",      file: "simple grid.png",         label: "Hex grid",               on: false, opacity: 0.40 },
  { id: "base",        file: "Ravages_ver_6.3_hex.png", label: "Hex ID map",             on: false, opacity: 1.00 },
];
// CLASSES is the canonical traversal-class list — aligned 1:1 with the
// terrain types the sheet uses, plus Embark / Ferry as routing-cost
// terms. The subhex map (subhex_data.json) has a couple of historical
// extras that DON'T appear in the sheet: "Plains" (the subhex-art name
// for what the sheet calls Flatlands) and "Peaks" (a subhex-only
// "extra-heavy mountain" tier). Those are resolved via canonicalSubhexClass
// below — never as separate weight columns — so the sheet stays the
// single source of truth for what land classes exist.
const CLASSES = ["Flatlands", "Hills", "Mountains", "Lake", "Sea", "Ocean", "Embark", "Ferry"];
const DEFAULT_WEIGHTS = {
  "Flatlands": 1, "Hills": 2, "Mountains": 5,
  // Water hex traversal weights (used directly when sailing water->water).
  // Sailing is faster than overland, so lakes and seas are cheap; ocean
  // is the slowest water but still cheaper than rough land.
  "Lake": 0.5, "Sea": 0.5, "Ocean": 1,
  // Embark — land <-> water boundary crossing (loading or unloading a ship).
  "Embark": 3,
  // Ferry — surcharge added in dijkstraSubhexPath when a subhex-pair edge
  // crosses (or uses) a thick-river pixel inside a road-flagged hex. Models
  // the time / cost of waiting for and riding the ferry across the river.
  "Ferry": 4,
};
// Road column of the traversal-weight matrix. When dijkstra routes via
// a road COMPONENT, we use THIS table's value keyed by the parent hex's
// terrain instead of the default column — i.e., roads shave weight off a
// hex's inherent terrain cost. Embark/disembark and water-to-water still
// use the default column (a road doesn't help you load a ship or sail
// faster).
const DEFAULT_ROAD_WEIGHTS = {
  "Flatlands": 0.5, "Hills": 1, "Mountains": 2,
  // Water and embark mirror the default column (roads don't help shipping).
  "Lake": 0.5, "Sea": 0.5, "Ocean": 1,
  "Embark": 3,
  "Ferry": 4,
};

// Class aliases — resolved before any weight lookup. The subhex artwork
// and the sheet use a few extra class names that we don't carry as
// separate weight columns: Plains and Peaks come from the subhex map,
// Woodland comes from the sheet but we treat it the same as Hills.
// Routing always canonicalises through this map first.
const CLASS_ALIASES = {
  "Plains":   "Flatlands",
  "Peaks":    "Mountains",
  "Woodland": "Hills",
};

// Canonical class for a hex's sheet terrain — applies CLASS_ALIASES so
// Woodland resolves to Hills (etc.) before weight lookup. Returns the
// input unchanged if no alias exists.
function canonicalHexTerrain(t) {
  if (!t) return t;
  return CLASS_ALIASES[t] || t;
}

// Resolve a subhex's class to its canonical (sheet) class.
//   * Sea-class subhexes: the subhex artwork tags every naval pixel as
//     "Sea", but the sheet distinguishes Sea / Lake / Ocean per hex. We
//     use the parent hex's terrain whenever it's naval, so a Sea subhex
//     inside an Ocean hex bills the Ocean weight (not the lighter Sea
//     weight). Stranded naval inside a land hex falls back to "Sea".
//   * Plains / Peaks: direct alias via CLASS_ALIASES.
//   * Everything else: returned as-is.
function canonicalSubhexClass(sub) {
  if (!sub) return null;
  const cls = sub.class;
  if (cls === "Sea") {
    const t = HEX_TERRAIN ? HEX_TERRAIN.get(sub.hex) : null;
    if (t === "Lake" || t === "Ocean" || t === "Sea") return t;
    return "Sea";
  }
  return CLASS_ALIASES[cls] || cls;
}

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
// Per-pixel mask of river pixels that are TOO WIDE to ford — set by
// buildThickRiverMask in buildPixelMasks. The route mask in routeThroughMask
// strips these out unconditionally so the rendered line can only cross
// rivers at single-pixel-wide stretches (drawn as fords on the map).
let THICK_RIVER_PIXEL_MASK = null;
// The strict (alpha > 160) river mask used as input to thickness detection.
// Stored globally so the debug visualization can show exactly what the
// detector saw, instead of inferring from the inclusive RIVER_PIXEL_MASK
// (which has AA halos that confuse the painted view).
let STRICT_RIVER_PIXEL_MASK = null;
// THICK_RIVER_PIXEL_MASK dilated by 1 pixel. This is what routing actually
// uses for blocking; the un-dilated mask is only for the debug overlay so
// the viewer can distinguish core-thick from halo pixels.
let THICK_RIVER_BLOCKING_MASK = null;
// Strict-thin pixels expanded outward 3 px (capped by inclusive river mask
// and bounded so it can't bleed into THICK_RIVER_PIXEL_MASK). Used by the
// [debug] River types overlay to give thin rivers the same "closes its own
// gaps" treatment thick rivers get, without moving the red/green boundary.
let THIN_RIVER_EXPANDED_MASK = null;
// Set<string> of canonicalized "minSid|maxSid" subhex pairs whose entire
// shared border is blocked by thick-river pixels — i.e. there's no clear
// crossing point between them. dijkstraSubhexPath skips these edges so the
// router avoids picking paths the renderer couldn't actually trace.
let BLOCKED_SUBHEX_EDGES = null;
// Set of hex ids where at least one pixel is BOTH in ROAD_PIXEL_MASK and
// THICK_RIVER_PIXEL_MASK — i.e. the artwork has road and thick-river pixels
// overlaid at the same coordinate. That overlay is the ferry marking: the
// road appears to "cross" the river at painted spots. Only these hexes get
// the ferry-loosening behavior (thick-river passable in component analysis,
// road+thick fallback in restrict(), counted as ferry crossings on the
// rendered line). Non-ferry road hexes — i.e. roads that just touch a
// thin river or run alongside a thick one without crossing — stay strict.
let FERRY_HEXES = null;
// ---------- Subhex-component graph (river-aware Dijkstra) ------------------
// For each pixel, the connected-component id WITHIN its subhex (counting only
// non-thick pixels, 4-connected). 0 = thick / outside subhexes. Component
// ids restart at 1 inside each subhex. This is what lets us treat a thick
// river running THROUGH a subhex as a barrier even when it doesn't sit on
// the subhex's outer border — pixels on opposite sides of the internal
// river get different component ids, so Dijkstra can tell them apart.
let SUBHEX_PIXEL_COMPONENT = null;       // Uint16Array same shape as SUBHEX_ID_PX
let SUBHEX_COMPONENT_COUNT = null;       // Map<subhexId, number of components>
// Pixel count per (subhex, component). Lets future filtering rules (e.g.,
// "skip road components smaller than MIN_PIXELS_PER_PATH_HEX") consult the
// component's actual artwork size without rescanning pixels.
let SUBHEX_COMPONENT_PIXEL_COUNT = null;  // Map<"sid:comp", number of pixels>
// Per-(subhex,component) adjacency map. Keys are "subhexId:compId" node
// strings; values are Sets of neighbor node strings reachable across a clear
// (non-thick) border pixel pair. Used by the component-aware Dijkstra.
let SUBHEX_COMPONENT_NEIGHBORS = null;   // Map<string, Set<string>>
// Set of "subhexId:compId" strings whose pixels are road / city pixels.
// The flood-fill in precomputeSubhexComponents now splits at the
// road/non-road boundary, so road and land within the same subhex are
// different components. ROAD_COMPONENTS tags which side is which —
// dijkstra and rendering both consult it to apply the road weight only
// to the road-pixel side, not to the surrounding land.
let ROAD_COMPONENTS = null;
// Set of "subhexId:compId" strings whose pixels include at least one
// thick-river pixel. Only ever populated in ferry hexes (in non-ferry
// hexes thick pixels are barriers and never join any component). This
// is the set dijkstra consults to charge a Ferry surcharge: when
// transitioning from a non-thick-touching component into a thick-
// touching one, that's the moment the route "boards" — pay Ferry.
// Naval-class subhex transitions are a separate concept (handled by
// Embark) and don't depend on this set.
let THICK_RIVER_COMPONENTS = null;
// Helper: look up the component id of a given pixel within its subhex.
// Returns 0 if the pixel isn't in any subhex or is on a thick pixel.
function pixelComponent(pixIdx) {
  return SUBHEX_PIXEL_COMPONENT ? SUBHEX_PIXEL_COMPONENT[pixIdx] : 0;
}
// Debug toggle: when on, paints river-thickness classification over the
// map (thin river = green, thick river core = red, thick-blocking halo =
// orange). Set from the Settings → Path-line panel.
let DEBUG_SHOW_RIVER_TYPES = false;
// Debug toggle: when on, paints FERRY_HEXES in translucent yellow so you
// can see which hexes the precompute treated as ferries (i.e. had road
// pixels overlaid on thick-river pixels). Useful for verifying a missing
// ferry crossing — if the hex doesn't tint here, the artwork doesn't have
// the overlay the detector needs.
let DEBUG_SHOW_FERRY_HEXES = false;
// Debug toggle: when on, tints every pixel by its routing CATEGORY:
//   * Naval (Sea / Lake / Ocean class)                     → blue
//   * Infrastructure (road or city pixels on land)         → orange
//   * Land that passes the assigned-weight check
//     (subhex class weight ≤ parent hex's terrain weight)  → green
// Land pixels heavier than their parent hex's assigned weight (e.g. a
// Mountains subhex inside a Flatlands hex) are left untinted — those are
// the pixels dijkstra can no longer enter under the per-component
// restriction. Useful for verifying that the three-category split
// matches what the router actually sees.
let DEBUG_SHOW_SUBHEX_TYPES = false;
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
// Pre-computed set of SUBHEX ids that contain at least one road or city pixel.
// Used by the subhex-class cost model: a subhex in this set is treated as a
// "Road" subhex (weight = roadWeights[parentHex.terrain]) instead of using its
// natural class. This is what lets dijkstra distinguish a road that actually
// runs through the chosen sequence of subhexes from a road in the same hex
// that runs in some other direction — only road subhexes on the dijkstra
// path get the road discount, not the whole hex.
let ROAD_SUBHEXES = null;
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
  precomputeRoadSubhexes();
  precomputeFerryHexes();
  precomputeSubhexComponents();
  precomputeBlockedSubhexEdges();
  precomputeSubhexComponentNeighbors();
  loadingEl.classList.add("hidden");
}

// Identify hexes whose artwork has road pixels physically overlaid on thick-
// river pixels — the painted "ferry" marking. A hex qualifies if at least
// one of its pixels is set in BOTH ROAD_PIXEL_MASK and THICK_RIVER_PIXEL_MASK.
// Only these hexes get ferry semantics: thick-river-as-passable in the
// component flood-fill, the road+thick fallback in restrict(), and the
// per-pixel "this hex's thick river is fordable via ferry" check used by
// countFerryCrossings. Regular road hexes (road runs alongside or bridges a
// thin river) stay strict.
function precomputeFerryHexes() {
  FERRY_HEXES = new Set();
  if (!ROAD_PIXEL_MASK || !THICK_RIVER_PIXEL_MASK || !HEX_PIXELS) return;
  for (const [hid, pixels] of HEX_PIXELS.entries()) {
    for (let i = 0; i < pixels.length; i++) {
      const idx = pixels[i];
      if (ROAD_PIXEL_MASK[idx] && THICK_RIVER_PIXEL_MASK[idx]) {
        FERRY_HEXES.add(hid);
        break;
      }
    }
  }
}

// Flood-fill each subhex's non-thick pixels into connected components.
// Now the flood ALSO refuses to cross the road/non-road boundary, so road
// pixels (roads + cities) form their own component, distinct from the
// surrounding land of the same subhex. That makes "road" a real graph
// node — dijkstra can only get the road discount by ACTUALLY routing
// through road pixels, not by entering a subhex that happens to contain
// a stray road. Component ids still restart at 1 inside each subhex;
// ROAD_COMPONENTS tags which of those are the road side.
function precomputeSubhexComponents() {
  if (!SUBHEX_ID_PX || !SUBHEX_ID_IMG_DATA || !SUBHEXES_BY_HEX) return;
  const W = SUBHEX_ID_IMG_DATA.width, H = SUBHEX_ID_IMG_DATA.height;
  const N = W * H;
  SUBHEX_PIXEL_COMPONENT = new Uint16Array(N);
  SUBHEX_COMPONENT_COUNT = new Map();
  SUBHEX_COMPONENT_PIXEL_COUNT = new Map();
  ROAD_COMPONENTS = new Set();
  THICK_RIVER_COMPONENTS = new Set();
  const thick = THICK_RIVER_BLOCKING_MASK || THICK_RIVER_PIXEL_MASK;
  // Per-pixel "is this pixel anywhere thick river" — used to tag a
  // component as thick-touching even when blockThick=true (non-ferry
  // hex). In ferry hexes the flood admits thick pixels into components
  // so any component that contains one is naturally thick-touching.
  const thickPx = THICK_RIVER_PIXEL_MASK;
  const road  = ROAD_PIXEL_MASK;     // roads ∪ cities
  const subhexPx = SUBHEX_ID_PX;
  const queue = new Int32Array(N);
  for (const [hid, subs] of SUBHEXES_BY_HEX.entries()) {
    // FERRY hexes (artwork has road pixels overlaid on thick-river pixels)
    // treat thick-river pixels as passable in the component flood-fill, so
    // the road's components don't end up split by the river the ferry is
    // bridging. Regular road hexes — road just touches or runs alongside a
    // thin river — do NOT get this looseness; they keep thick river as a
    // barrier same as any other land hex.
    const allowThick = !!(FERRY_HEXES && FERRY_HEXES.has(hid));
    const blockThick = !allowThick;
    for (const sub of subs) {
      const subId = sub.id;
      let compCount = 0;
      const [x0, y0, x1, y1] = sub.bbox;
      const xa = Math.max(0, x0), ya = Math.max(0, y0);
      const xb = Math.min(W - 1, x1), yb = Math.min(H - 1, y1);
      for (let y = ya; y <= yb; y++) {
        const row = y * W;
        for (let x = xa; x <= xb; x++) {
          const i = row + x;
          if (subhexPx[i] !== subId) continue;
          if (blockThick && thick && thick[i]) continue;
          if (SUBHEX_PIXEL_COMPONENT[i] !== 0) continue;
          compCount++;
          const compId = compCount;
          const seedIsRoad = road ? !!road[i] : false;
          if (seedIsRoad) ROAD_COMPONENTS.add(`${subId}:${compId}`);
          // Track whether THIS component (subhex + compId) ends up
          // containing any thick-river pixel. In ferry hexes the flood
          // admits thick pixels, so a component can include them. We
          // tag the component in THICK_RIVER_COMPONENTS as soon as we
          // see a thick pixel.
          let compHasThick = !!(thickPx && thickPx[i]);
          let compPixCount = 1;
          SUBHEX_PIXEL_COMPONENT[i] = compId;
          let head = 0, tail = 0;
          queue[tail++] = i;
          while (head < tail) {
            const idx = queue[head++];
            const cy = (idx / W) | 0;
            const cx = idx - cy * W;
            // 4-connected neighbors restricted to: same subhex, non-thick
            // (when blockThick), and SAME road class as the seed. The
            // road-class check is what creates the road-vs-land split.
            if (cx + 1 < W) {
              const ni = idx + 1;
              const niIsRoad = road ? !!road[ni] : false;
              if (subhexPx[ni] === subId && !(blockThick && thick && thick[ni]) && SUBHEX_PIXEL_COMPONENT[ni] === 0 && niIsRoad === seedIsRoad) {
                SUBHEX_PIXEL_COMPONENT[ni] = compId;
                if (thickPx && thickPx[ni]) compHasThick = true;
                compPixCount++;
                queue[tail++] = ni;
              }
            }
            if (cx > 0) {
              const ni = idx - 1;
              const niIsRoad = road ? !!road[ni] : false;
              if (subhexPx[ni] === subId && !(blockThick && thick && thick[ni]) && SUBHEX_PIXEL_COMPONENT[ni] === 0 && niIsRoad === seedIsRoad) {
                SUBHEX_PIXEL_COMPONENT[ni] = compId;
                if (thickPx && thickPx[ni]) compHasThick = true;
                compPixCount++;
                queue[tail++] = ni;
              }
            }
            if (cy + 1 < H) {
              const ni = idx + W;
              const niIsRoad = road ? !!road[ni] : false;
              if (subhexPx[ni] === subId && !(blockThick && thick && thick[ni]) && SUBHEX_PIXEL_COMPONENT[ni] === 0 && niIsRoad === seedIsRoad) {
                SUBHEX_PIXEL_COMPONENT[ni] = compId;
                if (thickPx && thickPx[ni]) compHasThick = true;
                compPixCount++;
                queue[tail++] = ni;
              }
            }
            if (cy > 0) {
              const ni = idx - W;
              const niIsRoad = road ? !!road[ni] : false;
              if (subhexPx[ni] === subId && !(blockThick && thick && thick[ni]) && SUBHEX_PIXEL_COMPONENT[ni] === 0 && niIsRoad === seedIsRoad) {
                SUBHEX_PIXEL_COMPONENT[ni] = compId;
                if (thickPx && thickPx[ni]) compHasThick = true;
                compPixCount++;
                queue[tail++] = ni;
              }
            }
          }
          if (compHasThick) THICK_RIVER_COMPONENTS.add(`${subId}:${compId}`);
          SUBHEX_COMPONENT_PIXEL_COUNT.set(`${subId}:${compId}`, compPixCount);
        }
      }
      SUBHEX_COMPONENT_COUNT.set(subId, compCount);
    }
  }
}

// Walk every subhex-pair edge in NEIGHBORS once more, but this time record
// which (subhex, component) pairs can reach each other through a clear
// border. The result is SUBHEX_COMPONENT_NEIGHBORS — a Map keyed by
// "subhex:component" strings, valued by Sets of neighbor "subhex:component"
// strings the line could actually cross to. dijkstraSubhexPath uses this
// graph so a route through a subhex must enter AND exit through the same
// internal component (i.e. can't teleport across a river that bisects the
// subhex's interior).
function precomputeSubhexComponentNeighbors() {
  SUBHEX_COMPONENT_NEIGHBORS = new Map();
  if (!SUBHEX_PIXEL_COMPONENT || !SUBHEX_ID_PX || !SUBHEX_ID_IMG_DATA || !NEIGHBORS) return;
  const W = SUBHEX_ID_IMG_DATA.width, H = SUBHEX_ID_IMG_DATA.height;
  const subhexPx = SUBHEX_ID_PX, comp = SUBHEX_PIXEL_COMPONENT;
  const link = (aKey, bKey) => {
    let set = SUBHEX_COMPONENT_NEIGHBORS.get(aKey);
    if (!set) { set = new Set(); SUBHEX_COMPONENT_NEIGHBORS.set(aKey, set); }
    set.add(bKey);
  };
  for (const [aSid, neighbors] of NEIGHBORS) {
    const sA = SUBHEX_INDEX.get(aSid);
    if (!sA) continue;
    for (const bSid of neighbors) {
      if (bSid <= aSid) continue;
      const sB = SUBHEX_INDEX.get(bSid);
      if (!sB) continue;
      // Bbox intersection +1 px margin; the diagonal corner-cut check
      // needs to read 1 pixel beyond a candidate orthogonal neighbor,
      // so the loop bounds stay safely inside the image with the +1.
      const x0 = Math.max(1, Math.max(sA.bbox[0], sB.bbox[0]) - 1);
      const y0 = Math.max(1, Math.max(sA.bbox[1], sB.bbox[1]) - 1);
      const x1 = Math.min(W - 2, Math.min(sA.bbox[2], sB.bbox[2]) + 1);
      const y1 = Math.min(H - 2, Math.min(sA.bbox[3], sB.bbox[3]) + 1);
      if (x1 < x0 || y1 < y0) continue;
      // For every A-pixel adjacent to a B-pixel where BOTH are non-thick
      // (component id != 0), connect their (subhex,component) nodes.
      const seen = new Set();
      const tryPair = (aIdx, bIdx) => {
        const aComp = comp[aIdx], bComp = comp[bIdx];
        if (!aComp || !bComp) return;
        const key = `${aSid}:${aComp}|${bSid}:${bComp}`;
        if (seen.has(key)) return;
        seen.add(key);
        link(`${aSid}:${aComp}`, `${bSid}:${bComp}`);
        link(`${bSid}:${bComp}`, `${aSid}:${aComp}`);
      };
      // 8-connected pixel adjacency (no corner-cutting) — matches the
      // renderer's A* connectivity exactly, so any edge dijkstra puts
      // in the graph corresponds to a line the renderer can actually
      // draw. The orthogonal connections fire as before; diagonals
      // only count when at least one of the two orthogonal neighbors
      // is in subhex A or B (i.e. you can step diagonally without
      // cutting a corner of a third subhex).
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const i = y * W + x;
          if (subhexPx[i] !== aSid) continue;
          // Orthogonal
          if (x + 1 < W) { const j = i + 1;  if (subhexPx[j] === bSid) tryPair(i, j); }
          if (x > 0)     { const j = i - 1;  if (subhexPx[j] === bSid) tryPair(i, j); }
          if (y + 1 < H) { const j = i + W;  if (subhexPx[j] === bSid) tryPair(i, j); }
          if (y > 0)     { const j = i - W;  if (subhexPx[j] === bSid) tryPair(i, j); }
          // Diagonal — only valid if at least one of the two orthogonal
          // neighbors at the corner is in aSid or bSid (no corner-cut
          // through a third subhex).
          const tryDiag = (j, ox, oy) => {
            if (subhexPx[j] !== bSid) return;
            const oxSid = subhexPx[oy * W + (x + ox)];
            const oySid = subhexPx[(y + oy) * W + x];
            if (oxSid !== aSid && oxSid !== bSid && oySid !== aSid && oySid !== bSid) return;
            tryPair(i, j);
          };
          if (x + 1 < W && y + 1 < H) tryDiag(i + W + 1, +1, +1);
          if (x > 0     && y + 1 < H) tryDiag(i + W - 1, -1, +1);
          if (x + 1 < W && y > 0)     tryDiag(i - W + 1, +1, -1);
          if (x > 0     && y > 0)     tryDiag(i - W - 1, -1, -1);
        }
      }
    }
  }

  // Intra-subhex component links. The flood-fill in precomputeSubhexComponents
  // splits a subhex into distinct components at the road/non-road boundary
  // (and across thick-river barriers). Those components ARE pixel-adjacent
  // at the boundary, but the loop above only links pairs of DIFFERENT
  // subhex ids. Without an intra-subhex link, dijkstra can't step from the
  // road component onto the surrounding land of the same subhex — it'd
  // have to follow the road all the way to a neighbor and step onto land
  // there. The result was paths that detour long distances along roads
  // even when a direct land route would have been cheaper.
  //
  // For each subhex that has >1 component, scan its bbox for pixel pairs
  // (i, ni) of the SAME subhex but DIFFERENT components, and link the
  // two component nodes both ways. The link is by subhex+component, so
  // dijkstra crosses these edges as a same-hex same-subhex transition
  // (free move, only updates the hex's running max).
  if (SUBHEX_COMPONENT_COUNT && SUBHEXES_BY_HEX) {
    for (const subs of SUBHEXES_BY_HEX.values()) {
      for (const sub of subs) {
        const subId = sub.id;
        if ((SUBHEX_COMPONENT_COUNT.get(subId) || 0) < 2) continue;
        const [x0, y0, x1, y1] = sub.bbox;
        const xa = Math.max(0, x0), ya = Math.max(0, y0);
        const xb = Math.min(W - 1, x1), yb = Math.min(H - 1, y1);
        const seenPairs = new Set();
        const linkComps = (cA, cB) => {
          if (!cA || !cB || cA === cB) return;
          const lo = cA < cB ? cA : cB;
          const hi = cA < cB ? cB : cA;
          const k = `${lo}|${hi}`;
          if (seenPairs.has(k)) return;
          seenPairs.add(k);
          link(`${subId}:${cA}`, `${subId}:${cB}`);
          link(`${subId}:${cB}`, `${subId}:${cA}`);
        };
        for (let y = ya; y <= yb; y++) {
          for (let x = xa; x <= xb; x++) {
            const i = y * W + x;
            if (subhexPx[i] !== subId) continue;
            const cA = comp[i];
            if (!cA) continue;
            if (x + 1 < W) { const j = i + 1; if (subhexPx[j] === subId) linkComps(cA, comp[j]); }
            if (y + 1 < H) { const j = i + W; if (subhexPx[j] === subId) linkComps(cA, comp[j]); }
          }
        }
      }
    }
  }

  // No road-component bridge — the 8-conn pixel-adjacency loop above
  // already creates every edge dijkstra needs that the renderer can
  // actually follow. A "bridge" across artwork gaps wider than 1 px
  // (diagonal) would put edges in dijkstra's graph that the renderer
  // can't draw, and the displayed cost would diverge from what
  // dijkstra optimised. If you find a real gap in the artwork (road
  // continuity broken by >1 pixel), it's better to fix the painted
  // road than to widen the bridge.
}

// Convenience: from a subhex id + a "preferred pixel" (the user's click, or
// the subhex centroid), pick the component id that contains that pixel.
// Falls back to component 1 (the largest by id is whichever was flood-filled
// first; we just need *some* anchor) if the preferred pixel happens to be
// a thick pixel or otherwise componentless.
function subhexComponentAt(subhexId, prefPixelIdx) {
  if (!SUBHEX_PIXEL_COMPONENT) return 1;
  if (prefPixelIdx != null) {
    const c = SUBHEX_PIXEL_COMPONENT[prefPixelIdx];
    if (c) return c;
  }
  // Walk the subhex's bbox until we find any non-thick pixel.
  const sub = SUBHEX_INDEX.get(subhexId);
  if (!sub || !SUBHEX_ID_IMG_DATA) return 1;
  const W = SUBHEX_ID_IMG_DATA.width;
  const subhexPx = SUBHEX_ID_PX;
  const [x0, y0, x1, y1] = sub.bbox;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = y * W + x;
      if (subhexPx[i] === subhexId) {
        const c = SUBHEX_PIXEL_COMPONENT[i];
        if (c) return c;
      }
    }
  }
  return 1;
}

// Walk every subhex-pair edge in NEIGHBORS and check whether the SHARED
// BORDER between them has any clear (non-thick-river) crossing pair. If
// every border-pair (an A-pixel 4-adjacent to a B-pixel) is blocked by a
// thick-river pixel on either side, the edge is considered impassable —
// the rendered line couldn't have crossed there anyway, so dijkstraSubhexPath
// shouldn't pick paths that depend on it.
//
// Heavy: O(sum-of-bbox-intersections) pixel work, but it only runs once at
// load time. Result is a Set of canonical "min|max" pair strings (smaller
// subhex id first) so each undirected edge is stored once and either
// direction lookup uses the same key.
function precomputeBlockedSubhexEdges() {
  BLOCKED_SUBHEX_EDGES = new Set();
  // Use the dilated blocking mask so the edge check agrees with what
  // routeThroughMask actually treats as impassable.
  const thick = THICK_RIVER_BLOCKING_MASK || THICK_RIVER_PIXEL_MASK;
  if (!thick || !SUBHEX_ID_PX || !SUBHEX_ID_IMG_DATA || !NEIGHBORS) return;
  const W = SUBHEX_ID_IMG_DATA.width, H = SUBHEX_ID_IMG_DATA.height;
  const subhexPx = SUBHEX_ID_PX;
  for (const [aSid, neighbors] of NEIGHBORS) {
    const sA = SUBHEX_INDEX.get(aSid);
    if (!sA) continue;
    for (const bSid of neighbors) {
      if (bSid <= aSid) continue;        // canonicalize: only process each pair once
      const sB = SUBHEX_INDEX.get(bSid);
      if (!sB) continue;
      // Scan the bbox intersection (+1 px margin) for A pixels with a
      // B 4-neighbor. Stop the moment we find any crossing pair where
      // NEITHER side is thick river — that means the line can cross here
      // and the edge stays open.
      const x0 = Math.max(0, Math.max(sA.bbox[0], sB.bbox[0]) - 1);
      const y0 = Math.max(0, Math.max(sA.bbox[1], sB.bbox[1]) - 1);
      const x1 = Math.min(W - 1, Math.min(sA.bbox[2], sB.bbox[2]) + 1);
      const y1 = Math.min(H - 1, Math.min(sA.bbox[3], sB.bbox[3]) + 1);
      if (x1 < x0 || y1 < y0) continue;
      let foundAny = false;     // any border pair at all (sanity check)
      let foundClear = false;   // any clear (non-thick) border pair
      for (let y = y0; y <= y1 && !foundClear; y++) {
        for (let x = x0; x <= x1 && !foundClear; x++) {
          const i = y * W + x;
          if (subhexPx[i] !== aSid) continue;
          const aThick = thick[i];
          if (x + 1 < W) {
            const j = i + 1;
            if (subhexPx[j] === bSid) { foundAny = true; if (!aThick && !thick[j]) foundClear = true; }
          }
          if (!foundClear && x > 0) {
            const j = i - 1;
            if (subhexPx[j] === bSid) { foundAny = true; if (!aThick && !thick[j]) foundClear = true; }
          }
          if (!foundClear && y + 1 < H) {
            const j = i + W;
            if (subhexPx[j] === bSid) { foundAny = true; if (!aThick && !thick[j]) foundClear = true; }
          }
          if (!foundClear && y > 0) {
            const j = i - W;
            if (subhexPx[j] === bSid) { foundAny = true; if (!aThick && !thick[j]) foundClear = true; }
          }
        }
      }
      // foundAny && !foundClear means every adjacency was blocked by thick
      // river. Block the edge. (foundAny == false means the two subhexes
      // aren't actually pixel-adjacent — shouldn't happen for true graph
      // neighbors, but if it does, leave the edge alone.)
      if (foundAny && !foundClear) BLOCKED_SUBHEX_EDGES.add(`${aSid}|${bSid}`);
    }
  }
}

function isSubhexEdgeBlocked(aSid, bSid) {
  if (!BLOCKED_SUBHEX_EDGES) return false;
  const lo = aSid < bSid ? aSid : bSid;
  const hi = aSid < bSid ? bSid : aSid;
  return BLOCKED_SUBHEX_EDGES.has(`${lo}|${hi}`);
}

// Rasterize a list of map layers into a single binary mask. A pixel counts
// as set if it has meaningful alpha (cutoff 32/255 catches anti-aliased
// edges) in ANY of the source layers — i.e. the layers are OR'd together.
// Returns null if none of the layers loaded.
function buildBinaryMaskFromLayers(layerIds, alphaThreshold) {
  const sources = layerIds.map(id => IMAGES[id]).filter(Boolean);
  if (sources.length === 0) return null;
  const W = sources[0].naturalWidth, H = sources[0].naturalHeight;
  const mask = new Uint8Array(W * H);
  const thr = (alphaThreshold == null) ? 32 : alphaThreshold;
  for (const img of sources) {
    const c = document.createElement("canvas");
    c.width = W; c.height = H;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const px = ctx.getImageData(0, 0, W, H).data;
    for (let i = 0, j = 0; i < mask.length; i++, j += 4) {
      if (px[j + 3] > thr) mask[i] = 1;
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
  // Thickness is computed from a STRICTER river mask that only counts strongly
  // opaque pixels. The rivers.png artwork uses anti-aliasing, so a line drawn
  // 1-pixel-wide ends up as a 3-pixel-wide blob in the default-threshold
  // mask (full-opacity core + two AA edges), which the ≥3-neighbor rule
  // then misclassified as thick. By raising the alpha cutoff for the
  // thickness input, we strip the AA halo and a true 1-pixel river stays
  // 1-pixel-wide → THIN, while a true 2+-pixel river still has enough
  // opaque core to mark its interior as THICK.
  // Use a near-opaque alpha cutoff (> 230) so the strict river mask only
  // captures pixels at the SOLID core of each painted stroke. The artwork
  // anti-aliases river edges quite aggressively — at the previous cutoff
  // (160) a line drawn 1-pixel-wide rasterized to 3 strict-mask pixels per
  // row (opaque center + 2 still-mostly-opaque AA shoulders), which the
  // ≥3-neighbor thickness rule promptly classified as thick. With > 230
  // only the fully-painted center pixel survives, so a 1-px stroke stays
  // 1-px in the strict mask and reads as thin.
  STRICT_RIVER_PIXEL_MASK = buildBinaryMaskFromLayers(["rivers"], 230);
  THICK_RIVER_PIXEL_MASK = buildThickRiverMask(STRICT_RIVER_PIXEL_MASK);
  // No dilation: the previous halo step was blanket-extending the impassable
  // zone by 1 px in every direction, which is what blocked 1-px tributaries
  // running near a wider river. Routing now uses exactly the thick-core mask.
  THICK_RIVER_BLOCKING_MASK = THICK_RIVER_PIXEL_MASK;
  // Visualization companion: thin rivers expanded into their own AA halo
  // (stopping at any thick pixel). Used by drawDebugRiverTypes only.
  THIN_RIVER_EXPANDED_MASK = buildThinRiverExpandedMask(STRICT_RIVER_PIXEL_MASK, THICK_RIVER_PIXEL_MASK);
}

// One-pixel 4-connected binary-mask dilation. Returns a NEW mask. Used to
// blanket the immediate neighborhood of thick river pixels (anti-aliasing
// halo + bank pixels) so A* can't thread the gap.
function dilateMaskOnce(mask, W, H) {
  const out = new Uint8Array(mask);
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      const i = row + x;
      if (mask[i]) continue;
      if (x > 0       && mask[i - 1]) { out[i] = 1; continue; }
      if (x + 1 < W   && mask[i + 1]) { out[i] = 1; continue; }
      if (y > 0       && mask[i - W]) { out[i] = 1; continue; }
      if (y + 1 < H   && mask[i + W]) { out[i] = 1; continue; }
    }
  }
  return out;
}

// Per-pixel "thick river" mask. A river pixel is THICK iff it has 3 or more
// 4-connected river neighbors — that's the signature of a wider-than-1-pixel
// stretch (one perpendicular neighbor on top of the along-flow ones) or a
// junction. A 1-pixel-wide river has at most 2 river neighbors per pixel
// regardless of how it curves, so L-shaped corners and diagonal step-ladders
// stay THIN (fordable). T-junctions show up as thick, which is fine — you
// can't realistically ford right at a tributary confluence anyway.
//
// The route mask in routeThroughMask treats THICK pixels as impassable; the
// pre-built BLOCKED_SUBHEX_EDGES extends the same rule to dijkstraSubhexPath
// so the router avoids hexes the line couldn't have rendered anyway.
function buildThickRiverMask(riverMask) {
  if (!riverMask) return null;
  let W = 0, H = 0;
  for (const id of ["rivers", "roads", "ctf", "continent", "terrain", "sea"]) {
    if (IMAGES[id]) { W = IMAGES[id].naturalWidth; H = IMAGES[id].naturalHeight; break; }
  }
  if (W === 0 || H === 0) return null;
  const N = W * H;
  // Chebyshev distance transform: dist[i] = Chebyshev distance from pixel i
  // to the nearest non-river pixel. We use the 2-pass algorithm with
  // 8-neighbor lookups. Capped at CAP because we only need to know whether
  // distance ≥ 3 (the "thick core" threshold below) — anything larger gets
  // saturated. Non-river pixels start at 0; river pixels start at CAP and
  // get reduced as they pick up a smaller "neighbor distance + 1".
  const CAP = 6;
  const dist = new Uint8Array(N);
  for (let i = 0; i < N; i++) dist[i] = riverMask[i] ? CAP : 0;
  // Forward pass (top-left → bottom-right).
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (dist[i] === 0) continue;
      let best = dist[i];
      if (y > 0)              best = Math.min(best, dist[i - W] + 1);
      if (y > 0 && x > 0)     best = Math.min(best, dist[i - W - 1] + 1);
      if (y > 0 && x + 1 < W) best = Math.min(best, dist[i - W + 1] + 1);
      if (x > 0)              best = Math.min(best, dist[i - 1] + 1);
      dist[i] = best;
    }
  }
  // Backward pass (bottom-right → top-left).
  for (let y = H - 1; y >= 0; y--) {
    for (let x = W - 1; x >= 0; x--) {
      const i = y * W + x;
      if (dist[i] === 0) continue;
      let best = dist[i];
      if (y + 1 < H)              best = Math.min(best, dist[i + W] + 1);
      if (y + 1 < H && x + 1 < W) best = Math.min(best, dist[i + W + 1] + 1);
      if (y + 1 < H && x > 0)     best = Math.min(best, dist[i + W - 1] + 1);
      if (x + 1 < W)              best = Math.min(best, dist[i + 1] + 1);
      dist[i] = best;
    }
  }
  // Core threshold: distance ≥ 3 means the pixel sits inside a 7×7 all-river
  // box (Chebyshev disc radius 3), which only happens when the river is at
  // least ~5–6 pixels wide perpendicular to its flow. A 3-pixel-wide river
  // ("1 logical pixel" at the artwork's 3× scale) peaks at distance 2 so no
  // pixel makes core — it stays fully thin. A 6-pixel-wide river ("2 logical
  // pixels", the user's stated thick threshold) reaches distance 3 in its
  // center two rows so those pixels register as core.
  const core = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if (dist[i] >= 3) core[i] = 1;
  }
  // Two-iteration 8-connected closure to promote the river's edge pixels to
  // thick. We need 2 iters because the core lives 2 Chebyshev steps inside
  // the river surface — a single closure round only pulls in the row right
  // next to core, not the outer row. Each iter reads the previous iter's
  // output, so promotion does NOT cascade into adjacent thin tributaries
  // (those don't have core pixels of their own; only their direct connection
  // pixels to the wide river get promoted, and that promotion stops there
  // because further tributary pixels read core[] = 0).
  let out = new Uint8Array(core);
  for (let iter = 0; iter < 2; iter++) {
    const src = out;
    const next = new Uint8Array(src);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (next[i]) continue;
        if (!riverMask[i]) continue;
        const xL = x > 0, xR = x + 1 < W, yU = y > 0, yD = y + 1 < H;
        let touches = false;
        if (xR && src[i + 1]) touches = true;
        else if (xL && src[i - 1]) touches = true;
        else if (yD && src[i + W]) touches = true;
        else if (yU && src[i - W]) touches = true;
        else if (xR && yD && src[i + W + 1]) touches = true;
        else if (xL && yD && src[i + W - 1]) touches = true;
        else if (xR && yU && src[i - W + 1]) touches = true;
        else if (xL && yU && src[i - W - 1]) touches = true;
        if (touches) next[i] = 1;
      }
    }
    out = next;
  }
  // Additional 3-pixel outward expansion to close visual gaps and absorb
  // anti-aliased halos. Eats anything in the inclusive river mask within
  // 3 px of an existing thick pixel — including strict-thin pixels that
  // happen to sit next to a thick stretch (they're treated as "thin
  // patches inside a wide river" and pulled into thick). The "equal and
  // opposite" green expansion below restores genuine thin rivers that
  // still have surviving strict-thin pixels of their own after this pass.
  const inclusiveBound = RIVER_PIXEL_MASK || riverMask;
  for (let iter = 0; iter < 3; iter++) {
    const src = out;
    const next = new Uint8Array(src);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (next[i]) continue;
        if (!inclusiveBound[i]) continue;
        const xL = x > 0, xR = x + 1 < W, yU = y > 0, yD = y + 1 < H;
        let touches = false;
        if (xR && src[i + 1]) touches = true;
        else if (xL && src[i - 1]) touches = true;
        else if (yD && src[i + W]) touches = true;
        else if (yU && src[i - W]) touches = true;
        else if (xR && yD && src[i + W + 1]) touches = true;
        else if (xL && yD && src[i + W - 1]) touches = true;
        else if (xR && yU && src[i - W + 1]) touches = true;
        else if (xL && yU && src[i - W - 1]) touches = true;
        if (touches) next[i] = 1;
      }
    }
    out = next;
  }
  return out;
}

// Build the "green" thin-river expansion for the debug visualization. Takes
// the strict mask (alpha > 230 river pixels that didn't get promoted to
// thick) and grows it 3 pixels outward into AA-halo territory, but stops at
// any pixel that's already in the thick mask. Result: thin rivers also get
// their AA gaps closed visually, while the boundary against thick rivers
// stays exactly where buildThickRiverMask put it.
function buildThinRiverExpandedMask(strictMask, thickMask) {
  if (!strictMask || !RIVER_PIXEL_MASK) return null;
  let W = 0, H = 0;
  for (const id of ["rivers", "roads", "ctf", "continent", "terrain", "sea"]) {
    if (IMAGES[id]) { W = IMAGES[id].naturalWidth; H = IMAGES[id].naturalHeight; break; }
  }
  if (W === 0 || H === 0) return null;
  // Start with strict-thin pixels (strict ∖ thick).
  const out = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    if (strictMask[i] && !(thickMask && thickMask[i])) out[i] = 1;
  }
  // Expand 3 iterations into inclusive-but-not-strict-and-not-thick pixels.
  // Mirrors the red expansion but bounded so it can't eat into thick either.
  for (let iter = 0; iter < 3; iter++) {
    const src = new Uint8Array(out);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (out[i]) continue;
        if (!RIVER_PIXEL_MASK[i]) continue;
        if (strictMask[i]) continue;                       // strict pixels handled at init
        if (thickMask && thickMask[i]) continue;            // never eat into thick
        const xL = x > 0, xR = x + 1 < W, yU = y > 0, yD = y + 1 < H;
        let touches = false;
        if (xR && src[i + 1]) touches = true;
        else if (xL && src[i - 1]) touches = true;
        else if (yD && src[i + W]) touches = true;
        else if (yU && src[i - W]) touches = true;
        else if (xR && yD && src[i + W + 1]) touches = true;
        else if (xL && yD && src[i + W - 1]) touches = true;
        else if (xR && yU && src[i - W + 1]) touches = true;
        else if (xL && yU && src[i - W - 1]) touches = true;
        if (touches) out[i] = 1;
      }
    }
  }
  return out;
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

// Walk every road/city pixel and bucket it by the subhex it lies inside. The
// resulting ROAD_SUBHEXES set is the per-subhex equivalent of HEX_HAS_ROAD —
// it tells dijkstra which subhexes act as "roads" so the road weight only
// applies to those subhexes (not the whole hex). Pixel-driven: there is no
// spreadsheet flag; if the artwork paints a road pixel inside a subhex, that
// subhex is a road subhex.
function precomputeRoadSubhexes() {
  ROAD_SUBHEXES = new Set();
  if (!HEX_ROAD_PIXELS || !SUBHEX_ID_PX) return;
  for (const arr of HEX_ROAD_PIXELS.values()) {
    for (let i = 0; i < arr.length; i++) {
      const sid = SUBHEX_ID_PX[arr[i]];
      if (sid) ROAD_SUBHEXES.add(sid);
    }
  }
}

// Effective traversal weight for one COMPONENT of a subhex. A component is
// the unit dijkstra navigates: road and non-road pixels of the same subhex
// form distinct components (see precomputeSubhexComponents), so we can
// charge the road weight only when actually routing through the road's
// component, not when crossing through the surrounding land. Road components
// bill the road column keyed by the parent hex's terrain (so road through
// Mountains still costs more than road through Flatlands). Land / naval
// components bill the standard weight for the subhex's class.
// Min-heap with a deterministic FIFO tie-breaker. Items are
// [priority, seq, ...payload]. When two items have the same priority,
// the one pushed earlier (lower seq) pops first. Used by dijkstra so
// equal-cost paths resolve to the same one regardless of which
// non-chosen intermediate states happened to be in the heap when the
// final goal-state was popped — fixes "changing an unused class's
// weight reshuffles the route" by making tie-breaking class-independent.
class MinHeap2 {
  constructor() { this.h = []; this._seq = 0; }
  size() { return this.h.length; }
  push(item) {
    // Inject a monotonic seq at slot 1 so callers don't have to
    // manage it themselves. Payload starts at slot 2.
    item.splice(1, 0, this._seq++);
    this.h.push(item); this._up(this.h.length - 1);
  }
  pop() {
    const top = this.h[0], last = this.h.pop();
    if (this.h.length > 0) { this.h[0] = last; this._down(0); }
    return top;
  }
  _cmp(a, b) {
    if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
    return a[1] - b[1];
  }
  _up(i) {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this._cmp(this.h[p], this.h[i]) <= 0) break;
      [this.h[p], this.h[i]] = [this.h[i], this.h[p]];
      i = p;
    }
  }
  _down(i) {
    const n = this.h.length;
    while (true) {
      const l = 2 * i + 1, r = 2 * i + 2;
      let m = i;
      if (l < n && this._cmp(this.h[l], this.h[m]) < 0) m = l;
      if (r < n && this._cmp(this.h[r], this.h[m]) < 0) m = r;
      if (m === i) break;
      [this.h[m], this.h[i]] = [this.h[i], this.h[m]];
      i = m;
    }
  }
}

function componentEffectiveWeight(sub, compId) {
  if (!sub) return NaN;
  if (compId && ROAD_COMPONENTS && ROAD_COMPONENTS.has(`${sub.id}:${compId}`)) {
    // The road discount only applies if the road component is big
    // enough to be meaningfully "on the road". A scrap of road sticking
    // a few pixels into a hex shouldn't make the whole hex cheap —
    // dijkstra would otherwise prefer routes that brush such scraps
    // even though the line would barely use them. The threshold is the
    // same MIN_PIXELS_PER_PATH_HEX the user controls in the Path-line
    // panel — that way it doubles as the "min size for a road node to
    // count" knob.
    const pixCount = SUBHEX_COMPONENT_PIXEL_COUNT
      ? (SUBHEX_COMPONENT_PIXEL_COUNT.get(`${sub.id}:${compId}`) || 0)
      : 0;
    if (pixCount >= MIN_PIXELS_PER_PATH_HEX) {
      const pt = HEX_TERRAIN ? canonicalHexTerrain(HEX_TERRAIN.get(sub.hex)) : null;
      if (pt) {
        const rw = +roadWeights[pt];
        if (isFinite(rw) && rw > 0) return rw;
      }
    }
    // Below threshold — fall through to the class weight below, billing
    // this road scrap at land weight instead.
  }
  const canon = canonicalSubhexClass(sub);
  const w = +weights[canon];
  return isFinite(w) ? w : NaN;
}

// Subhex-level effective weight — the CHEAPEST any of its components could
// be. Used by mask-inclusion checks (buildSubhexMaskForHexPath) where we
// don't have a component on hand and want "would this subhex be admitted
// at all?". A subhex with a road component answers with the road weight
// (cheapest); a pure land/naval subhex answers with its canonical class
// weight (Plains→Flatlands, Peaks→Mountains, naval Sea→parent terrain).
function subhexEffectiveWeight(sub) {
  if (!sub) return NaN;
  if (ROAD_SUBHEXES && ROAD_SUBHEXES.has(sub.id)) {
    const pt = HEX_TERRAIN ? canonicalHexTerrain(HEX_TERRAIN.get(sub.hex)) : null;
    if (pt) {
      const rw = +roadWeights[pt];
      if (isFinite(rw) && rw > 0) return rw;
    }
  }
  const canon = canonicalSubhexClass(sub);
  const w = +weights[canon];
  return isFinite(w) ? w : NaN;
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
    const uTerrain = HEX_TERRAIN ? canonicalHexTerrain(HEX_TERRAIN.get(u)) : null;
    const uIsWater = uTerrain ? WATER_TERRAINS.has(uTerrain) : false;
    for (const v of hexNeighbors(u)) {
      const vTerrain = HEX_TERRAIN ? canonicalHexTerrain(HEX_TERRAIN.get(v)) : null;
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
    const uTerrain = HEX_TERRAIN ? canonicalHexTerrain(HEX_TERRAIN.get(u)) : null;
    const uIsWater = uTerrain ? WATER_TERRAINS.has(uTerrain) : false;
    for (const v of hexNeighbors(u)) {
      const vTerrain = HEX_TERRAIN ? canonicalHexTerrain(HEX_TERRAIN.get(v)) : null;
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

// Subhex-component-level Dijkstra under the per-subhex EFFECTIVE-WEIGHT cost
// model. Each node is (subhex, component, runningMax-in-current-hex). Cost is
// paid per HEX TRANSITION; within a hex, walking between subhexes is free but
// updates the running max of subhex effective weights visited inside that
// hex. When we cross into a new hex, we pay the previous hex's running max
// (0 if we never left the start hex) and start a fresh max for the new hex.
//
// Subhex effective weight (see subhexEffectiveWeight):
//   * Road subhexes (any subhex containing road/city pixels)
//       → roadWeights[parentHex.terrain]
//   * Naval / land subhexes
//       → weights[subhex.class]
//
// This is what makes the cost track the actual subhex sequence: dijkstra
// only gets the road discount when its chosen path passes THROUGH a road
// subhex of a hex. A hex whose road runs in a direction dijkstra isn't using
// no longer looks like a shortcut — dijkstra has to bill the non-road
// subhexes it actually crosses.
//
// Embark cost (weights["Embark"]) is still added on every naval/non-naval
// subhex-class boundary, unchanged.
//
// Component-aware semantics (unchanged from before):
//   * To exit a subhex, you must use a clear (non-thick) border pixel pair.
//   * A thick river bisecting a subhex creates 2+ components; dijkstra
//     traverses between them only through legitimate border pairs.
//
// Node-state key: "subhexId:componentId|runningMax". The runningMax is the
// numeric effective weight (a small float like 0.5, 1, 2, 5). Distinct max
// values for the same (subhex, component) are distinct nodes — necessary
// for dominance to work right when a heavier-max path arrives first but a
// lighter-max path is strictly cheaper later in the same hex.
function dijkstraSubhexPath(fromSubId, toSubId, fromPixelIdx, toPixelIdx) {
  if (fromSubId == null || toSubId == null) return null;
  if (!NEIGHBORS) return null;
  const fromSub = SUBHEX_INDEX.get(fromSubId);
  const toSub   = SUBHEX_INDEX.get(toSubId);
  if (!fromSub || !toSub) return null;
  const fromComp = subhexComponentAt(fromSubId, fromPixelIdx);
  const toComp   = subhexComponentAt(toSubId,   toPixelIdx);
  if (fromSubId === toSubId && fromComp === toComp) {
    return {
      path: [fromSubId],
      hexWeights: new Map(),
      pathRoadHexes: new Set(),
      pathComponents: new Set([`${fromSubId}:${fromComp}`]),
      totalCost: 0,
    };
  }

  const startW = componentEffectiveWeight(fromSub, fromComp);
  if (!isFinite(startW)) return null;
  const startKey = `${fromSubId}:${fromComp}|${startW}`;

  const dist = new Map();
  const prev = new Map();        // node key -> previous node key
  // MinHeap2 is a min-heap with FIFO tie-breaking by insertion order.
  // That stabilises which equal-cost path dijkstra picks — important so
  // tweaking an unused class's weight doesn't reshuffle the chosen
  // route just because intermediate heap exploration touched it.
  const heap = new MinHeap2();
  dist.set(startKey, 0);
  // Heap payload: [d, sid, comp, maxInHex, hexId, isStart]. MinHeap2
  // injects a sequence number at slot 1 automatically; pop returns
  // [d, seq, sid, comp, maxInHex, hexId, isStart].
  heap.push([0, fromSubId, fromComp, startW, fromSub.hex, true]);

  let bestTotal = Infinity, bestKey = null;

  while (heap.size() > 0) {
    const [d, , uSid, uComp, uMax, uHex, uIsStart] = heap.pop();
    if (d >= bestTotal) break;
    const uKey = `${uSid}:${uComp}|${uMax}`;
    if (d > (dist.get(uKey) ?? Infinity)) continue;

    if (uSid === toSubId && uComp === toComp) {
      // Close out the destination hex: pay running max (0 if we never left
      // the start hex). This matches "every non-start hex billed at max of
      // its visited component effective weights".
      const close = uIsStart ? 0 : uMax;
      const total = d + close;
      if (total < bestTotal) { bestTotal = total; bestKey = uKey; }
      continue;
    }

    const uSub = SUBHEX_INDEX.get(uSid);
    if (!uSub) continue;
    const uIsNaval = WATER_TERRAINS.has(uSub.class);
    const compNeighbors = SUBHEX_COMPONENT_NEIGHBORS && SUBHEX_COMPONENT_NEIGHBORS.get(`${uSid}:${uComp}`);
    if (!compNeighbors) continue;

    for (const vKey of compNeighbors) {
      const colon = vKey.indexOf(":");
      const vSid = +vKey.slice(0, colon);
      const vComp = +vKey.slice(colon + 1);
      const vSub = SUBHEX_INDEX.get(vSid);
      if (!vSub) continue;
      const vW = componentEffectiveWeight(vSub, vComp);
      if (!isFinite(vW) || vW <= 0) continue;
      const vIsNaval = WATER_TERRAINS.has(vSub.class);
      const vIsRoad  = ROAD_COMPONENTS && ROAD_COMPONENTS.has(`${vSid}:${vComp}`);
      // Assigned-weight restriction for LAND components only: a land
      // component (non-road, non-naval) is impassable if its class
      // weight exceeds the parent hex's assigned terrain weight. So a
      // Mountains subhex inside a Flatlands hex is unreachable by
      // dijkstra. Road components and naval components ignore this gate
      // (road can cut through any terrain at the road weight; naval
      // routes obey the embark rule). The destination is exempt — if
      // the user clicked into a heavy land subhex, we still need to
      // reach it; we just can't TRANSIT through other heavy land.
      const isDestination = (vSid === toSubId && vComp === toComp);
      if (!vIsRoad && !vIsNaval && !isDestination) {
        const vT = HEX_TERRAIN ? canonicalHexTerrain(HEX_TERRAIN.get(vSub.hex)) : null;
        const vHexW = vT ? +weights[vT] : NaN;
        if (isFinite(vHexW) && vW > vHexW) continue;
      }

      let nd, nMax, nHex, nIsStart;
      if (vSub.hex === uHex) {
        // Same hex — free transition; the only thing that changes is the
        // running max of effective weights inside this hex.
        nd = d;
        nMax = (uMax >= vW) ? uMax : vW;
        nHex = uHex;
        nIsStart = uIsStart;
      } else {
        // Crossing into a new hex — pay the leaving hex's running max
        // (0 if still in start), reset the max to v's effective weight.
        const close = uIsStart ? 0 : uMax;
        nd = d + close;
        nMax = vW;
        nHex = vSub.hex;
        nIsStart = false;
      }
      if (uIsNaval !== vIsNaval) {
        // Embark — naval (Sea/Lake/Ocean) ↔ land crossing. Always
        // charged on a naval-class boundary, regardless of whether the
        // surrounding hex is a ferry hex. Naval is its own concept,
        // independent of ferry semantics.
        const e = +weights["Embark"];
        if (isFinite(e) && e > 0) nd += e;
      }
      // Ferry — only triggered when actually crossing thick-river
      // pixels. The component graph encodes this via
      // THICK_RIVER_COMPONENTS (populated in ferry hexes, where the
      // flood admits thick pixels into components). A "boarding"
      // transition is one going FROM a non-thick-touching component
      // INTO a thick-touching component — that's the moment we step
      // onto the ferry. Disembarking (thick → non-thick) doesn't add
      // anything, so a full crossing (non-thick → thick → non-thick)
      // costs exactly one Ferry. A path that passes through a ferry
      // hex on the road WITHOUT ever entering a thick-touching
      // component (e.g. road runs along the bank without crossing the
      // river artwork) pays no Ferry, matching countFerryCrossings.
      if (THICK_RIVER_COMPONENTS) {
        const uTouchesThick = THICK_RIVER_COMPONENTS.has(`${uSid}:${uComp}`);
        const vTouchesThick = THICK_RIVER_COMPONENTS.has(`${vSid}:${vComp}`);
        if (vTouchesThick && !uTouchesThick) {
          const f = +weights["Ferry"];
          if (isFinite(f) && f > 0) nd += f;
        }
      }
      const nKey = `${vSid}:${vComp}|${nMax}`;
      if (nd < (dist.get(nKey) ?? Infinity)) {
        dist.set(nKey, nd);
        prev.set(nKey, uKey);
        heap.push([nd, vSid, vComp, nMax, nHex, nIsStart]);
      }
    }
  }
  if (bestKey == null) return null;
  // Reconstruct the (sid, comp) sequence in order. We need both pieces so
  // we can (a) build the deduplicated sid path for downstream consumers,
  // (b) derive per-hex max effective weight, and (c) note which hexes were
  // entered through a road component (so the renderer's road-restriction
  // pass knows which hexes to snap to road pixels).
  const keys = [];
  let cur = bestKey;
  while (cur != null) {
    keys.push(cur);
    if (cur === startKey) break;
    cur = prev.get(cur);
  }
  keys.reverse();
  const path = [];
  const hexWeights = new Map();
  const pathRoadHexes = new Set();
  const pathComponents = new Set();   // "sid:comp" strings dijkstra actually traversed
  let lastSid = -1;
  for (const k of keys) {
    const colon = k.indexOf(":");
    const pipe  = k.indexOf("|");
    const sid   = +k.slice(0, colon);
    const comp  = +k.slice(colon + 1, pipe);
    const sub   = SUBHEX_INDEX.get(sid);
    if (!sub) continue;
    if (sid !== lastSid) { path.push(sid); lastSid = sid; }
    pathComponents.add(`${sid}:${comp}`);
    const w = componentEffectiveWeight(sub, comp);
    if (isFinite(w)) {
      const prevW = hexWeights.get(sub.hex);
      if (prevW == null || w > prevW) hexWeights.set(sub.hex, w);
    }
    if (ROAD_COMPONENTS && ROAD_COMPONENTS.has(`${sid}:${comp}`)) {
      pathRoadHexes.add(sub.hex);
    }
  }
  // totalCost is what dijkstra actually optimised — the same number we
  // should report so what the optimiser picks is what the user sees.
  // bestTotal already includes terrain (per-hex running max), embarks
  // for non-ferry naval transitions, and ferry surcharge per ferry hex.
  return { path, hexWeights, pathRoadHexes, pathComponents, totalCost: bestTotal };
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
    const terrain = HEX_TERRAIN ? canonicalHexTerrain(HEX_TERRAIN.get(hid)) : null;
    const hexW = terrain ? +weights[terrain] : NaN;
    if (!isFinite(hexW)) continue;
    const subs = SUBHEXES_BY_HEX.get(hid) || [];
    for (const sub of subs) {
      // Effective weight so road subhexes are admitted via roadWeights even
      // when their natural class would have been heavier than the hex's
      // assigned terrain (e.g., a stretch of road painted across a Plains
      // subhex inside a Flatlands hex still belongs in the mask).
      const sw = subhexEffectiveWeight(sub);
      if (isFinite(sw) && sw <= hexW) subSet.add(sub.id);
    }
  }
  return subSet;
}

// Minimum number of centerline pixels a hex needs along the rendered line
// before it counts as a "main" path hex. Tuned to absorb the kind of brief
// detour you get when the line dips into an adjacent hex for a handful of
// road pixels that bled across the hex border, without losing real path
// hexes (which are typically dozens of centerline pixels across). Mutable
// — bound to a slider in the Path-line settings so users can tune it for
// their own map's hex pixel size.
let MIN_PIXELS_PER_PATH_HEX = 10;

// Walk the rendered line pixel-by-pixel, count centerline pixels per hex,
// and return the hexes the line actually spends a meaningful stretch in
// (>= MIN_PIXELS_PER_PATH_HEX), in first-seen order. Also returns a per-hex
// max effective weight derived from the components the line went through —
// that's what the segment's cost should bill, since cost should match what
// the line actually traversed (not dijkstra's hex sequence, which can
// briefly enter adjacent hexes that the line passes through too quickly to
// matter).
//
// alwaysInclude is an iterable of hex ids that count regardless of how few
// pixels they have (start/end hexes — the user explicitly clicked them).
function countLineMainHexes(linePts, alwaysInclude) {
  const out = { hexPath: [], hexWeights: new Map(), allCrossed: new Set() };
  if (!linePts || linePts.length < 1 || !HEX_ID_PX || !SUBHEX_ID_PX || !SUBHEX_ID_IMG_DATA) return out;
  const W = SUBHEX_ID_IMG_DATA.width, H = SUBHEX_ID_IMG_DATA.height;
  const count    = new Map();
  const weightMx = new Map();
  const firstAt  = new Map();
  let seq = 0;
  const sample = (x, y) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const fullIdx = y * W + x;
    const hid = HEX_ID_PX[fullIdx];
    if (!hid) return;
    count.set(hid, (count.get(hid) || 0) + 1);
    if (!firstAt.has(hid)) firstAt.set(hid, seq);
    seq++;
    out.allCrossed.add(hid);
    const sid = SUBHEX_ID_PX[fullIdx];
    const sub = SUBHEX_INDEX.get(sid);
    if (!sub) return;
    const compId = SUBHEX_PIXEL_COMPONENT ? SUBHEX_PIXEL_COMPONENT[fullIdx] : 0;
    const w = componentEffectiveWeight(sub, compId);
    if (!isFinite(w)) return;
    const prev = weightMx.get(hid);
    if (prev == null || w > prev) weightMx.set(hid, w);
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
  // Force-include start/end (and anything else the caller pins). They get a
  // synthetic high pixel count so the threshold can't drop them.
  const pinned = new Set();
  if (alwaysInclude) for (const hid of alwaysInclude) { if (hid != null) pinned.add(hid); }
  const main = [];
  for (const [hid, c] of count) {
    if (pinned.has(hid) || c >= MIN_PIXELS_PER_PATH_HEX) main.push(hid);
  }
  // A pinned hex the line never crossed (e.g. start hex but the line starts
  // right at the click pixel without sampling that hex) — synthesize it.
  for (const hid of pinned) {
    if (!firstAt.has(hid)) {
      firstAt.set(hid, -1 - main.length);
      main.push(hid);
    }
  }
  main.sort((a, b) => firstAt.get(a) - firstAt.get(b));
  out.hexPath = main;
  for (const hid of main) {
    const w = weightMx.get(hid);
    if (isFinite(w)) out.hexWeights.set(hid, w);
  }
  return out;
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
    // Naval (Sea/Lake/Ocean) transitions ALWAYS trigger an embark
    // crossing — even inside a ferry hex. Naval and ferry are two
    // independent concepts; the ferry surcharge is for crossing
    // thick-river PIXELS (handled by countFerryCrossings), while
    // embark is for crossing the naval/non-naval CLASS boundary.
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

// Count ferry crossings along the rendered line. A ferry crossing only
// counts when the line ACTUALLY traverses a thick-river pixel inside a
// ferry hex — that's the moment you're "on the ferry, mid-crossing".
// Previously we'd bump the count for every distinct ferry hex the line
// entered, which over-counted in cases where the line skirted the edge
// of a ferry hex on dry road pixels without ever touching the river the
// ferry exists to cross. The set of "used" ferry hexes (returned via the
// second result) is also what the active-route debug overlay highlights.
function countFerryCrossings(linePts) {
  const result = { count: 0, used: new Set() };
  if (!linePts || linePts.length < 2 || !HEX_ID_PX
      || !SUBHEX_ID_IMG_DATA || !FERRY_HEXES
      || !THICK_RIVER_PIXEL_MASK) return result;
  const W = SUBHEX_ID_IMG_DATA.width, H = SUBHEX_ID_IMG_DATA.height;
  // Two phases: first walk the line and record, per ferry hex, whether
  // the line touched any thick-river pixel inside it. Then count one
  // crossing per ferry hex that DID touch the river. This naturally
  // dedupes back-and-forth re-entries (same hex counts once).
  const touchedRiver = new Map();   // hid -> bool
  const sample = (x, y) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const fullIdx = y * W + x;
    const hid = HEX_ID_PX[fullIdx];
    if (!hid || !FERRY_HEXES.has(hid)) return;
    if (THICK_RIVER_PIXEL_MASK[fullIdx]) touchedRiver.set(hid, true);
    else if (!touchedRiver.has(hid))     touchedRiver.set(hid, false);
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
  for (const [hid, touched] of touchedRiver) {
    if (touched) { result.count++; result.used.add(hid); }
  }
  return result;
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
      // Same-hex: pathRoadHexes is just "this hex, if either endpoint
      // pixel lies on a road component". That gates road-restriction
      // for an in-hex segment the same way dijkstra's pathRoadHexes
      // does for cross-hex segments.
      const sameHexPathRoadHexes = new Set();
      const _W = SUBHEX_ID_IMG_DATA ? SUBHEX_ID_IMG_DATA.width : 0;
      if (_W > 0 && SUBHEX_PIXEL_COMPONENT && ROAD_COMPONENTS) {
        const aIdx = (wa.px.y | 0) * _W + (wa.px.x | 0);
        const bIdx = (wb.px.y | 0) * _W + (wb.px.x | 0);
        const aComp = SUBHEX_PIXEL_COMPONENT[aIdx] | 0;
        const bComp = SUBHEX_PIXEL_COMPONENT[bIdx] | 0;
        if ((aComp && ROAD_COMPONENTS.has(`${wa.subhexId}:${aComp}`)) ||
            (bComp && ROAD_COMPONENTS.has(`${wb.subhexId}:${bComp}`))) {
          sameHexPathRoadHexes.add(wa.hexId);
        }
      }
      linePts = routeThroughMask(new Set([wa.subhexId, wb.subhexId]), {
        fromId: wa.subhexId, toId: wb.subhexId,
        fromPx: wa.px,       toPx: wb.px,
        pathHexIds: [wa.hexId],
        subhexPath: [wa.subhexId, wb.subhexId],
        pathRoadHexes: sameHexPathRoadHexes,
        debugSink: {},
      });
      if (!linePts || linePts.length === 0) {
        linePts = [{ x: wa.px.x, y: wa.px.y }, { x: wb.px.x, y: wb.px.y }];
      }
    }
    const embarks = countSubhexEmbarks(linePts);
    const fr      = countFerryCrossings(linePts);
    const ferries = fr.count;
    const usedFerryHexes = fr.used;
    return {
      hexIds: [wa.hexId],
      subhexIds: new Set([wa.subhexId, wb.subhexId]),
      cost: embarks * (+weights["Embark"]) + ferries * (+weights["Ferry"]),
      embarks,
      ferries,
      usedFerryHexes,
      sameHex: true, reachable: true,
      linePts,
      debugMask: null,
    };
  }
  const fromSub = SUBHEX_INDEX.get(wa.subhexId);
  const toSub   = SUBHEX_INDEX.get(wb.subhexId);
  if (!fromSub || !toSub) {
    return { hexIds: [], subhexIds: new Set(), cost: 0, embarks: 0, ferries: 0,
             sameHex: false, reachable: false, linePts: null, debugMask: null };
  }
  // Run the subhex-level Dijkstra so the router itself accounts for naval
  // boundary crossings (not just the post-hoc tally). This is what makes
  // it choose the longer pure-land detour over the straight-line sea cut
  // when the latter would rack up multiple embarks.
  // Pass the click-pixel indices so component-aware Dijkstra knows WHICH
  // side of an internal river bisection the user clicked on. Without this,
  // the start/end component picks whatever the bbox scan finds first, which
  // is fine for the common (single-component) subhex but wrong when a
  // thick river runs straight through the start or end hex.
  const W = SUBHEX_ID_IMG_DATA ? SUBHEX_ID_IMG_DATA.width : 0;
  const fromPixIdx = (W > 0) ? ((wa.px.y | 0) * W + (wa.px.x | 0)) : null;
  const toPixIdx   = (W > 0) ? ((wb.px.y | 0) * W + (wb.px.x | 0)) : null;
  const djk = dijkstraSubhexPath(wa.subhexId, wb.subhexId, fromPixIdx, toPixIdx);
  if (!djk) {
    return { hexIds: [], subhexIds: new Set(), cost: 0, embarks: 0, ferries: 0,
             sameHex: false, reachable: false, linePts: null, debugMask: null };
  }
  // Unpack: subhexPath is the sid sequence; hexWeights gives the per-hex
  // max effective weight along the actual (component-aware) chosen path
  // — used directly for terrainCost so dijkstra's cost and the rendered
  // segment's cost can't drift apart. pathRoadHexes lists hexes whose
  // chosen path went through a road component — routeThroughMask uses
  // this to decide which hexes restrict() should snap to road pixels.
  const subhexPath    = djk.path;
  const hexWeights    = djk.hexWeights;
  const pathRoadHexes = djk.pathRoadHexes;
  const pathComponents = djk.pathComponents;
  const dijkstraTotalCost = djk.totalCost;
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
  // Mask: chosen subhexes, plus same-hex NON-naval expansion for A* maneuver
  // room. Naval expansion is intentionally NOT done: even when Dijkstra
  // touches a naval subhex in a hex (e.g. the endpoint sits on the shore),
  // other naval subhexes of the same hex stay out of the mask. Otherwise a
  // small lake inside a Land hex on the path would get every Sea subhex
  // dumped into the route's display + drawing mask just because some other
  // naval subhex in the hex was used.
  const subSet = new Set(subhexPath);
  if (wa.subhexId != null) subSet.add(wa.subhexId);
  if (wb.subhexId != null) subSet.add(wb.subhexId);
  const hexHasNonNaval = new Set();    // hex_id where Dijkstra used a non-naval subhex
  for (const sid of subhexPath) {
    const sub = SUBHEX_INDEX.get(sid);
    if (!sub) continue;
    if (!WATER_TERRAINS.has(sub.class)) hexHasNonNaval.add(sub.hex);
  }
  for (const hid of hexHasNonNaval) {
    const subs = SUBHEXES_BY_HEX.get(hid) || [];
    for (const sub of subs) {
      // Naval subhexes are NOT expanded into subSet, even for ferry hexes.
      // A naval subhex only ends up in subSet if Dijkstra explicitly picked
      // it (via the initial `new Set(subhexPath)`). Otherwise the line
      // shouldn't drift into the Sea — the cheaper river-ferry route stays
      // strictly inside its Plains subhex. The Stage-3 ferry fallback in
      // restrict() still covers the case where Dijkstra *did* choose a sea
      // crossing: navalPx gets restored only if road+thick can't bridge.
      if (WATER_TERRAINS.has(sub.class)) continue;
      subSet.add(sub.id);
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
    subhexPath,            // dijkstra's chosen subhex sequence (deduped)
    pathRoadHexes,         // hexes whose chosen component was a road component
    pathComponents,        // exact "sid:comp" strings dijkstra traversed
    debugSink,
    // Always broaden to adjacents from the start. The per-tier sequence
    // inside routeThroughMask handles the priority — path road, path
    // thin, path ferry are tried before adj road kicks in. Without this
    // pre-set, the "adj road" tier would never fire on the first pass
    // and the route would jump straight to path-full when path-road
    // alone didn't span.
    useAdjacents: false,  // legacy flag; adj broadening is gone
  };
  // Run the strict pass — tiers internally fall through path → adj road →
  // path full → adj full as connectivity demands. If still no line, fall
  // back to opening every non-naval subhex of every path hex.
  let linePts = routeThroughMask(subSet, ctx);
  if ((!linePts || linePts.length === 0) && hexPath.length > 0) {
    const fallback = new Set();
    if (wa.subhexId != null) fallback.add(wa.subhexId);
    if (wb.subhexId != null) fallback.add(wb.subhexId);
    for (const sid of subhexPath) fallback.add(sid);
    for (const hid of hexPath) {
      for (const sub of (SUBHEXES_BY_HEX.get(hid) || [])) {
        if (WATER_TERRAINS.has(sub.class)) continue;
        fallback.add(sub.id);
      }
    }
    linePts = routeThroughMask(fallback, ctx);
  }

  // Hex count + per-hex cost come from the RENDERED LINE, not from
  // dijkstra's chosen sequence. Dijkstra picks a hex sequence by cost; the
  // line A*'s through the resulting mask and sometimes dips a few pixels
  // into an adjacent hex to follow a road bleed. Those brief detours
  // should not count as "path hexes" for the user-facing counter or for
  // distance — they ARE in the dijkstra sequence (or in adj-broadening
  // territory) but the user perceives them as part of the same path
  // through the main hex. Filter by MIN_PIXELS_PER_PATH_HEX so a hex only
  // counts when the line actually spends a meaningful stretch there.
  // Embark / ferry counts come from the rendered line so the UI matches
  // the visible line.
  const embarks    = linePts ? countSubhexEmbarks(linePts)   : 0;
  const ferryRes   = linePts ? countFerryCrossings(linePts)  : { count: 0, used: new Set() };
  const ferries    = ferryRes.count;
  const usedFerryHexes = ferryRes.used;

  // Line-derived per-hex max effective weight — what the line actually
  // traverses, pixel by pixel. We use this as the COST source rather
  // than dijkstra's bestTotal because the rendered line can diverge
  // from dijkstra's chosen component sequence (the mask may expand to
  // fullhex via tier 10 to bridge an artwork gap, and A* then takes a
  // shorter pixel path through that wider mask). Cost should reflect
  // what's visible, not what dijkstra optimised toward.
  const lineMain = countLineMainHexes(linePts);

  // Combined per-hex cost: prefer the line-derived value (line actually
  // crossed pixels there), fall back to dijkstra's hexWeights for hexes
  // dijkstra picked but the line skipped (rare — usually the start
  // hex where the centerline never samples).
  let terrainCost = 0;
  for (let i = 1; i < hexPath.length; i++) {
    const hid = hexPath[i];
    let w = lineMain.hexWeights.get(hid);
    if (!isFinite(w)) w = hexWeights.get(hid);
    if (isFinite(w)) terrainCost += w;
  }
  const embarkCost = embarks * (+weights["Embark"]);
  const ferryCost  = ferries * (+weights["Ferry"]);

  return {
    hexIds: hexPath,           // dijkstra's hex sequence — drives count, distance, breakdown
    subhexIds: subSet,
    subhexPath,                // dijkstra's chosen subhex sequence (NOT the expanded mask)
    pathRoadHexes,             // hexes dijkstra routed via a road component
    pathComponents,            // exact "sid:comp" strings dijkstra traversed
    lineHexPath: lineMain.hexPath,
    hexWeights: lineMain.hexWeights.size > 0 ? lineMain.hexWeights : hexWeights,
                               // Line-derived weights for the breakdown
                               // when available — falls back to dijkstra's
                               // for hexes the line never sampled.
    dijkstraHexWeights: hexWeights, // kept for debug
    cost: terrainCost + embarkCost + ferryCost,
    embarks,
    ferries,
    usedFerryHexes,            // ferry hexes the line actually crossed a thick river in
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
    cost: 0, embarks: 0, ferries: 0, byTerrain: {},
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
    totals.ferries += (seg.ferries || 0);
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
  // Path hexes that get the road-restriction treatment. Two qualifying
  // conditions under the new subhex-class model:
  //   * Dijkstra's chosen subhex path entered a ROAD SUBHEX of the hex
  //     (pixel-defined; pulled from ROAD_SUBHEXES). Per-subhex detection
  //     replaces the old per-hex Road flag — a hex whose painted road
  //     isn't actually being used by this route doesn't get restricted.
  //   * In FERRY_HEXES (artwork has road overlaid on thick river — a ferry).
  //     Keeps ferry semantics working the same as before so the road+thick
  //     fallback can bridge the crossing.
  // pathRoadSet — every path hex the renderer should TRY to snap to a road
  // pixel inside. We seed it from dijkstra's actual road-component hexes
  // (ctx.pathRoadHexes), but we ALSO add any path hex that contains a
  // road component at all, even if dijkstra picked the land component
  // there: the rendered line should be free to put itself on the road
  // when one exists. The tier sequence will fall back to thin/full if
  // the road doesn't form a connected line. Start/end hexes are NOT
  // skipped any more — they participate in road restriction so the
  // line snaps onto the nearest road before being loosened to full.
  const pathRoadSet = new Set();
  if (ctx.pathRoadHexes) {
    for (const hid of ctx.pathRoadHexes) pathRoadSet.add(hid);
  }
  if (pathHexIds && ROAD_SUBHEXES) {
    for (const hid of pathHexIds) {
      const subs = SUBHEXES_BY_HEX.get(hid) || [];
      for (const sub of subs) {
        if (ROAD_SUBHEXES.has(sub.id)) { pathRoadSet.add(hid); break; }
      }
    }
  }
  if (pathHexIds && FERRY_HEXES) {
    for (const hid of pathHexIds) {
      if (FERRY_HEXES.has(hid)) pathRoadSet.add(hid);
    }
  }
  // Per-hex set of dijkstra-chosen COMPONENTS — "sid:comp" strings. The
  // path-full tier restores only the pixels of THESE components, so a
  // hex where dijkstra picked a road component stays road-only at
  // path-full (the subhex's land component is NOT restored, even though
  // road and land belong to the same subhex id). That matches "follow
  // the road as much as possible — even if later we go into normal
  // land": the route's own road hexes stay tight on the road, and any
  // loosening to bridge a gap happens in OTHER hexes (or via adjacents).
  const hexToPathComponents = new Map();
  if (ctx.pathComponents) {
    for (const key of ctx.pathComponents) {
      const colon = key.indexOf(":");
      const sid = +key.slice(0, colon);
      const sub = SUBHEX_INDEX.get(sid);
      if (!sub) continue;
      let set = hexToPathComponents.get(sub.hex);
      if (!set) { set = new Set(); hexToPathComponents.set(sub.hex, set); }
      set.add(key);
    }
  }
  // River pixels are intentionally NOT mixed into the road-restricted mask
  // anymore. A road+river hex (or any river-flagged hex) restricts to ROAD
  // pixels only — river pixels do not count as a valid pass-through for the
  // road restriction loop. Effect: routes follow the painted road inside
  // road+river hexes even when the river offers a wider "channel" the line
  // could otherwise drift onto.
  // Path-hex restriction set. We no longer broaden into adjacent hexes
  // at all — the per-subhex / component graph is the single source of
  // truth for what dijkstra can route through, and the renderer follows
  // strictly within that graph. If two neighboring hexes have road
  // pixels that aren't actually 8-connected at their shared border,
  // the line WON'T pretend they connect via adj-broadening. That's the
  // honest behaviour the user asked for: rely on the subhex dijkstra
  // approach, no adj-broadening fallback.
  const restrictPathHexes = new Set(pathRoadSet);
  const adjAnyHexes = new Set();   // kept empty so existing references stay safe; do not populate
  const roadHexList = [...restrictPathHexes];

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
  const hexPxByHex      = new Map();   // hex_id -> all mask indices belonging to the hex
  const roadPxByHex     = new Map();   // hex_id -> subset of those that are road pixels
  const thickRivPxByHex = new Map();   // hex_id -> subset of those that are thick-river pixels (ferries)
  const thinRivPxByHex  = new Map();   // hex_id -> subset that are thin-river pixels (fordable / "green" in the debug overlay)
  const navalPxByHex    = new Map();   // hex_id -> subset of those that sit inside a naval-class subhex (sea ferries)
  const pathSubhexPxByHex = new Map(); // hex_id -> subset of NON-THICK pixels whose subhex was on dijkstra's chosen path
  for (const hid of roadHexList) {
    hexPxByHex.set(hid, []);
    roadPxByHex.set(hid, []);
    thickRivPxByHex.set(hid, []);
    thinRivPxByHex.set(hid, []);
    navalPxByHex.set(hid, []);
    pathSubhexPxByHex.set(hid, []);
  }
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
    const isRoadHex   = hexPxByHex.has(hid);
    const allList     = isRoadHex ? hexPxByHex.get(hid)      : null;
    const thickList   = isRoadHex ? thickRivPxByHex.get(hid) : null;
    const thinList    = isRoadHex ? thinRivPxByHex.get(hid)  : null;
    const navalList   = isRoadHex ? navalPxByHex.get(hid)    : null;
    for (let pi = 0; pi < pixels.length; pi++) {
      const fullIdx = pixels[pi];
      const fullY = (fullIdx / W) | 0;
      const fullX = fullIdx - fullY * W;
      if (fullX < bx0 || fullX > bx1 || fullY < by0 || fullY > by1) continue;
      const idx = (fullY - by0) * mw + (fullX - bx0);
      const sidHere = subhexPx[fullIdx];
      // Thick river pixels (plus their 1-px halo for AA / bank coverage) are
      // unconditionally impassable in the initial mask build — they're only
      // restored later by restrict()'s ferry stage, if the hex is flagged
      // as a ferry. Single-pixel-wide river stretches are NOT in
      // THICK_RIVER_BLOCKING_MASK and fall through normally so the line
      // can still ford them.
      const isThickRiver = THICK_RIVER_BLOCKING_MASK && THICK_RIVER_BLOCKING_MASK[fullIdx];
      if (!isThickRiver) {
        if (extSubSet.has(sidHere))   mask[idx]         = 1;
        if (subSet.has(sidHere))      pathOnlyMask[idx] = 1;
      }
      if (isRoadHex) {
        allList.push(idx);
        if (isThickRiver) thickList.push(idx);
        // Track thin-river pixels (the green-overlay class — strict river
        // pixels NOT in the thick mask). These are fordable; the adjacent-
        // hex restrict() falls back to them between road-only and
        // road+thick so a ford on a fordable river can rescue connectivity
        // without inviting the thick-river crossing.
        const isThinRiver = THIN_RIVER_EXPANDED_MASK && THIN_RIVER_EXPANDED_MASK[fullIdx]
                          && !isThickRiver;
        if (isThinRiver) thinList.push(idx);
        // Track naval-class subhex pixels so the ferry restrict() fallback
        // can restore them as a 3rd stage (sea ferries — road overlaid on a
        // Sea/Lake/Ocean subhex rather than a thick river).
        const sub = SUBHEX_INDEX.get(sidHere);
        if (sub && WATER_TERRAINS.has(sub.class)) navalList.push(idx);
        // Pixels belonging to a dijkstra-chosen COMPONENT of THIS hex,
        // with thick river excluded. This is what the Path-full tier
        // restores — strictly the route's own COMPONENT inside this
        // hex. A road-component pick restores only road pixels even at
        // path-full; the surrounding land component (same subhex) stays
        // blocked. That keeps "this hex should be road only" honest
        // even when other hexes have to loosen to bridge a gap.
        if (!isThickRiver) {
          const pathComps = hexToPathComponents.get(hid);
          if (pathComps && SUBHEX_PIXEL_COMPONENT) {
            const compHere = SUBHEX_PIXEL_COMPONENT[fullIdx];
            if (compHere && pathComps.has(`${sidHere}:${compHere}`)) {
              pathSubhexPxByHex.get(hid).push(idx);
            }
          }
        }
      }
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
  //  - River-ONLY path hexes (flagged River, NOT flagged Road) — skipped
  //    from restriction. There's no road to restrict to, and forcing a
  //    river-only mask would just produce a weird detour around the ford.
  //  - Road+river path hexes are NOT skipped — they go through the same
  //    restrict-to-road pass as plain road hexes, so the line follows the
  //    painted road through the ford. The revert-on-fail check inside
  //    restrict() catches the case where road pixels alone don't span the
  //    hex (e.g., the road touches an edge but not the opposite edge); in
  //    that case the hex's full mask is restored, the river contribution
  //    is implicitly back, and the line can ford freely. So "restrict to
  //    roads only if it doesn't split the mask" is exactly the behavior
  //    that falls out of the existing acceptance logic.
  //    Scoped to MAIN-PATH hexes only (pathHexIds), NOT adjacent road
  //    hexes — those still get restricted even if they're rivers (off-path
  //    "courtesy" additions shouldn't swell open terrain).
  const skipHexes = new Set();
  // Start/end hexes are NO LONGER skipped from restriction. The user
  // explicitly wants start/end to follow the same tier progression as
  // other path hexes: snap to road first (path road tier), then try
  // adjacent roads (adj road tier), and only fall back to a full fill
  // (path full tier) at the very end. Skipping them used to make
  // snapToMask jump less aggressively, but that came at the cost of
  // never trying to follow the road OUT of the start hex.
  if (HEX_RIVER && pathHexIds) {
    for (const hid of pathHexIds) {
      const isRiver = HEX_RIVER.get(hid);
      const isRoad  = pathRoadSet.has(hid);
      if (isRiver && !isRoad) skipHexes.add(hid);
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
        // Deliberately NOT adding to skipHexes here. The old behavior was to
        // skip this hex's restriction so the restored water pixels survived,
        // but that also skipped the road-only restriction for any land hex
        // that happened to contain a naval subhex — which is exactly why
        // road-flagged hexes were keeping their Plains pixels passable. The
        // restrict() pass now runs on this hex normally; if Dijkstra picked
        // a naval subhex it's handled by the hasNavalInPath check inside
        // restrict() instead.
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
  // INTERTWINED RESTRICTION HIERARCHY.
  //
  // The route mask is built up in interlaced stages — path and adjacent
  // tiers are mixed so that road-like surfaces (a road that bleeds from
  // a neighbor still IS a road) are tried before any hex is loosened to
  // its full land. The loosening stages (thin / full / adj-thin /
  // adj-thick) are PER HEX cumulatively: each hex only escalates as far
  // as it needs to for connectivity. We don't dump the whole path into
  // "full land" the moment one corner of one hex is blocked.
  //
  //   1. Path road                — strict road, all path hexes.
  //   2. Path thin river          — per path hex, cumulative.
  //   3. Path ferry               — thick-river pixels of ferry path hexes.
  //   4. Adj road                 — road bleed from neighbor hexes (all).
  //   5. Adj thin river           — per adjacent, cumulative.
  //   6. Path naval (embark)      — sea-crossing pixels in path hexes.
  //   7. Path full                — per path hex, DIJKSTRA-CHOSEN subhexes
  //                                 only. Loosening the route's own land
  //                                 happens only after road bleed and the
  //                                 sea / ferry crossings have all failed.
  //   8. Adj thick river          — per adjacent, cumulative.
  //   9. Adj full (revert)        — restore every adjacent to its
  //                                 pre-clearing mask. Path hexes never
  //                                 revert — strict.
  // pathRoadSet already encodes "this hex either had a road subhex on the
  // dijkstra path OR is a ferry hex" — the new per-subhex definition of
  // road-ness. Use it directly instead of HEX_ROAD: a hex with the
  // spreadsheet Road flag but no road subhex on this particular path
  // doesn't get restricted, which is the whole point of the subhex fix.
  const isRoadOrFerry = (hid) => pathRoadSet.has(hid);
  const hexHasNavalInPath = (hid) => {
    const navalPx = navalPxByHex.get(hid);
    if (!navalPx || navalPx.length === 0) return false;
    for (const sub of (SUBHEXES_BY_HEX.get(hid) || [])) {
      if (WATER_TERRAINS.has(sub.class) && subSet.has(sub.id)) return true;
    }
    return false;
  };
  // Collect the hexes we'll touch.
  //   * Path hexes are filtered by the road/ferry gate — non-road path hexes
  //     aren't restricted at all (they keep their full subhex mask).
  //   * Adjacent hexes get NO gate. EVERY adjacent in the broadening gets
  //     cleared and then restored only via the road/thin/thick tiers.
  //     Adjacent hexes with no road / no river pixels end up impassable —
  //     so the line can't drift through a random Plains neighbor that just
  //     happens to sit next to a path road hex.
  const pathRestrictHexes = [];
  for (const hid of restrictPathHexes) {
    if (skipHexes.has(hid)) continue;
    if (!isRoadOrFerry(hid)) continue;
    if ((hexPxByHex.get(hid) || []).length === 0) continue;
    pathRestrictHexes.push(hid);
  }
  // adjRestrictHexes is no longer populated — adj broadening is gone.
  // Kept as an empty array for the few legacy references that still
  // iterate it (those become no-ops).
  const adjRestrictHexes = [];
  // Save the pre-restriction state of path hexes (savedPath) so the
  // "fullhex" tier can restore each path hex's entire pre-clearing
  // mask if connectivity demands it. savedAdj is gone with adj
  // broadening.
  const savedPath = new Map();
  for (const hid of pathRestrictHexes) {
    const allPx = hexPxByHex.get(hid) || [];
    const buf = new Uint8Array(allPx.length);
    for (let i = 0; i < allPx.length; i++) buf[i] = mask[allPx[i]];
    savedPath.set(hid, buf);
  }
  for (const hid of pathRestrictHexes) {
    const allPx = hexPxByHex.get(hid) || [];
    for (let i = 0; i < allPx.length; i++) mask[allPx[i]] = 0;
  }
  // Helper: apply a named tier of pixel restoration to a list of hexes.
  // "full" means the non-thick pixels of the dijkstra-chosen subhexes of
  // each hex — strictly the route's own sub-region, not the broader
  // A*-maneuver expansion of subSet.
  const applyTier = (hexes, what) => {
    for (const hid of hexes) {
      // "fullhex" — restore the hex's ENTIRE pre-clearing mask, every
      // passable pixel regardless of which components dijkstra picked.
      // Ferry hexes use this to bridge gaps between road components via
      // the land subhexes inside the hex, without pulling any neighbors
      // into the mask.
      if (what === "fullhex") {
        const allPx = hexPxByHex.get(hid) || [];
        const buf   = savedPath.get(hid);
        if (!buf) continue;
        for (let i = 0; i < allPx.length; i++) if (buf[i]) mask[allPx[i]] = 1;
        continue;
      }
      let px = null;
      if      (what === "road")  px = roadPxByHex.get(hid)        || null;
      else if (what === "thin")  px = thinRivPxByHex.get(hid)     || null;
      else if (what === "full")  px = pathSubhexPxByHex.get(hid)  || null;
      else if (what === "thick") px = thickRivPxByHex.get(hid)    || null;
      else if (what === "ferry") {
        if (!(FERRY_HEXES && FERRY_HEXES.has(hid))) continue;
        px = thickRivPxByHex.get(hid) || null;
      }
      else if (what === "naval") {
        if (!hexHasNavalInPath(hid)) continue;
        px = navalPxByHex.get(hid) || null;
      }
      if (px) for (const i of px) mask[i] = 1;
    }
  };
  const checkConn = () => maskHasRoute(mask, mw, mh, bx0, by0, startPt, endPt);
  // Restoration sequence. Ferry path hexes get FULL escalation before
  // any adj broadening fires — a ferry crossing should resolve itself
  // inside its own hex, not pull every neighbor of every path hex into
  // the mask. Regular path hexes still go to full last (after adj
  // broadening had its chance):
  //
  //   1. Path road                — strict road, all path hexes (preferred).
  //   2. Path thin                — per hex, cumulative.
  //   3. Path ferry               — thick-river pixels of path ferry hexes.
  //   4. Path naval (embark)      — sea-ferry pixels inside path hexes.
  //   5. Ferry path full-hex      — per ferry path hex, ENTIRE hex's
  //                                 pre-clearing mask (every passable
  //                                 pixel, not just dijkstra-chosen
  //                                 components). Resolves ferry-crossing
  //                                 gaps inside the hex without dragging
  //                                 any neighbors into the mask.
  //   6. Adj road                 — road bleed from neighbors, all adjacents.
  //   7. Adj thin                 — per adjacent, cumulative.
  //   8. Regular path full        — per non-ferry path hex, dijkstra-chosen
  //                                 subhexes only.
  //   9. Adj thick                — per adjacent, cumulative.
  //  10. Path full-hex (any path) — per path hex, entire pre-clearing
  //                                 mask (every passable pixel). Last
  //                                 chance to resolve inside the route
  //                                 before the neighbor revert; ensures
  //                                 path hexes get full-hex inclusion
  //                                 before any neighbor does.
  //  11. Adj full (revert)        — restore every adjacent hex to its
  //                                 pre-clearing mask. Path hexes never
  //                                 stay restricted past tier 10.
  //
  // The "per hex, cumulative" loops mean: for each hex in turn, apply the
  // tier to just that hex and recheck connectivity. The first hex whose
  // loosening completes the route wins; earlier hexes that didn't suffice
  // stay loosened too (cumulative), but later hexes are never touched.
  // Result: when the road in only one path hex is the bottleneck, only
  // that hex (and any earlier ones reached during the scan) get the
  // looser tier — every other hex stays restricted to its road pixels.
  // Per-hex escalation: try to loosen the MINIMUM number of hexes needed.
  //   Pass 1 (revert-on-fail): for each hex, save its current mask, apply
  //     the tier, check connectivity. If connected, keep it. If not,
  //     revert THIS hex and try the next one. This finds single-hex
  //     bottlenecks without escalating unrelated hexes.
  //   Pass 2 (cumulative): only if pass 1 found nothing AND allowCumulative
  //     is true. Apply the tier cumulatively until connectivity, in case
  //     the blocker requires multiple simultaneous escalations. Some tiers
  //     (like ferry-fullhex) prefer to NOT do the cumulative pass — it
  //     would open every ferry hex even when only one is the actual
  //     bottleneck, dragging unrelated ferry hexes to fullhex.
  const perHexEscalate = (hexes, what, allowCumulative = true) => {
    for (const hid of hexes) {
      const allPx = hexPxByHex.get(hid) || [];
      if (allPx.length === 0) continue;
      const saved = new Uint8Array(allPx.length);
      for (let i = 0; i < allPx.length; i++) saved[i] = mask[allPx[i]];
      applyTier([hid], what);
      if (checkConn()) return true;
      // Revert THIS hex's tier so unrelated hexes don't carry stray
      // loosening that didn't actually help.
      for (let i = 0; i < allPx.length; i++) mask[allPx[i]] = saved[i];
    }
    if (!allowCumulative) return false;
    // Cumulative fallback — multi-hex blockers.
    for (const hid of hexes) {
      applyTier([hid], what);
      if (checkConn()) return true;
    }
    return false;
  };
  // Split path-restrict hexes into ferry vs non-ferry so we can give
  // ferry hexes a chance to expand to FULL before any adj broadening
  // kicks in. A small ferry crossing shouldn't drag every neighbor of
  // every path hex into the mask — it should resolve itself with the
  // ferry hex's own pixels first.
  const ferryPathHexes   = pathRestrictHexes.filter(h => FERRY_HEXES && FERRY_HEXES.has(h));
  const regularPathHexes = pathRestrictHexes.filter(h => !(FERRY_HEXES && FERRY_HEXES.has(h)));

  let connected = false;
  do {
    applyTier(pathRestrictHexes, "road");
    if (checkConn()) { connected = true; break; }
    if (perHexEscalate(pathRestrictHexes, "thin"))  { connected = true; break; }
    applyTier(pathRestrictHexes, "ferry");
    if (checkConn()) { connected = true; break; }
    applyTier(pathRestrictHexes, "naval");
    if (checkConn()) { connected = true; break; }
    // Ferry path hexes get FULL-HEX escalation. CUMULATIVE is DISABLED
    // here (third arg false) so we don't open every ferry hex when
    // only one is actually the problem; if revert-on-fail can't find
    // a single ferry hex whose fullhex solves connectivity, we fall
    // through to per-hex regular-path escalation instead.
    if (perHexEscalate(ferryPathHexes, "fullhex", false)) { connected = true; break; }
    // Regular path full (dijkstra-chosen components only), per hex.
    if (perHexEscalate(regularPathHexes, "full"))   { connected = true; break; }
    // Last resort: every path hex to its entire pre-clearing mask
    // (every passable pixel). Adj-broadening was removed — if even
    // this doesn't connect, the route is genuinely unrenderable
    // through the subhex/component graph.
    if (perHexEscalate(pathRestrictHexes, "fullhex")) { connected = true; break; }
  } while (false);

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
// Only the ACTIVE route's segments are drawn — when a user has several
// routes, painting all of them at once stacks the overlays and makes the
// active route's mask unreadable. Off entirely when DEBUG_SHOW_MASK is
// false.
function drawDebugMask() {
  if (!DEBUG_SHOW_MASK) return;
  const route = getActiveRoute();
  if (!route) return;
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

// Cached canvas for the river-type debug overlay. The classification doesn't
// change at runtime, so we paint it once and just blit on every render.
const _dbgRiverCanvas = document.createElement("canvas");
const _dbgRiverCtx = _dbgRiverCanvas.getContext("2d");
let _dbgRiverCanvasReady = false;
function ensureDebugRiverCanvas() {
  if (_dbgRiverCanvasReady) return true;
  if (!STRICT_RIVER_PIXEL_MASK || !HEX_DATA) return false;
  const W = HEX_DATA.image_width, H = HEX_DATA.image_height;
  _dbgRiverCanvas.width = W; _dbgRiverCanvas.height = H;
  const img = _dbgRiverCtx.createImageData(W, H);
  // Two non-overlapping layers:
  //   * Red — pixels in THICK_RIVER_PIXEL_MASK (strict core + 2-iter edge
  //     closure + 3-iter AA-halo expansion that explicitly skips strict-thin
  //     pixels). This is exactly what the router treats as impassable.
  //   * Green — pixels in THIN_RIVER_EXPANDED_MASK (strict-thin + 3-iter AA
  //     expansion that explicitly stops at thick). Fills in the visual gaps
  //     of 1-px thin rivers without bleeding past the proper red border.
  // The two masks are constructed to be disjoint, so paint priority is
  // mechanical: check red first, then green, otherwise leave transparent.
  for (let i = 0; i < W * H; i++) {
    const isThick = !!(THICK_RIVER_PIXEL_MASK && THICK_RIVER_PIXEL_MASK[i]);
    const isThin  = !isThick && !!(THIN_RIVER_EXPANDED_MASK && THIN_RIVER_EXPANDED_MASK[i]);
    if (!isThick && !isThin) continue;
    const p = i * 4;
    if (isThick) {
      img.data[p] = 230; img.data[p+1] = 40; img.data[p+2] = 40; img.data[p+3] = 200;
    } else {
      img.data[p] = 50; img.data[p+1] = 215; img.data[p+2] = 90; img.data[p+3] = 200;
    }
  }
  _dbgRiverCtx.putImageData(img, 0, 0);
  _dbgRiverCanvasReady = true;
  return true;
}
function drawDebugRiverTypes() {
  if (!DEBUG_SHOW_RIVER_TYPES) return;
  if (!ensureDebugRiverCanvas()) return;
  hlCtx.drawImage(_dbgRiverCanvas, 0, 0);
}

// Cached canvas for the ferry-hex debug overlay. FERRY_HEXES is set once at
// load time so we can paint it into the canvas once and just blit on every
// render — same pattern as the river-types overlay.
const _dbgFerryCanvas = document.createElement("canvas");
const _dbgFerryCtx = _dbgFerryCanvas.getContext("2d");
let _dbgFerryCanvasReady = false;
function ensureDebugFerryCanvas() {
  if (_dbgFerryCanvasReady) return true;
  if (!FERRY_HEXES || !HEX_ID_PX || !HEX_DATA) return false;
  const W = HEX_DATA.image_width, H = HEX_DATA.image_height;
  _dbgFerryCanvas.width = W; _dbgFerryCanvas.height = H;
  const img = _dbgFerryCtx.createImageData(W, H);
  // Walk every pixel; if its hex id is in FERRY_HEXES, tint translucent yellow.
  // HEX_ID_PX[i] = 0 means "outside any hex" — skip.
  for (let i = 0; i < W * H; i++) {
    const hid = HEX_ID_PX[i];
    if (!hid || !FERRY_HEXES.has(hid)) continue;
    const p = i * 4;
    img.data[p]     = 240;
    img.data[p + 1] = 220;
    img.data[p + 2] = 40;
    img.data[p + 3] = 110;
  }
  _dbgFerryCtx.putImageData(img, 0, 0);
  _dbgFerryCanvasReady = true;
  return true;
}
// Scratch buffer for the per-segment "used ferry" overlay. Sized to the
// full image so we can plot used-ferry hex pixels directly; not cached
// because the set changes per active route.
const _dbgUsedFerryCanvas = document.createElement("canvas");
const _dbgUsedFerryCtx = _dbgUsedFerryCanvas.getContext("2d");
function drawDebugFerryHexes() {
  if (!DEBUG_SHOW_FERRY_HEXES) return;
  if (!ensureDebugFerryCanvas()) return;
  // Base layer: every ferry hex in the dim yellow.
  hlCtx.drawImage(_dbgFerryCanvas, 0, 0);
  // Overlay: ferry hexes the ACTIVE route actually crossed a thick river
  // in. Painted in a stronger cyan so it pops against the dim yellow
  // base. Computed fresh each render — the used set is per-route, not
  // cacheable like FERRY_HEXES itself.
  const route = getActiveRoute();
  if (!route || !HEX_ID_PX || !HEX_DATA) return;
  const usedSet = new Set();
  for (const seg of route.segments) {
    if (!seg.usedFerryHexes) continue;
    for (const hid of seg.usedFerryHexes) usedSet.add(hid);
  }
  if (usedSet.size === 0) return;
  const W = HEX_DATA.image_width, H = HEX_DATA.image_height;
  if (_dbgUsedFerryCanvas.width !== W || _dbgUsedFerryCanvas.height !== H) {
    _dbgUsedFerryCanvas.width = W; _dbgUsedFerryCanvas.height = H;
  } else {
    _dbgUsedFerryCtx.clearRect(0, 0, W, H);
  }
  const img = _dbgUsedFerryCtx.createImageData(W, H);
  for (let i = 0; i < W * H; i++) {
    const hid = HEX_ID_PX[i];
    if (!hid || !usedSet.has(hid)) continue;
    const p = i * 4;
    img.data[p]     = 80;
    img.data[p + 1] = 230;
    img.data[p + 2] = 220;
    img.data[p + 3] = 170;
  }
  _dbgUsedFerryCtx.putImageData(img, 0, 0);
  hlCtx.drawImage(_dbgUsedFerryCanvas, 0, 0);
}

// Subhex-types debug overlay — paints every pixel by its routing category
// (Naval / Infrastructure / qualifying Land). Built once after load; the
// classification is invariant across the session as long as the hex
// assigned terrains, road mask, and naval class data don't change.
const _dbgSubhexTypesCanvas = document.createElement("canvas");
const _dbgSubhexTypesCtx = _dbgSubhexTypesCanvas.getContext("2d");
let _dbgSubhexTypesReady = false;
function ensureDebugSubhexTypesCanvas() {
  if (_dbgSubhexTypesReady) return true;
  if (!SUBHEX_ID_PX || !SUBHEX_INDEX || !HEX_DATA || !HEX_TERRAIN) return false;
  const W = HEX_DATA.image_width, H = HEX_DATA.image_height;
  _dbgSubhexTypesCanvas.width = W; _dbgSubhexTypesCanvas.height = H;
  const img = _dbgSubhexTypesCtx.createImageData(W, H);
  const road = ROAD_PIXEL_MASK;
  // Color table — translucent so the underlying map is still readable.
  const NAVAL = [80, 130, 230, 130];
  const INFRA = [240, 150,  40, 170];
  const LAND  = [130, 220,  90, 110];
  for (let i = 0; i < W * H; i++) {
    const sid = SUBHEX_ID_PX[i];
    if (!sid) continue;
    const sub = SUBHEX_INDEX.get(sid);
    if (!sub) continue;
    let rgb = null;
    if (WATER_TERRAINS.has(sub.class)) {
      rgb = NAVAL;
    } else if (road && road[i]) {
      rgb = INFRA;
    } else {
      // Land: only tint if the subhex's CANONICAL class weight is ≤ the
      // parent hex's assigned terrain weight (i.e. dijkstra can actually
      // enter this subhex). Heavier land is left untinted. Uses the
      // canonical class so Plains pixels show up as Flatlands and Peaks
      // pixels show up as Mountains — matching the weight table.
      const sw = +weights[canonicalSubhexClass(sub)];
      const hexT = canonicalHexTerrain(HEX_TERRAIN.get(sub.hex));
      const hexW = hexT ? +weights[hexT] : NaN;
      if (isFinite(sw) && isFinite(hexW) && sw <= hexW) rgb = LAND;
    }
    if (!rgb) continue;
    const p = i * 4;
    img.data[p]     = rgb[0];
    img.data[p + 1] = rgb[1];
    img.data[p + 2] = rgb[2];
    img.data[p + 3] = rgb[3];
  }
  _dbgSubhexTypesCtx.putImageData(img, 0, 0);
  _dbgSubhexTypesReady = true;
  return true;
}
function invalidateDebugSubhexTypes() { _dbgSubhexTypesReady = false; }
function drawDebugSubhexTypes() {
  if (!DEBUG_SHOW_SUBHEX_TYPES) return;
  if (!ensureDebugSubhexTypesCanvas()) return;
  hlCtx.drawImage(_dbgSubhexTypesCanvas, 0, 0);
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
                cost: 0, embarks: 0, ferries: 0, waypoints: 0,
                strongholds: 0, rivers: 0, roads: 0 };
  for (const r of ROUTES) {
    const t = r.totals;
    if (!t) continue;
    out.hexes       += t.hexes;
    out.miles       += t.miles;
    out.km          += t.km;
    out.cost        += t.cost;
    out.embarks     += t.embarks;
    out.ferries     += (t.ferries || 0);
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
    // Active-route-only — outlining every route at once gets noisy fast
    // and obscures the route you're currently editing. Matches the same
    // scoping as the debug mask overlay.
    const route = getActiveRoute();
    if (route) {
      const hexSet = new Set();
      for (const seg of route.segments) for (const hid of seg.hexIds) hexSet.add(hid);
      if (hexSet.size > 0) drawHexOutlines(hexSet, HEX_OUTLINE_COLOR);
    }
  }

  for (const route of ROUTES) drawWaypointMarkers(route);

  drawDebugMask();
  drawDebugRiverTypes();
  drawDebugFerryHexes();
  drawDebugSubhexTypes();
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
      const terrainCanon = canonicalHexTerrain(terrain);
      const tw = (terrainCanon && weights[terrainCanon] != null) ? +weights[terrainCanon] : null;
      const terrainStr = terrain ? `  ·  ${terrain}${isFinite(tw) ? ` (w ${tw})` : ""}` : "";
      const flags = [];
      if (HEX_ROAD && HEX_ROAD.get(hx.id)) flags.push("Road");
      if (HEX_RIVER && HEX_RIVER.get(hx.id)) flags.push("River");
      if (HEX_STRONGHOLD && HEX_STRONGHOLD.get(hx.id)) flags.push("Stronghold");
      const flagsStr = flags.length ? `  ·  ${flags.join(", ")}` : "";
      const baseLine = `${pad4(hx.id)}${terrainStr}${flagsStr}${sname ? `  ·  ${sname}` : ""}`;
      let html = escapeTooltipHtml(baseLine);
      if (DEBUG_SHOW_MASK) {
        const expl = explainMaskAtPixel(ipt.x | 0, ipt.y | 0);
        if (expl) html += "<br><span style=\"color:#9aa1ab;font-size:11px\">" + expl.replace(/\n/g,"<br>") + "</span>";
      }
      tooltipEl.innerHTML = html;
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

function escapeTooltipHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Explain why a given pixel ended up in or out of the route mask (only
// meaningful when DEBUG_SHOW_MASK is on and a route is active). Returns a
// multi-line description, or null if there's no useful info. Enumerates the
// classification reasons:
//   * Hex membership (on the route's hex path, an adjacent-broadened hex,
//     or completely outside).
//   * Thick-river status (in the mask = impassable to the line).
//   * Subhex class (naval class stranded in a non-water hex = excluded
//     from the path subhex set).
//   * Road / ferry restriction (in a road-flagged or ferry hex, mask was
//     restricted to road pixels; this pixel either is or isn't a road
//     pixel, and the ferry fallback either did or didn't fire).
function explainMaskAtPixel(px, py) {
  if (!SUBHEX_ID_IMG_DATA || !HEX_ID_PX || !SUBHEX_ID_PX) return null;
  const W = SUBHEX_ID_IMG_DATA.width, H = SUBHEX_ID_IMG_DATA.height;
  if (px < 0 || py < 0 || px >= W || py >= H) return null;
  const idx = py * W + px;
  const hid = HEX_ID_PX[idx];
  if (!hid) return "(outside any hex)";
  const lines = [];
  // The debug data is scoped to the ACTIVE route — when multiple routes
  // are on the map, mixing their masks/path-membership in one tooltip
  // makes it impossible to read what's going on with the route you're
  // currently editing. Falls back to first route if there's no active
  // selection.
  const activeRoute = (typeof getActiveRoute === "function") ? getActiveRoute() : null;
  const debugRoute = activeRoute || (ROUTES.length > 0 ? ROUTES[0] : null);
  const debugSegments = debugRoute ? debugRoute.segments : [];

  // Mask state for this pixel — only checked against the active route's
  // segment masks.
  let maskState = null;
  for (const seg of debugSegments) {
    const dm = seg.debugMask;
    if (!dm) continue;
    const lx = px - dm.bx0, ly = py - dm.by0;
    if (lx < 0 || ly < 0 || lx >= dm.mw || ly >= dm.mh) continue;
    maskState = dm.mask[ly * dm.mw + lx] ? "PASSABLE" : "BLOCKED";
    break;
  }
  lines.push("Mask: " + (maskState || "(not in any segment mask of active route)"));

  // Pixel-level facts. These don't depend on any active route — they just
  // describe this pixel's place in the map's data model.
  const isThick = !!(THICK_RIVER_PIXEL_MASK && THICK_RIVER_PIXEL_MASK[idx]);
  const isThickBlock = !!(THICK_RIVER_BLOCKING_MASK && THICK_RIVER_BLOCKING_MASK[idx]);
  const isThin  = !!(THIN_RIVER_EXPANDED_MASK && THIN_RIVER_EXPANDED_MASK[idx] && !isThick);
  const isRoad  = !!(ROAD_PIXEL_MASK && ROAD_PIXEL_MASK[idx]);
  const isFerryHex = !!(FERRY_HEXES && FERRY_HEXES.has(hid));
  const isRoadHex  = !!(HEX_ROAD && HEX_ROAD.get(hid));   // sheet flag (legacy)
  const sid = SUBHEX_ID_PX[idx];
  const sub = sid ? SUBHEX_INDEX.get(sid) : null;
  const compId = SUBHEX_PIXEL_COMPONENT ? SUBHEX_PIXEL_COMPONENT[idx] : 0;
  const isRoadComp   = !!(sid && compId && ROAD_COMPONENTS && ROAD_COMPONENTS.has(`${sid}:${compId}`));
  const isRoadSubhex = !!(sid && ROAD_SUBHEXES && ROAD_SUBHEXES.has(sid));
  const isNavalClass = sub && WATER_TERRAINS.has(sub.class);
  const hexTerrain = HEX_TERRAIN ? HEX_TERRAIN.get(hid) : null;
  const hexTerrainCanon = canonicalHexTerrain(hexTerrain);
  const hexW       = (hexTerrainCanon && weights[hexTerrainCanon] != null) ? +weights[hexTerrainCanon] : NaN;
  const isWaterHex = !!(hexTerrainCanon && WATER_TERRAINS.has(hexTerrainCanon));
  const subCanon   = sub ? canonicalSubhexClass(sub) : null;
  const subW       = (subCanon && weights[subCanon] != null) ? +weights[subCanon] : NaN;
  const effW       = sub ? componentEffectiveWeight(sub, compId) : NaN;

  // Routing CATEGORY — what the subhex-types overlay would color this pixel.
  let category = "Land";
  if (isNavalClass) category = "Naval";
  else if (isRoad)  category = "Infrastructure";
  if (category === "Land" && isFinite(subW) && isFinite(hexW) && subW > hexW) {
    category += " (excluded — heavier than assigned)";
  }

  // Path membership — restricted to the active route's segments.
  let onPath = false, adjPath = false;
  let onPathSeg = null;
  for (const seg of debugSegments) {
    if (seg.hexIds && seg.hexIds.indexOf(hid) >= 0) { onPath = true; onPathSeg = seg; break; }
  }
  // Did dijkstra route through a road component of THIS hex on any segment
  // of the active route?
  let routedViaRoadHere = false;
  for (const seg of debugSegments) {
    if (!seg.pathRoadHexes) continue;
    if (seg.pathRoadHexes.has(hid)) { routedViaRoadHere = true; break; }
  }
  // Did dijkstra include THIS specific subhex in any chosen path of the
  // active route?
  let inDijkstraPath = false;
  if (sub) {
    for (const seg of debugSegments) {
      if (seg.subhexPath && seg.subhexPath.indexOf(sid) >= 0) { inDijkstraPath = true; break; }
    }
  }
  if (!onPath) {
    // Adjacent to a path road/ferry hex (active route only)?
    for (const seg of debugSegments) {
      if (!seg.hexIds) continue;
      const segPathRoadHexes = new Set();
      if (seg.pathRoadHexes) for (const hh of seg.pathRoadHexes) segPathRoadHexes.add(hh);
      if (FERRY_HEXES) {
        for (const hp of seg.hexIds) if (FERRY_HEXES.has(hp)) segPathRoadHexes.add(hp);
      }
      for (const hp of segPathRoadHexes) {
        for (const nb of hexNeighbors(hp)) {
          if (nb === hid) { adjPath = true; break; }
        }
        if (adjPath) break;
      }
      if (adjPath) break;
    }
  }

  // ── PATH ── status line.
  if (onPath) lines.push("Hex: on route's path");
  else if (adjPath) lines.push("Hex: adjacent to a path road/ferry hex");
  else lines.push("Hex: NOT on the path (or any path-adjacent set)");

  // ── CATEGORY ──
  lines.push(`Category: ${category}`);

  // ── COMPONENT ── tells us how dijkstra sees this exact pixel.
  if (sub) {
    const compStr = compId ? `${sid}:${compId}` : `(no component — thick river / off-subhex)`;
    lines.push(`Component: ${compStr}${isRoadComp ? " — ROAD component" : ""}`);
  }

  // ── DIJKSTRA ── did the router use this subhex / road in this hex?
  if (sub) {
    if (inDijkstraPath) lines.push("Dijkstra picked this subhex on a chosen path");
    if (routedViaRoadHere) lines.push("Dijkstra routed this hex VIA a road component");
    else if (onPath && isRoadSubhex) lines.push("Hex has road components but dijkstra did NOT route via the road here (line may still snap to road in renderer)");
  }

  // ── WEIGHTS ──
  if (sub) {
    const subWStr = isFinite(subW) ? subW : "?";
    const effWStr = isFinite(effW) ? effW : "?";
    const hexWStr = isFinite(hexW) ? hexW : "?";
    lines.push(`Weights: subhex canonical (${subCanon})=${subWStr} · effective=${effWStr} · hex assigned=${hexWStr}`);
    if (!isNavalClass && !isRoadComp && isFinite(subW) && isFinite(hexW) && subW > hexW) {
      lines.push("→ Land heavier than assigned: dijkstra cannot traverse this component");
    }
  }

  // ── FERRY / RIVER / ROAD FLAGS ──
  if (isThick) {
    lines.push("Thick river: pixel is in THICK_RIVER_PIXEL_MASK"
      + (isThickBlock ? " (incl. blocking halo)" : "")
      + " → impassable unless ferry-restored");
  }
  if (isThin) lines.push("Thin river: fordable (green-overlay)");
  if (isFerryHex) lines.push("Hex flagged as FERRY (road+thick overlay) → road+thick fallback eligible");
  else if (isRoadComp) {
    const compPixCount = SUBHEX_COMPONENT_PIXEL_COUNT
      ? (SUBHEX_COMPONENT_PIXEL_COUNT.get(`${sid}:${compId}`) || 0)
      : 0;
    if (compPixCount < MIN_PIXELS_PER_PATH_HEX) {
      lines.push(`This pixel sits in a ROAD COMPONENT but it's only ${compPixCount} px (< ${MIN_PIXELS_PER_PATH_HEX}) — too small, billed at land weight (road discount skipped)`);
    } else {
      lines.push(`This pixel sits in a ROAD COMPONENT (${compPixCount} px) — billed at road weight`);
    }
  }
  else if (isRoadSubhex) lines.push("Subhex contains road pixels, but THIS pixel is in the land component of the subhex (billed at class weight)");
  else if (isRoadHex) lines.push("Hex flagged Road (sheet), but THIS subhex has no road pixels — pays land weight");
  if (isRoad) lines.push("Pixel is a road/city pixel");

  // ── ROAD PIXEL COUNTS ── how much road artwork actually exists here.
  // Useful when debugging "why doesn't dijkstra route via this hex's
  // road" — a hex with only a few road pixels is a road in name only.
  const hexRoadPxList = HEX_ROAD_PIXELS ? HEX_ROAD_PIXELS.get(hid) : null;
  const hexRoadCount  = hexRoadPxList ? hexRoadPxList.length : 0;
  const hexAllPxList  = HEX_PIXELS ? HEX_PIXELS.get(hid) : null;
  const hexAllCount   = hexAllPxList ? hexAllPxList.length : 0;
  if (hexAllCount > 0) {
    const pct = hexAllCount > 0 ? ((hexRoadCount / hexAllCount) * 100).toFixed(1) : "0.0";
    lines.push(`Hex road pixels: ${hexRoadCount} / ${hexAllCount} (${pct}%)`);
  }
  if (sub && SUBHEX_ID_PX && ROAD_PIXEL_MASK) {
    // Subhex-scoped count by scanning the subhex's bbox. Cheap because
    // bboxes are small — and a per-subhex precompute felt excessive
    // when the tooltip only fires on hover.
    let subTotal = 0, subRoad = 0;
    const [sx0, sy0, sx1, sy1] = sub.bbox;
    for (let y = Math.max(0, sy0); y <= Math.min(H - 1, sy1); y++) {
      for (let x = Math.max(0, sx0); x <= Math.min(W - 1, sx1); x++) {
        const i = y * W + x;
        if (SUBHEX_ID_PX[i] !== sub.id) continue;
        subTotal++;
        if (ROAD_PIXEL_MASK[i]) subRoad++;
      }
    }
    if (subTotal > 0) {
      const pct = ((subRoad / subTotal) * 100).toFixed(1);
      lines.push(`Subhex road pixels: ${subRoad} / ${subTotal} (${pct}%)`);
    }
  }

  if (sub) {
    const stranded = isNavalClass && !isWaterHex && !isFerryHex;
    const aliasStr = (subCanon && subCanon !== sub.class) ? ` → ${subCanon}` : "";
    lines.push(`Subhex class: ${sub.class}${aliasStr}${stranded ? " (stranded naval in non-water hex)" : ""}`);
  }
  if (hexTerrain) {
    const aliasStr = (hexTerrainCanon && hexTerrainCanon !== hexTerrain) ? ` → ${hexTerrainCanon}` : "";
    lines.push(`Sheet terrain: ${hexTerrain}${aliasStr}`);
  }
  return lines.join("\n");
}

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
