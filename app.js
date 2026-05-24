"use strict";
// =================== Config =====================
const LAYERS = [
  { id: "sea",         file: "sea.png",                 label: "Sea fill",               on: true,  opacity: 1.00, hidden: true },
  { id: "continent",   file: "Continent Meat.png",      label: "Outline",                on: true,  opacity: 1.00 },
  { id: "terrain",     file: "Terrain.png",             label: "Terrain",                on: true,  opacity: 1.00 },
  { id: "borders",     file: "Borders_clean.png",       label: "Borders",                on: false, opacity: 1.00, prerasterise: true },
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
const CLASSES = ["Flatlands", "Hills", "Mountains", "Lake", "Sea", "Ocean", "Embark", "Disembark", "Ferry", "Fording"];
const DEFAULT_WEIGHTS = {
  "Flatlands": 30, "Hills": 30, "Mountains": 60,
  // Water traversal weights (used directly when sailing water -> water).
  // All naval classes share the same cost — Lake/Sea/Ocean merged at 2.5.
  // Cheap relative to overland because ships move much faster than a
  // land party.
  "Lake": 2.5, "Sea": 2.5, "Ocean": 2.5,
  // Embark — boarding a ship (land -> water). Heavy: 7.
  "Embark": 7,
  // Disembark — leaving a ship (water -> land). Allowed only at a hex
  // flagged Stronghold; cost defaults to 0 because the time-penalty is
  // baked into the Embark surcharge on the way out.
  "Disembark": 0,
  // Ferry — surcharge for crossing a RED (thick) river. Only available
  // where the artwork paints a road overlay on the river (the "ferry
  // mark"); unmarked thick river is impassable. Defaults to 0 (free) —
  // the time-penalty for actually using a marked ferry is small enough
  // that the modeled cost is just the road/land bank traversal.
  "Ferry": 0,
  // Fording — surcharge for crossing a GREEN (thin) river. Thin rivers
  // are fordable anywhere they appear (green-overlay pixels).
  "Fording": 5,
};
// Road column of the traversal-weight matrix. When dijkstra routes via
// a road COMPONENT, we use THIS table's value keyed by the parent hex's
// terrain instead of the default column — i.e., roads shave weight off a
// hex's inherent terrain cost. Embark/disembark and water-to-water still
// use the default column (a road doesn't help you load a ship or sail
// faster).
const DEFAULT_ROAD_WEIGHTS = {
  // Roads flatten the per-terrain cost on Flatlands/Hills to a single
  // value (15), regardless of the underlying class — a paved imperial road
  // moves a party at the same pace through valley or gentle uplands.
  // Mountain roads still cost more (30) because the road is rougher /
  // climbs more, even paved.
  "Flatlands": 15, "Hills": 15, "Mountains": 30,
  // Water and embark/disembark mirror the default column.
  "Lake": 2.5, "Sea": 2.5, "Ocean": 2.5,
  "Embark": 7,
  "Disembark": 0,
  "Ferry": 0,
  "Fording": 5,
};

// FORCED MARCH weight matrix — parallel to DEFAULT_WEIGHTS, used when a
// route segment is flagged "forced march". Lower per-hex IRL-hour cost
// reflects the party moving faster (covering ground in fewer hours).
// Surcharges (Embark / Ferry / Fording / Disembark) and water-traversal
// weights are unchanged — only the land-terrain row changes, since
// "forced march" is a marching-pace concept.
const DEFAULT_FORCED_WEIGHTS = {
  "Flatlands": 24, "Hills": 24, "Mountains": 48,
  "Lake": 2.5, "Sea": 2.5, "Ocean": 2.5,
  "Embark": 7,
  "Disembark": 0,
  "Ferry": 0,
  "Fording": 5,
};
// FORCED MARCH road column — mirrors the layout of DEFAULT_ROAD_WEIGHTS.
const DEFAULT_FORCED_ROAD_WEIGHTS = {
  "Flatlands": 12, "Hills": 12, "Mountains": 24,
  "Lake": 2.5, "Sea": 2.5, "Ocean": 2.5,
  "Embark": 7,
  "Disembark": 0,
  "Ferry": 0,
  "Fording": 5,
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
// ISOCHRONE_BUDGET is the dijkstra cost budget for reachability (in
// IRL hours — the same unit dijkstra optimises). The sidebar slider
// expresses it in DAYS (1..31, multiplied by 24 to get hours) since
// IRL-day units read better at world-map scale than raw hours. Default
// is 7 days, a reasonable "one-week march reach" baseline.
let ISOCHRONE_BUDGET = 7 * 24;
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
const armyEl      = document.getElementById("army");
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
// Forced-march weight tables. Per-segment forced flag swaps these in
// for the dijkstra cost computation (see rebuildRoute).
let forcedWeights = Object.assign({}, DEFAULT_FORCED_WEIGHTS);
let forcedRoadWeights = Object.assign({}, DEFAULT_FORCED_ROAD_WEIGHTS);
// Parallel hex-mode graph baked with forced-march costs. Built alongside
// HEX_MODES in recomputeHexModeGraph; swapped in temporarily when
// computing a forced-march route segment. Neighbors / pixel topology
// are identical, so HEX_MODE_NEIGHBORS is shared.
let HEX_MODES_FORCED = null;
// Pre-baked HEX_MODES catalogs for every army-permission combination
// (can-ford × can-embark, 4 combos). Built once at weight-change time
// alongside the default + forced graphs; toggling Can ford / Can embark
// just swaps the active variant via selectActiveHexModes() — no
// precompute, no dijkstra rebuild beyond what the route refresh needs.
// Keys are 2-char strings: "F"|"_" for can-ford, "E"|"_" for can-embark
// (e.g., "FE" = both on, "__" = both off, "F_" = ford only, "_E" = embark only).
let HEX_MODES_VARIANTS = null;        // default-march variants
let HEX_MODES_FORCED_VARIANTS = null; // forced-march variants

// ── Army state ───────────────────────────────────────────────────────
// Length of the marching column in miles. > 6 doubles all LAND weights
// (the column drags through every hex twice — once for the head, once
// for the tail). Default 5 = a baseline column; below the doubling
// threshold but above zero so fording cost = length × 2.4 hours
// instead of falling back to the static Fording weight.
let ARMY_LENGTH_MI = 5;
// Whether the army can ford a thin (green) river. When false, FORD
// modes are not emitted into HEX_MODES, so dijkstra simply can't cross
// thin rivers (it has to detour around them via a bridge or ferry).
let ARMY_CAN_FORD = true;
// Whether the army can board a ship. When false, NAVAL modes are not
// emitted and dijkstra cannot leave land for water. Independent of
// can-ford because boarding a ship and fording a river are different
// real-world activities.
let ARMY_CAN_EMBARK = true;
// Land-cost multiplier driven by army length. 2 for long columns
// (> 6 mi), 1 otherwise. Applied to LAND/ROAD mode costs at HEX_MODES
// build time and to the per-edge cost in computeIsochrone.
function armyLandMul() { return (ARMY_LENGTH_MI > 6) ? 2 : 1; }
// Effective FORD-mode cost per crossing in IRL hours. When the user has
// configured an army length, fording cost is column-length × 2.4 (the
// time it takes for the whole column to cross). With no army (length=0)
// we fall back to the static Fording weight from the weights table.
function armyFordCost() {
  if (ARMY_LENGTH_MI > 0) return ARMY_LENGTH_MI * 2.4;
  return +weights["Fording"] || 0;
}
// Binary masks over the full map image. Built once after layers load.
// ROAD_PIXEL_MASK       = roads.png ∪ citiestownsforts.png — used for the
//                         per-hex road restriction (a city street counts as a
//                         road for traversal purposes).
// ROAD_ONLY_PIXEL_MASK  = roads.png alone, NO ctf. Used exclusively for
//                         ferry detection: a hex is only a "ferry" if a
//                         literal road (not a city) overlaps thick river
//                         pixels. Cities sitting on rivers are not ferries.
// RIVER_PIXEL_MASK      = rivers.png alone — merged in with the road mask for
//                         hexes flagged as BOTH road AND river, so the
//                         restriction in a road+river hex follows either
//                         the road or the river.
let ROAD_PIXEL_MASK = null;
let ROAD_ONLY_PIXEL_MASK = null;
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
// Full pixel-index list per (subhex, component). Captured at flood-fill
// time so the per-hex MODE pixel sets can be assembled cheaply by union
// without rescanning the bbox. Feeds the (hex, mode) graph the mode-based
// dijkstra runs on.
let SUBHEX_COMPONENT_PIXELS = null;       // Map<"sid:comp", Uint32Array of pixel indices>

// ---------- Hex-mode graph (the layer dijkstra actually runs on) ----------
// Each hex contributes up to four MODE nodes representing distinct
// traversal patterns through the hex. dijkstra picks the cheapest
// sequence of (hex, mode) nodes; the renderer draws the line through
// the chosen modes' pixel sets directly — no tier escalation, no mask
// broadening.
//
// Mode catalog (fixed):
//   LAND        — non-road, non-naval pixels of land subhexes that pass
//                 the assigned-weight rule (subhex class weight ≤ parent
//                 hex's terrain weight). Heavier subhexes are excluded.
//   ROAD        — road / city pixels that DO NOT touch thick river, and
//                 whose owning road component has at least
//                 MIN_PIXELS_PER_PATH_HEX pixels. Tiny road scraps fall
//                 through into LAND (no road discount for them).
//   NAVAL       — naval-class subhex pixels (Sea / Lake / Ocean) that
//                 aren't blocked by thick river.
//   ROAD_FERRY  — road / city pixels that DO touch thick river. Only
//                 ferry hexes produce these. Cost = road weight + Ferry
//                 surcharge, baked in (so dijkstra optimises for the
//                 same number the UI displays).
//
// HEX_MODES: Map<hex_id, Map<mode_name, modeInfo>>
//   modeInfo = { mode, kind, pixels: Uint32Array, cost: number, isFerry: bool }
//   `mode` is the unique per-hex name like "LAND#0", "LAND#1", "ROAD#0".
//   `kind` is the underlying class ("LAND" / "ROAD" / "NAVAL" / "ROAD_FERRY").
//   Each kind's pixel bucket inside the hex is flood-filled into
//   8-connected components — so a hex whose land is split by a thick river
//   gets two LAND nodes (LAND#0, LAND#1) with no in-hex edge between them,
//   and dijkstra can't teleport across.
//
// HEX_MODE_NEIGHBORS: Map<"hex:mode", Set<"hex:mode">>
//   An edge means dijkstra can move from one to the other AND the renderer
//   can draw a line that does so (8-connected pixel-adjacency, no
//   corner-cut). Both intra-hex (transition between modes inside a hex)
//   and cross-hex (border crossings) are encoded here.
let HEX_MODES = null;
let HEX_MODE_NEIGHBORS = null;
// Debug feature — manual override of which mode dijkstra is allowed to use
// for a specific hex. Map<hex_id, mode_name>. When set, dijkstraHexModePath
// skips edges into or out of any non-override mode of that hex, effectively
// forcing the path to traverse the hex via the chosen mode (or fail to
// reach it). Persisted only in memory; set via the right-click menu on the
// map. Useful for probing "what if dijkstra had picked combo X for this
// hex" without changing weights.
let HEX_MODE_OVERRIDES = new Map();
// Per-pixel mode index — populated by precomputeHexModes. Lets
// precomputeHexModeNeighbors and hexModeAtPixel resolve "which mode-node
// owns this pixel" in O(1). 0 means "no mode" (water barrier, off-map).
// Component index is per-(hex, kind) — same as the suffix in the mode name.
let PIX_MODE_KIND = null;  // Uint8Array: 0 none, 1 LAND, 2 ROAD, 3 NAVAL, 4 ROAD_FERRY, 5 FORD
let PIX_MODE_COMP = null;  // Uint16Array: component index within (hex, kind)
const MODE_KIND_NAMES = ["", "LAND", "ROAD", "NAVAL", "ROAD_FERRY", "FORD"];
const MODE_KIND_NUMS  = { LAND: 1, ROAD: 2, NAVAL: 3, ROAD_FERRY: 4, FORD: 5 };
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
// Pre-computed set of SUBHEX ids that contain at least one river pixel.
// (rivers.png — thick or thin, no distinction). Used by the ferry road+river
// subhex tier in restrict(): inside a ferry hex, if road-only fill fails to
// reach From->To, broaden to every pixel of every road OR river subhex of
// the hex before falling back to a full-hex restore.
let RIVER_SUBHEXES = null;
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


// ============================================================================
// Minimal pure-JS PNG decoder — used for layers tagged with `prerasterise`
// (e.g. Borders.png) where the browser's <img> and createImageBitmap
// decoders both binarise partial-alpha pixels to 0/255 despite the
// colorSpaceConversion/premultiplyAlpha hints. By owning the decode we
// hand `putImageData` the literal RGBA bytes from the PNG IDAT — no
// gamma, no premultiplication, no colour-space surgery.
//
// Scope: 8-bit / channel, non-interlaced, colour-type 6 (RGBA). The
// loader catches a throw and falls back to the createImageBitmap path
// for any PNG outside this slice, so we don't have to handle palette,
// 16-bit, grayscale, or Adam7 interlace.
//
// Uses DecompressionStream("deflate") — available in every modern
// browser, no zlib dependency.
// ============================================================================
async function decodePngRgba(bytes) {
  // PNG signature
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 8) throw new Error("PNG: too short");
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== sig[i]) throw new Error("PNG: bad signature");
  }
  let offset = 8;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idatChunks = [];
  let totalIdat = 0;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) throw new Error("PNG: truncated chunk header");
    const length = dv.getUint32(offset, false); offset += 4;
    const type =
      String.fromCharCode(bytes[offset]) +
      String.fromCharCode(bytes[offset + 1]) +
      String.fromCharCode(bytes[offset + 2]) +
      String.fromCharCode(bytes[offset + 3]);
    offset += 4;
    if (offset + length + 4 > bytes.length) throw new Error("PNG: truncated chunk body (" + type + ")");
    if (type === "IHDR") {
      width      = dv.getUint32(offset, false);
      height     = dv.getUint32(offset + 4, false);
      bitDepth   = bytes[offset + 8];
      colorType  = bytes[offset + 9];
      // bytes+10 compression, +11 filter — both must be 0 per spec.
      interlace  = bytes[offset + 12];
    } else if (type === "IDAT") {
      // Capture (subarray, no copy) — we'll splice them into a single
      // stream input below.
      idatChunks.push(bytes.subarray(offset, offset + length));
      totalIdat += length;
    } else if (type === "IEND") {
      break;
    }
    offset += length + 4; // skip data + CRC
  }
  if (bitDepth !== 8) throw new Error("PNG: unsupported bit depth " + bitDepth);
  if (colorType !== 6) throw new Error("PNG: unsupported colour type " + colorType + " (need RGBA)");
  if (interlace !== 0) throw new Error("PNG: interlace not supported");
  if (idatChunks.length === 0) throw new Error("PNG: no IDAT");

  // Glue the IDAT payloads into one zlib stream.
  const zlib = new Uint8Array(totalIdat);
  {
    let o = 0;
    for (const c of idatChunks) { zlib.set(c, o); o += c.length; }
  }

  // DecompressionStream("deflate") expects a zlib-wrapped deflate stream
  // (which is what PNG's IDAT payload is — 2-byte zlib header + DEFLATE
  // + 4-byte Adler32). Modern browsers accept it as-is; some older ones
  // want raw deflate. Try "deflate" first, fall back to "deflate-raw" by
  // stripping the 2-byte header.
  let inflated;
  try {
    inflated = await _inflate(zlib, "deflate");
  } catch (e) {
    // Strip zlib header + trailer and retry with deflate-raw.
    if (zlib.length < 6) throw e;
    const raw = zlib.subarray(2, zlib.length - 4);
    inflated = await _inflate(raw, "deflate-raw");
  }

  // Unfilter. PNG RGBA 8-bit: each scanline is 1 filter byte + width*4 data bytes.
  const bpp = 4;             // bytes per pixel (RGBA)
  const stride = width * bpp;
  const expected = height * (stride + 1);
  if (inflated.length < expected) {
    throw new Error("PNG: inflated stream short — expected " + expected + " got " + inflated.length);
  }
  const out = new Uint8ClampedArray(width * height * 4);
  let inPos = 0;
  let prevRow = new Uint8Array(stride); // all zeros for first row
  const curRow = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = inflated[inPos++];
    // Copy raw scanline (still-filtered) into curRow.
    for (let i = 0; i < stride; i++) curRow[i] = inflated[inPos + i];
    inPos += stride;
    switch (filter) {
      case 0: // None
        break;
      case 1: // Sub: x + left
        for (let i = bpp; i < stride; i++) {
          curRow[i] = (curRow[i] + curRow[i - bpp]) & 0xff;
        }
        break;
      case 2: // Up: x + above
        for (let i = 0; i < stride; i++) {
          curRow[i] = (curRow[i] + prevRow[i]) & 0xff;
        }
        break;
      case 3: // Average: x + floor((left + above) / 2)
        for (let i = 0; i < stride; i++) {
          const left = i >= bpp ? curRow[i - bpp] : 0;
          const above = prevRow[i];
          curRow[i] = (curRow[i] + ((left + above) >> 1)) & 0xff;
        }
        break;
      case 4: // Paeth
        for (let i = 0; i < stride; i++) {
          const left   = i >= bpp ? curRow[i - bpp] : 0;
          const above  = prevRow[i];
          const upLeft = i >= bpp ? prevRow[i - bpp] : 0;
          curRow[i] = (curRow[i] + _paeth(left, above, upLeft)) & 0xff;
        }
        break;
      default:
        throw new Error("PNG: unknown filter type " + filter);
    }
    // Pour curRow into the output buffer.
    const dst = y * stride;
    for (let i = 0; i < stride; i++) out[dst + i] = curRow[i];
    // Swap rows.
    const tmp = prevRow; prevRow = curRow.slice(); // copy because we reuse curRow
    // (Using slice keeps prevRow stable while we overwrite curRow next iter.)
    // We could double-buffer to avoid the slice, but height is ~2k so cheap.
    void tmp;
  }
  return { width, height, rgba: out };
}

function _paeth(a, b, c) {
  // a = left, b = above, c = upper-left
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

async function _inflate(bytes, format) {
  // bytes can be a Uint8Array view; wrap as a Response body for the stream.
  const stream = new Response(bytes).body.pipeThrough(new DecompressionStream(format));
  const reader = stream.getReader();
  const parts = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    parts.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
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
//
// Caching strategy: the CSV text is persisted in localStorage so subsequent
// loads can populate HEX_TERRAIN instantly without waiting on the network.
// A background fetch then re-pulls the live sheet; if it differs from the
// cached copy, the new version is written to localStorage AND hot-swapped
// into the running session (mode graph re-baked, routes rebuilt). This
// keeps cold-start fast while letting sheet edits propagate without a
// manual reload.
const TERRAIN_CSV_CACHE_KEY = "ravages.hexTerrainCSV.v1";
function getCachedTerrainCSV() {
  try { return localStorage.getItem(TERRAIN_CSV_CACHE_KEY); }
  catch (e) { return null; }
}
function setCachedTerrainCSV(text) {
  try { localStorage.setItem(TERRAIN_CSV_CACHE_KEY, text); }
  catch (e) { /* quota exceeded / storage disabled — non-fatal */ }
}

// Parse a CSV text into the four data structures we extract from the
// hex-terrain sheet. Factored out so the same code applies whether the
// CSV came from localStorage or the network.
function parseHexTerrainCSV(text) {
  const out = { terrains: new Map(), strongholds: new Set(), rivers: new Set(), roads: new Set() };
  const rows = parseCSV(text);
  if (rows.length === 0) return out;
  const header = rows[0];
  let iId = header.findIndex(h => /hex/i.test(h));
  let iTerrain = header.findIndex(h => /terrain/i.test(h));
  if (iId < 0) iId = 0;
  if (iTerrain < 0) iTerrain = 1;
  const iStronghold = header.findIndex(h => /stronghold|fort|castle/i.test(h));
  const iRiver      = header.findIndex(h => /river/i.test(h));
  const iRoad       = header.findIndex(h => /road/i.test(h));
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length === 0) continue;
    const id = parseInt(row[iId], 10);
    if (!Number.isFinite(id)) continue;
    const terrain = (row[iTerrain] || "").trim();
    if (terrain) out.terrains.set(id, terrain);
    if (iStronghold >= 0 && isYes(row[iStronghold])) out.strongholds.add(id);
    if (iRiver      >= 0 && isYes(row[iRiver]))      out.rivers.add(id);
    if (iRoad       >= 0 && isYes(row[iRoad]))       out.roads.add(id);
  }
  return out;
}

// Replace the live HEX_TERRAIN / HEX_STRONGHOLD / HEX_RIVER / HEX_ROAD
// maps with freshly parsed data. Used both at first load and when a
// background refresh detects a changed sheet.
function applyHexTerrainData(data) {
  HEX_TERRAIN    = data.terrains;
  HEX_STRONGHOLD = new Map();
  HEX_RIVER      = new Map();
  HEX_ROAD       = new Map();
  for (const id of data.strongholds) HEX_STRONGHOLD.set(id, true);
  for (const id of data.rivers)      HEX_RIVER.set(id, true);
  for (const id of data.roads)       HEX_ROAD.set(id, true);
}

async function loadHexTerrains() {
  HEX_STRONGHOLD = new Map();
  HEX_RIVER = new Map();
  HEX_ROAD = new Map();
  const cached = getCachedTerrainCSV();
  if (cached) {
    // Fast path: use the cached CSV immediately so init doesn't block
    // on the network. Kick off a background refresh that will hot-swap
    // the live state if the sheet has changed since the snapshot.
    try {
      const data = parseHexTerrainCSV(cached);
      applyHexTerrainData(data);
      console.log(`Loaded ${HEX_TERRAIN.size} hex terrain entries from cached CSV `
        + `(${HEX_STRONGHOLD.size} strongholds, ${HEX_RIVER.size} rivers, ${HEX_ROAD.size} roads). `
        + `Background refresh queued.`);
      refreshHexTerrainsInBackground(cached);
      return HEX_TERRAIN;
    } catch (e) {
      console.warn("Failed to parse cached terrain CSV — falling back to network:", e);
    }
  }
  // First visit (or unparseable cache): fetch the live sheet, save it,
  // and use it. This is the only path that blocks init on the network.
  try {
    const r = await fetch(HEX_TERRAIN_CSV_URL, { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const text = await r.text();
    const rows = parseCSV(text);
    if (rows.length === 0) throw new Error("empty CSV");
    setCachedTerrainCSV(text);
    const data = parseHexTerrainCSV(text);
    applyHexTerrainData(data);
    console.log(`Loaded ${HEX_TERRAIN.size} hex terrain entries from sheet `
      + `(${HEX_STRONGHOLD.size} strongholds, ${HEX_RIVER.size} rivers, ${HEX_ROAD.size} roads). `
      + `Cached for next session.`);
    return HEX_TERRAIN;
  } catch (e) {
    console.warn("Failed to load terrain CSV:", e);
    return new Map();
  }
}

// Background sheet refresh — fires after init completes if a cached CSV
// was used. Compares the live sheet text to the cached snapshot; if it
// differs, writes the new text to localStorage and re-runs every
// derived precompute that depends on HEX_TERRAIN so the running session
// reflects the new sheet without a manual reload.
async function refreshHexTerrainsInBackground(cachedText) {
  try {
    const r = await fetch(HEX_TERRAIN_CSV_URL, { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const text = await r.text();
    if (text === cachedText) {
      console.log("Background terrain refresh: sheet unchanged.");
      return;
    }
    setCachedTerrainCSV(text);
    const data = parseHexTerrainCSV(text);
    applyHexTerrainData(data);
    console.log(`Background terrain refresh: sheet changed — applying new version `
      + `(${HEX_TERRAIN.size} terrain entries, ${HEX_STRONGHOLD.size} strongholds, `
      + `${HEX_RIVER.size} rivers, ${HEX_ROAD.size} roads).`);
    // Re-run terrain-dependent precomputes. LAND_HEX_WATER_PIXELS keys
    // off the canonical hex terrain; HEX_MODES bakes per-hex terrain
    // into every mode's cost. Routes need a rebuild after the mode
    // graph is re-baked so segment costs and chosen modes refresh.
    if (typeof precomputeLandHexWaterPixels === "function") precomputeLandHexWaterPixels();
    if (typeof recomputeHexModeGraph === "function") recomputeHexModeGraph();
    if (typeof rebuildAllRoutes === "function") rebuildAllRoutes();
    if (typeof renderSelection === "function") renderSelection();
    if (typeof updateEndpoints === "function") updateEndpoints();
    if (typeof updatePathInfo === "function") updatePathInfo();
    if (typeof updateStatus === "function") updateStatus();
  } catch (e) {
    console.warn("Background terrain refresh failed:", e);
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

// ============================================================================
// Graph cache — serialises the heavy static precomputes (pixel index, masks,
// per-hex pixel lists, subhex-component flood-fill, blocked-edge set,
// component-neighbor map) to a single binary blob so subsequent page loads
// can skip the bulk of the precompute work.
//
// The cache holds EVERYTHING UP TO precomputeSubhexComponentNeighbors. The
// hex-mode graph (precomputeHexModes + precomputeHexModeNeighbors) depends
// on the weights table and MIN_PIXELS_PER_PATH_HEX so it is NOT cached —
// it rebuilds cheaply on top of the cached subhex/component layer every
// load.
//
// File format (little-endian throughout):
//
//   bytes 0..7   = "RVGCACHE" (8 magic bytes, no terminator)
//   bytes 8..11  = u32 version (CACHE_VERSION, bump on precompute changes)
//   bytes 12..15 = u32 section count
//
// Then `section count` sections, each:
//   u32 nameLen, name UTF-8 bytes
//   u32 typeLen, type-tag UTF-8 bytes
//   u32 payloadLen, payload bytes
//
// Type tags encode the payload shape:
//   "u8" / "u16" / "u32"   — raw typed-array bytes
//   "set_i"                — u32 count, then count u32 ids
//   "set_s"                — u32 count, then for each item u16 len + UTF-8
//   "map_i_n"              — u32 count, then for each (u32 key, u32 value)
//   "map_s_n"              — u32 count, then for each (u16 keyLen + UTF-8 + u32 value)
//   "map_i_u32"            — u32 count, then for each (u32 key, u32 arrLen, u32[arrLen])
//   "map_s_u32"            — u32 count, then for each (u16 keyLen + UTF-8 + u32 arrLen + u32[arrLen])
//   "map_s_set_s"          — u32 count, then for each (u16 keyLen + UTF-8 + u32 setSize + setSize x (u16 valLen + UTF-8))
//
// To regenerate when the precompute logic OR the source data (PNG layers,
// hex_data.json, subhex_data.json, neighbors.json) changes:
//   1. Bump CACHE_VERSION below so the old file fails the version check.
//   2. Open the page; the loader will fall back to the full precompute.
//   3. Click "Dump graph cache" in the Settings → Path-line panel.
//   4. Save the downloaded `graph_cache.bin` next to neighbors.json.
//   5. Subsequent loads skip the heavy precomputes.
// ============================================================================
const CACHE_VERSION = 26;
const CACHE_MAGIC = "RVGCACHE";

// ---- low-level writers ----
function _cacheBuildSection(name, type, payload) {
  // payload is a Uint8Array. Returns a Uint8Array containing the full
  // section header + payload.
  const nameBytes = new TextEncoder().encode(name);
  const typeBytes = new TextEncoder().encode(type);
  const total = 4 + nameBytes.length + 4 + typeBytes.length + 4 + payload.length;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  let o = 0;
  dv.setUint32(o, nameBytes.length, true); o += 4;
  out.set(nameBytes, o); o += nameBytes.length;
  dv.setUint32(o, typeBytes.length, true); o += 4;
  out.set(typeBytes, o); o += typeBytes.length;
  dv.setUint32(o, payload.length, true); o += 4;
  out.set(payload, o);
  return out;
}

// ---- payload encoders (each returns a Uint8Array) ----
function _encU8(arr) {
  if (!arr) return new Uint8Array(0);
  return new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
}
function _encU16(arr) {
  if (!arr) return new Uint8Array(0);
  return new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
}
function _encU32(arr) {
  if (!arr) return new Uint8Array(0);
  return new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
}
function _encSetI(set) {
  if (!set) return new Uint8Array(4); // count 0
  const out = new Uint8Array(4 + set.size * 4);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, set.size, true);
  let o = 4;
  for (const id of set) { dv.setUint32(o, id, true); o += 4; }
  return out;
}
function _encSetS(set) {
  if (!set) return new Uint8Array(4);
  const enc = new TextEncoder();
  const items = [];
  let totalStr = 0;
  for (const s of set) {
    const b = enc.encode(s);
    items.push(b);
    totalStr += 2 + b.length;
  }
  const out = new Uint8Array(4 + totalStr);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, items.length, true);
  let o = 4;
  for (const b of items) {
    dv.setUint16(o, b.length, true); o += 2;
    out.set(b, o); o += b.length;
  }
  return out;
}
function _encMapIN(map) {
  if (!map) return new Uint8Array(4);
  const out = new Uint8Array(4 + map.size * 8);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, map.size, true);
  let o = 4;
  for (const [k, v] of map) {
    dv.setUint32(o, k, true); o += 4;
    dv.setUint32(o, v, true); o += 4;
  }
  return out;
}
function _encMapSN(map) {
  if (!map) return new Uint8Array(4);
  const enc = new TextEncoder();
  const entries = [];
  let totalStr = 0;
  for (const [k, v] of map) {
    const kb = enc.encode(k);
    entries.push([kb, v]);
    totalStr += 2 + kb.length + 4;
  }
  const out = new Uint8Array(4 + totalStr);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, entries.length, true);
  let o = 4;
  for (const [kb, v] of entries) {
    dv.setUint16(o, kb.length, true); o += 2;
    out.set(kb, o); o += kb.length;
    dv.setUint32(o, v, true); o += 4;
  }
  return out;
}
function _encMapIU32(map) {
  if (!map) return new Uint8Array(4);
  // Two-pass: compute total size, then write.
  let total = 4;
  for (const [k, arr] of map) total += 4 + 4 + arr.byteLength;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, map.size, true);
  let o = 4;
  for (const [k, arr] of map) {
    dv.setUint32(o, k, true); o += 4;
    dv.setUint32(o, arr.length, true); o += 4;
    out.set(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength), o);
    o += arr.byteLength;
  }
  return out;
}
function _encMapSU32(map) {
  if (!map) return new Uint8Array(4);
  const enc = new TextEncoder();
  const entries = [];
  let total = 4;
  for (const [k, arr] of map) {
    const kb = enc.encode(k);
    entries.push([kb, arr]);
    total += 2 + kb.length + 4 + arr.byteLength;
  }
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, entries.length, true);
  let o = 4;
  for (const [kb, arr] of entries) {
    dv.setUint16(o, kb.length, true); o += 2;
    out.set(kb, o); o += kb.length;
    dv.setUint32(o, arr.length, true); o += 4;
    out.set(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength), o);
    o += arr.byteLength;
  }
  return out;
}
function _encMapSSetS(map) {
  if (!map) return new Uint8Array(4);
  const enc = new TextEncoder();
  const entries = [];
  let total = 4;
  for (const [k, set] of map) {
    const kb = enc.encode(k);
    const items = [];
    let inner = 0;
    for (const v of set) {
      const vb = enc.encode(v);
      items.push(vb);
      inner += 2 + vb.length;
    }
    entries.push([kb, items]);
    total += 2 + kb.length + 4 + inner;
  }
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, entries.length, true);
  let o = 4;
  for (const [kb, items] of entries) {
    dv.setUint16(o, kb.length, true); o += 2;
    out.set(kb, o); o += kb.length;
    dv.setUint32(o, items.length, true); o += 4;
    for (const vb of items) {
      dv.setUint16(o, vb.length, true); o += 2;
      out.set(vb, o); o += vb.length;
    }
  }
  return out;
}

// ---- payload decoders ----
// Each takes a DataView and a starting offset; returns { value, offset }.
function _decU8(dv, o, payloadLen) {
  // payloadLen == 0 is the "null/absent" sentinel — preserves the null
  // semantics downstream code expects (vs. accidentally returning an
  // empty array that silently no-ops on every lookup).
  if (payloadLen === 0) return { value: null, offset: o };
  // Copy out (otherwise the typed array would share the cache buffer which
  // is going to be garbage-collected after deserialization).
  const out = new Uint8Array(payloadLen);
  out.set(new Uint8Array(dv.buffer, dv.byteOffset + o, payloadLen));
  return { value: out, offset: o + payloadLen };
}
function _decU16(dv, o, payloadLen) {
  if (payloadLen === 0) return { value: null, offset: o };
  // Copy via a fresh ArrayBuffer to guarantee 2-byte alignment.
  const out = new Uint16Array(payloadLen / 2);
  const src = new Uint8Array(dv.buffer, dv.byteOffset + o, payloadLen);
  new Uint8Array(out.buffer).set(src);
  return { value: out, offset: o + payloadLen };
}
function _decU32(dv, o, payloadLen) {
  if (payloadLen === 0) return { value: null, offset: o };
  const out = new Uint32Array(payloadLen / 4);
  const src = new Uint8Array(dv.buffer, dv.byteOffset + o, payloadLen);
  new Uint8Array(out.buffer).set(src);
  return { value: out, offset: o + payloadLen };
}
function _decSetI(dv, o) {
  const count = dv.getUint32(o, true); o += 4;
  const s = new Set();
  for (let i = 0; i < count; i++) { s.add(dv.getUint32(o, true)); o += 4; }
  return { value: s, offset: o };
}
function _decSetS(dv, o) {
  const count = dv.getUint32(o, true); o += 4;
  const s = new Set();
  const td = new TextDecoder();
  for (let i = 0; i < count; i++) {
    const len = dv.getUint16(o, true); o += 2;
    const bytes = new Uint8Array(dv.buffer, dv.byteOffset + o, len);
    s.add(td.decode(bytes)); o += len;
  }
  return { value: s, offset: o };
}
function _decMapIN(dv, o) {
  const count = dv.getUint32(o, true); o += 4;
  const m = new Map();
  for (let i = 0; i < count; i++) {
    const k = dv.getUint32(o, true); o += 4;
    const v = dv.getUint32(o, true); o += 4;
    m.set(k, v);
  }
  return { value: m, offset: o };
}
function _decMapSN(dv, o) {
  const count = dv.getUint32(o, true); o += 4;
  const m = new Map();
  const td = new TextDecoder();
  for (let i = 0; i < count; i++) {
    const len = dv.getUint16(o, true); o += 2;
    const k = td.decode(new Uint8Array(dv.buffer, dv.byteOffset + o, len));
    o += len;
    const v = dv.getUint32(o, true); o += 4;
    m.set(k, v);
  }
  return { value: m, offset: o };
}
function _decMapIU32(dv, o) {
  const count = dv.getUint32(o, true); o += 4;
  const m = new Map();
  for (let i = 0; i < count; i++) {
    const k = dv.getUint32(o, true); o += 4;
    const arrLen = dv.getUint32(o, true); o += 4;
    const arr = new Uint32Array(arrLen);
    const src = new Uint8Array(dv.buffer, dv.byteOffset + o, arrLen * 4);
    new Uint8Array(arr.buffer).set(src);
    o += arrLen * 4;
    m.set(k, arr);
  }
  return { value: m, offset: o };
}
function _decMapSU32(dv, o) {
  const count = dv.getUint32(o, true); o += 4;
  const m = new Map();
  const td = new TextDecoder();
  for (let i = 0; i < count; i++) {
    const klen = dv.getUint16(o, true); o += 2;
    const k = td.decode(new Uint8Array(dv.buffer, dv.byteOffset + o, klen));
    o += klen;
    const arrLen = dv.getUint32(o, true); o += 4;
    const arr = new Uint32Array(arrLen);
    const src = new Uint8Array(dv.buffer, dv.byteOffset + o, arrLen * 4);
    new Uint8Array(arr.buffer).set(src);
    o += arrLen * 4;
    m.set(k, arr);
  }
  return { value: m, offset: o };
}
function _decMapSSetS(dv, o) {
  const count = dv.getUint32(o, true); o += 4;
  const m = new Map();
  const td = new TextDecoder();
  for (let i = 0; i < count; i++) {
    const klen = dv.getUint16(o, true); o += 2;
    const k = td.decode(new Uint8Array(dv.buffer, dv.byteOffset + o, klen));
    o += klen;
    const setSize = dv.getUint32(o, true); o += 4;
    const s = new Set();
    for (let j = 0; j < setSize; j++) {
      const vlen = dv.getUint16(o, true); o += 2;
      const v = td.decode(new Uint8Array(dv.buffer, dv.byteOffset + o, vlen));
      o += vlen;
      s.add(v);
    }
    m.set(k, s);
  }
  return { value: m, offset: o };
}

// Manifest of cacheable globals — single source of truth for both encode
// and decode. `get` returns the live value; `set` writes the decoded value
// to the right global. `type` picks the codec.
function _cacheManifest() {
  return [
    { name: "HEX_ID_PX",                    type: "u16",         get: () => HEX_ID_PX,                    set: v => { HEX_ID_PX = v; } },
    { name: "SUBHEX_ID_PX",                 type: "u32",         get: () => SUBHEX_ID_PX,                 set: v => { SUBHEX_ID_PX = v; } },
    { name: "HEX_PIXELS",                   type: "map_i_u32",   get: () => HEX_PIXELS,                   set: v => { HEX_PIXELS = v; } },
    { name: "ROAD_PIXEL_MASK",              type: "u8",          get: () => ROAD_PIXEL_MASK,              set: v => { ROAD_PIXEL_MASK = v; } },
    { name: "ROAD_ONLY_PIXEL_MASK",         type: "u8",          get: () => ROAD_ONLY_PIXEL_MASK,         set: v => { ROAD_ONLY_PIXEL_MASK = v; } },
    { name: "RIVER_PIXEL_MASK",             type: "u8",          get: () => RIVER_PIXEL_MASK,             set: v => { RIVER_PIXEL_MASK = v; } },
    { name: "STRICT_RIVER_PIXEL_MASK",      type: "u8",          get: () => STRICT_RIVER_PIXEL_MASK,      set: v => { STRICT_RIVER_PIXEL_MASK = v; } },
    { name: "THICK_RIVER_PIXEL_MASK",       type: "u8",          get: () => THICK_RIVER_PIXEL_MASK,       set: v => { THICK_RIVER_PIXEL_MASK = v; } },
    // THICK_RIVER_BLOCKING_MASK is the same reference as THICK_RIVER_PIXEL_MASK
    // (see buildPixelMasks). Skip writing a duplicate copy; we re-alias on load.
    { name: "THIN_RIVER_EXPANDED_MASK",     type: "u8",          get: () => THIN_RIVER_EXPANDED_MASK,     set: v => { THIN_RIVER_EXPANDED_MASK = v; } },
    { name: "HEX_ROAD_PIXELS",              type: "map_i_u32",   get: () => HEX_ROAD_PIXELS,              set: v => { HEX_ROAD_PIXELS = v; } },
    { name: "HEX_RIVER_PIXELS",             type: "map_i_u32",   get: () => HEX_RIVER_PIXELS,             set: v => { HEX_RIVER_PIXELS = v; } },
    { name: "HEX_HAS_ROAD",                 type: "set_i",       get: () => HEX_HAS_ROAD,                 set: v => { HEX_HAS_ROAD = v; } },
    { name: "ROAD_SUBHEXES",                type: "set_i",       get: () => ROAD_SUBHEXES,                set: v => { ROAD_SUBHEXES = v; } },
    { name: "RIVER_SUBHEXES",               type: "set_i",       get: () => RIVER_SUBHEXES,               set: v => { RIVER_SUBHEXES = v; } },
    { name: "FERRY_HEXES",                  type: "set_i",       get: () => FERRY_HEXES,                  set: v => { FERRY_HEXES = v; } },
    { name: "LAND_HEX_WATER_PIXELS",        type: "map_i_u32",   get: () => LAND_HEX_WATER_PIXELS,        set: v => { LAND_HEX_WATER_PIXELS = v; } },
    { name: "SUBHEX_PIXEL_COMPONENT",       type: "u16",         get: () => SUBHEX_PIXEL_COMPONENT,       set: v => { SUBHEX_PIXEL_COMPONENT = v; } },
    { name: "SUBHEX_COMPONENT_COUNT",       type: "map_i_n",     get: () => SUBHEX_COMPONENT_COUNT,       set: v => { SUBHEX_COMPONENT_COUNT = v; } },
    { name: "SUBHEX_COMPONENT_PIXEL_COUNT", type: "map_s_n",     get: () => SUBHEX_COMPONENT_PIXEL_COUNT, set: v => { SUBHEX_COMPONENT_PIXEL_COUNT = v; } },
    { name: "SUBHEX_COMPONENT_PIXELS",      type: "map_s_u32",   get: () => SUBHEX_COMPONENT_PIXELS,      set: v => { SUBHEX_COMPONENT_PIXELS = v; } },
    { name: "ROAD_COMPONENTS",              type: "set_s",       get: () => ROAD_COMPONENTS,              set: v => { ROAD_COMPONENTS = v; } },
    { name: "THICK_RIVER_COMPONENTS",       type: "set_s",       get: () => THICK_RIVER_COMPONENTS,       set: v => { THICK_RIVER_COMPONENTS = v; } },
    { name: "BLOCKED_SUBHEX_EDGES",         type: "set_s",       get: () => BLOCKED_SUBHEX_EDGES,         set: v => { BLOCKED_SUBHEX_EDGES = v; } },
    { name: "SUBHEX_COMPONENT_NEIGHBORS",   type: "map_s_set_s", get: () => SUBHEX_COMPONENT_NEIGHBORS,   set: v => { SUBHEX_COMPONENT_NEIGHBORS = v; } },
  ];
}

function _encodeBySection(type, value) {
  switch (type) {
    case "u8":           return _encU8(value);
    case "u16":          return _encU16(value);
    case "u32":          return _encU32(value);
    case "set_i":        return _encSetI(value);
    case "set_s":        return _encSetS(value);
    case "map_i_n":      return _encMapIN(value);
    case "map_s_n":      return _encMapSN(value);
    case "map_i_u32":    return _encMapIU32(value);
    case "map_s_u32":    return _encMapSU32(value);
    case "map_s_set_s":  return _encMapSSetS(value);
    default: throw new Error("Unknown cache section type: " + type);
  }
}

function _decodeBySection(type, dv, payloadStart, payloadLen) {
  switch (type) {
    case "u8":           return _decU8(dv, payloadStart, payloadLen).value;
    case "u16":          return _decU16(dv, payloadStart, payloadLen).value;
    case "u32":          return _decU32(dv, payloadStart, payloadLen).value;
    case "set_i":        return _decSetI(dv, payloadStart).value;
    case "set_s":        return _decSetS(dv, payloadStart).value;
    case "map_i_n":      return _decMapIN(dv, payloadStart).value;
    case "map_s_n":      return _decMapSN(dv, payloadStart).value;
    case "map_i_u32":    return _decMapIU32(dv, payloadStart).value;
    case "map_s_u32":    return _decMapSU32(dv, payloadStart).value;
    case "map_s_set_s": return _decMapSSetS(dv, payloadStart).value;
    default: throw new Error("Unknown cache section type: " + type);
  }
}

// Build the binary cache blob from the currently-populated globals.
// Caller is responsible for running all the precomputes first.
function buildGraphCacheBlob() {
  const manifest = _cacheManifest();
  // Header: 8 magic + u32 version + u32 sectionCount = 16 bytes.
  const header = new Uint8Array(16);
  const dv = new DataView(header.buffer);
  const magicBytes = new TextEncoder().encode(CACHE_MAGIC);
  header.set(magicBytes, 0);
  dv.setUint32(8,  CACHE_VERSION,    true);
  dv.setUint32(12, manifest.length,  true);

  const chunks = [header];
  for (const entry of manifest) {
    const live = entry.get();
    const payload = _encodeBySection(entry.type, live);
    chunks.push(_cacheBuildSection(entry.name, entry.type, payload));
  }
  return new Blob(chunks, { type: "application/octet-stream" });
}

// Trigger a browser download of the current cache. Wired to the
// "Dump graph cache" button in the Settings → Path-line panel.
function dumpGraphCache() {
  const blob = buildGraphCacheBlob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "graph_cache.bin";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  console.log(`graph_cache.bin generated (${(blob.size / (1024*1024)).toFixed(1)} MB). ` +
              `Save it next to neighbors.json to enable cache-fast startup.`);
}

// Attempt to load the cache file. Returns true on success (globals populated,
// caller can skip the heavy precomputes), false on absence / version mismatch /
// parse error. Never throws — always returns false on any failure path so the
// caller can fall back to the full precompute.
async function tryLoadGraphCache() {
  let buf;
  try {
    const r = await fetch("graph_cache.bin", { cache: "no-store" });
    if (!r.ok) return false;
    buf = await r.arrayBuffer();
  } catch (e) {
    return false;
  }
  if (buf.byteLength < 16) return false;
  const dv = new DataView(buf);
  // Magic
  const magic = new TextDecoder().decode(new Uint8Array(buf, 0, 8));
  if (magic !== CACHE_MAGIC) {
    console.warn("graph_cache.bin: bad magic, ignoring");
    return false;
  }
  const version = dv.getUint32(8, true);
  if (version !== CACHE_VERSION) {
    console.warn(`graph_cache.bin: version ${version} != current ${CACHE_VERSION}, recomputing`);
    return false;
  }
  const sectionCount = dv.getUint32(12, true);
  const manifest = _cacheManifest();
  const byName = new Map();
  for (const e of manifest) byName.set(e.name, e);

  const td = new TextDecoder();
  let o = 16;
  try {
    for (let i = 0; i < sectionCount; i++) {
      const nameLen = dv.getUint32(o, true); o += 4;
      const name = td.decode(new Uint8Array(buf, o, nameLen)); o += nameLen;
      const typeLen = dv.getUint32(o, true); o += 4;
      const type = td.decode(new Uint8Array(buf, o, typeLen)); o += typeLen;
      const payloadLen = dv.getUint32(o, true); o += 4;
      const entry = byName.get(name);
      if (entry && entry.type === type) {
        const value = _decodeBySection(type, dv, o, payloadLen);
        entry.set(value);
      } else if (entry) {
        console.warn(`graph_cache.bin: section ${name} type mismatch (${type} vs expected ${entry.type}), skipping`);
      }
      // Else: unknown section, just skip past it.
      o += payloadLen;
    }
  } catch (e) {
    console.warn("graph_cache.bin: parse error, falling back to recompute:", e);
    return false;
  }
  // Re-alias THICK_RIVER_BLOCKING_MASK to THICK_RIVER_PIXEL_MASK (the two are
  // semantically the same object; buildPixelMasks assigns one to the other).
  THICK_RIVER_BLOCKING_MASK = THICK_RIVER_PIXEL_MASK;
  return true;
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
  // Kick off the layer PNG load in parallel — we always need IMAGES[] for
  // rendering even when the precompute cache is present, so we may as well
  // overlap that work with the cache fetch / precompute.
  const layersPromise = Promise.all(LAYERS.map(async (l) => {
    try {
      if (l.prerasterise) {
        // Some RGBA PNGs (notably Borders.png) lose their partial-alpha
        // pixels when decoded via the browser's PNG decoder — both <img>
        // and createImageBitmap binarise partial-alpha pixels to 0/255
        // regardless of colorSpaceConversion/premultiplyAlpha hints.
        //
        // Bypass the browser PNG decoder entirely: fetch the file as
        // bytes, decode the PNG ourselves via decodePngRgba (chunk parse +
        // DecompressionStream("deflate") + per-row unfilter), and drop the
        // raw RGBA bytes onto a canvas via putImageData. putImageData
        // skips alpha premultiplication and colour-space conversion — the
        // exact two operations that were destroying the partial-alpha
        // pixels — so every alpha value in the file lands on the canvas
        // unchanged. The opacity slider still applies via mapCtx.globalAlpha.
        //
        // Fallback chain: manual decode -> createImageBitmap(no colour
        // surgery) -> plain <img>. Each level loses fidelity but at least
        // keeps the layer rendering.
        let placed = false;
        try {
          const resp = await fetch(encodeURI(l.file));
          if (!resp.ok) throw new Error("fetch failed: " + resp.status);
          const buf = await resp.arrayBuffer();
          const decoded = await decodePngRgba(new Uint8Array(buf));
          const c = document.createElement("canvas");
          c.width = decoded.width; c.height = decoded.height;
          const cx = c.getContext("2d");
          const imgData = new ImageData(decoded.rgba, decoded.width, decoded.height);
          cx.putImageData(imgData, 0, 0);
          c.naturalWidth = c.width; c.naturalHeight = c.height;
          IMAGES[l.id] = c;
          placed = true;
        } catch (decErr) {
          console.warn("Manual PNG decode failed for", l.id, "— falling back to createImageBitmap:", decErr);
        }
        if (!placed) {
          try {
            if (typeof createImageBitmap !== "function") {
              throw new Error("createImageBitmap unavailable");
            }
            const resp = await fetch(encodeURI(l.file));
            if (!resp.ok) throw new Error("fetch failed: " + resp.status);
            const blob = await resp.blob();
            const bmp = await createImageBitmap(blob, {
              colorSpaceConversion: "none",
              premultiplyAlpha: "none",
            });
            try {
              bmp.naturalWidth = bmp.width;
              bmp.naturalHeight = bmp.height;
            } catch (_) { /* read-only — handled below */ }
            if (bmp.naturalWidth === bmp.width && bmp.naturalHeight === bmp.height) {
              IMAGES[l.id] = bmp;
            } else {
              const c = document.createElement("canvas");
              c.width = bmp.width; c.height = bmp.height;
              c.getContext("2d").drawImage(bmp, 0, 0);
              c.naturalWidth = c.width; c.naturalHeight = c.height;
              IMAGES[l.id] = c;
            }
            placed = true;
          } catch (bmpErr) {
            console.warn("createImageBitmap path failed for", l.id, "— falling back to <img>:", bmpErr);
          }
        }
        if (!placed) {
          // Last-resort <img> + canvas. Partial alpha will binarise, but
          // at least the layer renders.
          const img = await loadImage(encodeURI(l.file));
          const c = document.createElement("canvas");
          c.width = img.naturalWidth; c.height = img.naturalHeight;
          c.getContext("2d").drawImage(img, 0, 0);
          c.naturalWidth = c.width; c.naturalHeight = c.height;
          IMAGES[l.id] = c;
        }
      } else {
        IMAGES[l.id] = await loadImage(encodeURI(l.file));
      }
    } catch (e) {
      console.warn("Layer load failed:", l.id, e);
      IMAGES[l.id] = null;
    }
  }));

  loadingEl.textContent = "Loading graph cache…";
  const cacheLoaded = await tryLoadGraphCache();
  if (cacheLoaded) {
    // Cache hit — we still need the PNG layers for rendering. Wait for
    // them, then build mode graph (which depends on tunable settings
    // and so is never cached).
    loadingEl.textContent = "Loading map layers…";
    await layersPromise;
    for (const c of [mapCanvas, hlCanvas]) {
      c.width = HEX_DATA.image_width; c.height = HEX_DATA.image_height;
    }
    // Rebuild LAND_HEX_WATER_PIXELS against the freshly-fetched HEX_TERRAIN.
    // The CSV lives in Google Sheets and CAN change between sessions, while
    // the rest of the cache is keyed on static map data only — re-running
    // this one cheap precompute keeps the cache valid even if the sheet's
    // edited without bumping CACHE_VERSION.
    precomputeLandHexWaterPixels();
    // RIVER_SUBHEXES wasn't in older cache files. If absent, derive it now
    // from HEX_RIVER_PIXELS (cheap; iterates only river pixels).
    if (!RIVER_SUBHEXES) precomputeRiverSubhexes();
    loadingEl.textContent = "Building mode graph…";
    // recomputeHexModeGraph builds BOTH the default-weight HEX_MODES and
    // the parallel HEX_MODES_FORCED used by forced-march route segments.
    // Calling precomputeHexModes directly here would skip the forced
    // build and leave HEX_MODES_FORCED null, silently disabling the
    // per-segment forced toggle until the user touches a weight input.
    recomputeHexModeGraph();
    loadingEl.classList.add("hidden");
    console.log("Loaded graph state from graph_cache.bin — heavy precomputes skipped.");
    return;
  }

  // No cache: run the full precompute path.
  loadingEl.textContent = "Indexing pixels…";
  precomputeHexIndexes();
  precomputeLandHexWaterPixels();
  loadingEl.textContent = "Loading map layers…";
  await layersPromise;
  for (const c of [mapCanvas, hlCanvas]) {
    c.width = HEX_DATA.image_width; c.height = HEX_DATA.image_height;
  }
  buildPixelMasks();
  precomputeHexRoadRiverPixels();
  precomputeRoadSubhexes();
  precomputeRiverSubhexes();
  precomputeFerryHexes();
  precomputeSubhexComponents();
  precomputeBlockedSubhexEdges();
  precomputeSubhexComponentNeighbors();
  // recomputeHexModeGraph builds BOTH the default-weight HEX_MODES and
  // the parallel HEX_MODES_FORCED used by forced-march route segments.
  recomputeHexModeGraph();
  loadingEl.classList.add("hidden");
}

// Recompute the mode-graph layer. Cheap (relative to flood-fill) so
// safe to call on weight changes — LAND mode pixel membership depends
// on the assigned-weight rule, and cost values are weight-derived for
// every mode. Routes need a rebuild after this to pick up changes.
function recomputeHexModeGraph() {
  // Build 8 HEX_MODES variants — 4 army-permission combos
  // (canFord × canEmbark) × 2 march modes (default / forced weights).
  // Toggling Can ford / Can embark in the army panel then just swaps
  // which variant HEX_MODES / HEX_MODES_FORCED point at, no recompute.
  //
  // The neighbor graph and the per-pixel PIX_MODE_KIND/PIX_MODE_COMP
  // lookups are built once, on the most permissive variant ("FE" on
  // default weights). Less permissive variants are strict subsets of
  // that mode set, so dijkstra walking the neighbor graph harmlessly
  // skips edges whose target mode isn't in the active variant
  // (caught by the existing `if (!vInfo) continue` guard).
  const _w  = weights, _rw = roadWeights;
  const _cf = ARMY_CAN_FORD, _ce = ARMY_CAN_EMBARK;
  // Build order ends on "FE" so PIX_MODE_KIND/COMP land in the most-
  // permissive state.
  const buildOrder = ["F_", "_E", "__", "FE"];
  const permFlags  = { "FE": [true,  true],  "F_": [true,  false],
                       "_E": [false, true],  "__": [false, false] };

  // Forced-march variants first — we want default-FE to be the LAST
  // call so the global pixel-lookup arrays + the neighbor graph reflect
  // the default-weights / all-permissions catalog.
  HEX_MODES_FORCED_VARIANTS = new Map();
  weights = forcedWeights;
  roadWeights = forcedRoadWeights;
  for (const key of buildOrder) {
    [ARMY_CAN_FORD, ARMY_CAN_EMBARK] = permFlags[key];
    precomputeHexModes();
    HEX_MODES_FORCED_VARIANTS.set(key, HEX_MODES);
  }

  // Default-march variants.
  HEX_MODES_VARIANTS = new Map();
  weights = _w; roadWeights = _rw;
  for (const key of buildOrder) {
    [ARMY_CAN_FORD, ARMY_CAN_EMBARK] = permFlags[key];
    precomputeHexModes();
    HEX_MODES_VARIANTS.set(key, HEX_MODES);
  }
  // PIX_MODE_KIND / PIX_MODE_COMP now reflect the default-FE variant
  // (last call). Build neighbors on top — every possible mode key is
  // present here, so the resulting graph covers every variant.
  precomputeHexModeNeighbors();
  addComboModeNeighbors();

  // Restore army permissions and activate the variant matching them.
  ARMY_CAN_FORD = _cf;
  ARMY_CAN_EMBARK = _ce;
  selectActiveHexModes();

  // Prune mode overrides whose pinned mode no longer exists in the
  // ACTIVE variant. The override mode might exist in some other variant
  // — keep it only if the user's currently-active permissions admit it.
  if (HEX_MODE_OVERRIDES && HEX_MODES) {
    for (const [hid, mode] of Array.from(HEX_MODE_OVERRIDES.entries())) {
      const modes = HEX_MODES.get(hid);
      if (!modes || !modes.has(mode)) HEX_MODE_OVERRIDES.delete(hid);
    }
  }
}

// Swap HEX_MODES / HEX_MODES_FORCED to point at the variant matching
// the current ARMY_CAN_FORD / ARMY_CAN_EMBARK flags. Cheap (a Map.get)
// — call after toggling either army-permission checkbox instead of
// rebuilding the mode graphs.
function selectActiveHexModes() {
  if (!HEX_MODES_VARIANTS) return;
  const key = `${ARMY_CAN_FORD ? "F" : "_"}${ARMY_CAN_EMBARK ? "E" : "_"}`;
  const v = HEX_MODES_VARIANTS.get(key);
  if (v) HEX_MODES = v;
  if (HEX_MODES_FORCED_VARIANTS) {
    const vf = HEX_MODES_FORCED_VARIANTS.get(key);
    if (vf) HEX_MODES_FORCED = vf;
  }
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
  // ROAD_ONLY_PIXEL_MASK (roads.png, no ctf) so a city or fort that
  // happens to sit on a thick river isn't promoted to a ferry — only
  // genuine road overlays mean the artwork drew a crossing.
  const roadMask = ROAD_ONLY_PIXEL_MASK || ROAD_PIXEL_MASK;
  if (!roadMask || !THICK_RIVER_PIXEL_MASK || !HEX_PIXELS) return;
  for (const [hid, pixels] of HEX_PIXELS.entries()) {
    for (let i = 0; i < pixels.length; i++) {
      const idx = pixels[i];
      if (roadMask[idx] && THICK_RIVER_PIXEL_MASK[idx]) {
        FERRY_HEXES.add(hid);
        break;
      }
    }
  }
}

// Flood-fill each subhex's non-thick pixels into connected components.
// Road and non-road pixels join the SAME component — roads don't split
// land, so a road that runs through a subhex doesn't carve the surrounding
// land into two halves. ROAD_COMPONENTS still tags any component that
// contains at least one road pixel (semantically "road-bearing"), but the
// component is no longer road-pure; precomputeHexModes does the per-pixel
// LAND vs ROAD bucketing using ROAD_PIXEL_MASK directly. Component ids
// still restart at 1 inside each subhex.
function precomputeSubhexComponents() {
  if (!SUBHEX_ID_PX || !SUBHEX_ID_IMG_DATA || !SUBHEXES_BY_HEX) return;
  const W = SUBHEX_ID_IMG_DATA.width, H = SUBHEX_ID_IMG_DATA.height;
  const N = W * H;
  SUBHEX_PIXEL_COMPONENT = new Uint16Array(N);
  SUBHEX_COMPONENT_COUNT = new Map();
  SUBHEX_COMPONENT_PIXEL_COUNT = new Map();
  SUBHEX_COMPONENT_PIXELS = new Map();
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
          // Track whether THIS component (subhex + compId) contains any
          // road pixel and/or any thick-river pixel. The flood no longer
          // splits at the road/non-road boundary, so road and land within
          // the same subhex end up in ONE component — ROAD_COMPONENTS now
          // means "this component is road-bearing" rather than "road-pure".
          // In ferry hexes the flood admits thick pixels, so a component
          // can also include them; THICK_RIVER_COMPONENTS tags those.
          let compHasRoad  = !!(road && road[i]);
          let compHasThick = !!(thickPx && thickPx[i]);
          let compPixCount = 1;
          SUBHEX_PIXEL_COMPONENT[i] = compId;
          let head = 0, tail = 0;
          queue[tail++] = i;
          while (head < tail) {
            const idx = queue[head++];
            const cy = (idx / W) | 0;
            const cx = idx - cy * W;
            // 4-connected neighbors restricted to: same subhex and non-thick
            // (when blockThick). Road vs non-road is no longer a wall —
            // the flood spans both freely so a road through a subhex
            // doesn't split its land.
            if (cx + 1 < W) {
              const ni = idx + 1;
              if (subhexPx[ni] === subId && !(blockThick && thick && thick[ni]) && SUBHEX_PIXEL_COMPONENT[ni] === 0) {
                SUBHEX_PIXEL_COMPONENT[ni] = compId;
                if (road && road[ni]) compHasRoad = true;
                if (thickPx && thickPx[ni]) compHasThick = true;
                compPixCount++;
                queue[tail++] = ni;
              }
            }
            if (cx > 0) {
              const ni = idx - 1;
              if (subhexPx[ni] === subId && !(blockThick && thick && thick[ni]) && SUBHEX_PIXEL_COMPONENT[ni] === 0) {
                SUBHEX_PIXEL_COMPONENT[ni] = compId;
                if (road && road[ni]) compHasRoad = true;
                if (thickPx && thickPx[ni]) compHasThick = true;
                compPixCount++;
                queue[tail++] = ni;
              }
            }
            if (cy + 1 < H) {
              const ni = idx + W;
              if (subhexPx[ni] === subId && !(blockThick && thick && thick[ni]) && SUBHEX_PIXEL_COMPONENT[ni] === 0) {
                SUBHEX_PIXEL_COMPONENT[ni] = compId;
                if (road && road[ni]) compHasRoad = true;
                if (thickPx && thickPx[ni]) compHasThick = true;
                compPixCount++;
                queue[tail++] = ni;
              }
            }
            if (cy > 0) {
              const ni = idx - W;
              if (subhexPx[ni] === subId && !(blockThick && thick && thick[ni]) && SUBHEX_PIXEL_COMPONENT[ni] === 0) {
                SUBHEX_PIXEL_COMPONENT[ni] = compId;
                if (road && road[ni]) compHasRoad = true;
                if (thickPx && thickPx[ni]) compHasThick = true;
                compPixCount++;
                queue[tail++] = ni;
              }
            }
          }
          if (compHasRoad)  ROAD_COMPONENTS.add(`${subId}:${compId}`);
          if (compHasThick) THICK_RIVER_COMPONENTS.add(`${subId}:${compId}`);
          SUBHEX_COMPONENT_PIXEL_COUNT.set(`${subId}:${compId}`, compPixCount);
          // Snapshot this component's pixels before the queue gets
          // overwritten by the next flood. tail === compPixCount at this
          // point, so queue[0..compPixCount-1] is the full pixel list.
          const compPx = new Uint32Array(compPixCount);
          for (let qi = 0; qi < compPixCount; qi++) compPx[qi] = queue[qi];
          SUBHEX_COMPONENT_PIXELS.set(`${subId}:${compId}`, compPx);
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
// ---------------------------------------------------------------------
// Hex-mode graph precompute. Builds HEX_MODES (per-hex mode catalog with
// pixel set + cost per mode) and HEX_MODE_NEIGHBORS (the edge graph).
// Recompute whenever weights change — costs and the LAND assigned-weight
// rule depend on weights.
// ---------------------------------------------------------------------
function precomputeHexModes() {
  HEX_MODES = new Map();
  PIX_MODE_KIND = null;
  PIX_MODE_COMP = null;
  if (!SUBHEX_ID_PX || !HEX_ID_PX || !HEX_DATA || !SUBHEXES_BY_HEX) return;
  if (!SUBHEX_ID_IMG_DATA) return;
  const W = SUBHEX_ID_IMG_DATA.width, H = SUBHEX_ID_IMG_DATA.height;
  const N = W * H;
  // Per-pixel mode lookup arrays (populated as we build each kind's
  // components below). 0 = no mode (water barrier, off-map, dropped
  // pixels). Component index is per-(hex, kind) so it matches the suffix
  // we use in the mode name.
  PIX_MODE_KIND = new Uint8Array(N);
  PIX_MODE_COMP = new Uint16Array(N);

  // 8-connected flood-fill with RIVER-AWARE corner-cut. Two diagonal
  // bucket pixels are connected only when neither orthogonal corner is
  // a river pixel-that's-not-in-the-bucket. Effect:
  //   * LAND's flood-fill on a hex bisected by a green river produces
  //     two components (one per bank) because the river pixels live in
  //     FORD, not LAND, and their presence in the diagonal corner now
  //     blocks the cross-river link.
  //   * LAND+FORD union's flood-fill still spans the river because the
  //     river pixels ARE in the combo bucket, so the corner check
  //     short-circuits (corner is in bucket → not a separator).
  //   * Thick rivers (in FERRY or not at all) act the same way: they
  //     separate buckets that don't include them.
  // Non-river "void" corners (no mask at all) still allow the diagonal
  // — that's the difference from a full standard corner-cut, which
  // would over-split modes through perfectly-mundane narrow stretches.
  const thinMask  = THIN_RIVER_EXPANDED_MASK;
  const thickMask = THICK_RIVER_PIXEL_MASK;
  // strictCornerCut === true matches line A*'s no-corner-cut rule exactly:
  // a diagonal hop is blocked if EITHER orthogonal corner is outside the
  // bucket. Used for COMBO components, where the renderer's path-full mask
  // is restricted to exactly the combo's pixels — so flood-fill MUST agree
  // with what A* can actually trace, otherwise dijkstra picks a combo
  // whose two blobs touch only at a corner and the rendered line can't
  // cross the pinch.
  //
  // strictCornerCut === false (default) is the river-aware corner-cut:
  // a diagonal is blocked only when an orthogonal corner is a river
  // pixel not in the bucket. This is the right rule for SINGLE-kind
  // components because the renderer's broader mask usually still
  // contains the non-river corner pixels, so allowing the diagonal
  // doesn't desync flood-fill from A*'s reachable set.
  function floodComponents(bucket, strictCornerCut, blockOnCorner) {
    const visited = new Set();
    const comps = [];
    for (const seed of bucket) {
      if (visited.has(seed)) continue;
      visited.add(seed);
      const stack = [seed];
      const comp = [];
      while (stack.length > 0) {
        const p = stack.pop();
        comp.push(p);
        const py = (p / W) | 0;
        const px = p - py * W;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = py + dy;
          if (ny < 0 || ny >= H) continue;
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = px + dx;
            if (nx < 0 || nx >= W) continue;
            const ni = ny * W + nx;
            if (visited.has(ni)) continue;
            if (!bucket.has(ni)) continue;
            if (dx !== 0 && dy !== 0) {
              const c1 = py * W + nx;     // row of p, col of n
              const c2 = ny * W + px;     // row of n, col of p
              if (strictCornerCut) {
                // No-corner-cut: both orthogonal corners must be in the
                // bucket. Mirrors aStarInMask in pathfinding.js.
                if (!bucket.has(c1) || !bucket.has(c2)) continue;
              } else {
                // River-aware corner-cut: rivers act as flood-fill
                // separators for any mode that doesn't include them.
                // blockOnCorner is an additional separator set passed
                // in by emitComponents (used for naval pixels when
                // flooding land-side buckets, so a LAND component
                // can't 8-connect through a lake pixel pinch).
                const c1Sep = (thinMask && thinMask[c1]) || (thickMask && thickMask[c1])
                           || (blockOnCorner && blockOnCorner.has(c1));
                const c2Sep = (thinMask && thinMask[c2]) || (thickMask && thickMask[c2])
                           || (blockOnCorner && blockOnCorner.has(c2));
                if (c1Sep && !bucket.has(c1)) continue;
                if (c2Sep && !bucket.has(c2)) continue;
              }
            }
            visited.add(ni);
            stack.push(ni);
          }
        }
      }
      comps.push(new Uint32Array(comp));
    }
    return comps;
  }
  // Drop micro-components — handfuls of pixels that are almost certainly
  // artwork artifacts (a stray road pixel that got bucketed alone, etc.).
  // They clutter the picker and can give dijkstra phantom routing
  // options. Tuned conservatively: anything ≤ MIN_MODE_COMPONENT_PIXELS
  // gets dropped.
  const MIN_MODE_COMPONENT_PIXELS = 4;
  function pruneTinyComponents(comps) {
    return comps.filter(c => c.length > MIN_MODE_COMPONENT_PIXELS);
  }

  for (const [hid, subs] of SUBHEXES_BY_HEX) {
    const hexT = canonicalHexTerrain(HEX_TERRAIN ? HEX_TERRAIN.get(hid) : null);
    // Long-column penalty: when ARMY_LENGTH_MI > 6, double LAND/ROAD
    // weights so the army's drag through each hex is paid for twice.
    // Water terrains aren't affected — column length doesn't slow a
    // fleet the way it slows a marching column.
    const hexIsLand = hexT && !WATER_TERRAINS.has(hexT);
    const landMul   = hexIsLand ? armyLandMul() : 1;
    const hexW  = hexT ? (+weights[hexT]    * landMul) : NaN;
    const roadW = hexT ? (+roadWeights[hexT] * landMul) : NaN;

    // Ferry hexes: the road segment in this hex is intentionally short
    // (just the run-up to a river crossing), so applying the usual
    // pixel-count threshold to gate ROAD-mode formation would erase the
    // route's reason for being here, leaving dijkstra to pick LAND over
    // ROAD_FERRY. Force the threshold off for ferry hexes so ROAD mode
    // always forms when there are any road pixels at all.
    const hexIsFerry = FERRY_HEXES ? FERRY_HEXES.has(hid) : false;

    // Per-kind pixel buckets. Sets so flood-fill can ask O(1) "is this
    // neighbor in the bucket". FORD is the new green-river bucket —
    // separate from FERRY (which only ever holds painted road+thick
    // overlays) and from LAND/ROAD (thin-river pixels are no longer
    // mixed into either).
    const landSet  = new Set();
    const roadSet  = new Set();
    const navalSet = new Set();
    const ferrySet = new Set();
    const fordSet  = new Set();

    for (const sub of subs) {
      const compCount = SUBHEX_COMPONENT_COUNT.get(sub.id) || 0;
      const subIsNaval = WATER_TERRAINS.has(sub.class);
      // Subhex class is no longer used to gate LAND-mode membership: a
      // Mountain subhex inside a Hills hex (or any heavier-than-assigned
      // subhex) contributes its pixels to landSet just like any other
      // land subhex. The hex's assigned terrain still drives the LAND-
      // mode cost (hexW), so the heavier subhex is traversed at the
      // hex's cost — not its own class cost.

      for (let comp = 1; comp <= compCount; comp++) {
        const compKey = `${sub.id}:${comp}`;
        const pixels = SUBHEX_COMPONENT_PIXELS ? SUBHEX_COMPONENT_PIXELS.get(compKey) : null;
        if (!pixels || pixels.length === 0) continue;
        // Road and thick-river flags are tested PER PIXEL now: the
        // flood-fill no longer splits at the road/non-road boundary, so
        // one component can mix land, road, and (in ferry hexes) ferry
        // pixels. We walk the component once to collect road-pixel count
        // and road-pixel index list — those drive the ROAD / ROAD_FERRY
        // buckets — then walk again to do the per-pixel bucket assignment.
        const roadMask  = ROAD_PIXEL_MASK;
        // Ferry-mark detection uses the road-only mask: a thick-river
        // pixel must be overlaid with a genuine road (not a city) to
        // count as a crossing.
        const roadOnlyMask = ROAD_ONLY_PIXEL_MASK || ROAD_PIXEL_MASK;
        const thickMask = THICK_RIVER_PIXEL_MASK;
        let roadPixCount = 0;
        if (roadMask) {
          for (let pi = 0; pi < pixels.length; pi++) {
            if (roadMask[pixels[pi]]) roadPixCount++;
          }
        }
        // Road bucket always accepts road pixels. pruneTinyComponents
        // (≤ MIN_MODE_COMPONENT_PIXELS) still drops microscopic ROAD
        // flood-fill components downstream, so true stray-1-pixel road
        // blips don't pollute the graph. Removing the per-component
        // MIN_PIXELS_PER_PATH_HEX gate makes ROAD modes available for
        // every hex with a real road segment painted — which is what
        // lets dijkstra "snap to road" in start/end hexes via the
        // multi-start/multi-end seeding below.
        const roadAccepted = true;
        const thinMask = THIN_RIVER_EXPANDED_MASK;
        for (let pi = 0; pi < pixels.length; pi++) {
          const p = pixels[pi];
          const isRoadPix  = !!(roadMask  && roadMask[p]);
          const isThickPix = !!(thickMask && thickMask[p]);
          const isThinPix  = !isThickPix && !!(thinMask && thinMask[p]);
          if (subIsNaval) {
            // Naval-class subhex — all pixels go to NAVAL, unchanged.
            navalSet.add(p);
            continue;
          }
          if (isThickPix) {
            // Thick (red) river pixel. Ferry the old way: ONLY pixels
            // painted with a road overlay (the "ferry mark") are
            // crossable, going into ferrySet. Unmarked thick-river
            // pixels are blocked — left out of every bucket so they
            // contribute no graph node.
            // The ferry overlay must be a real road (roads.png), not a
            // city/town/fort pixel — those don't draw crossings.
            const isRoadOnlyPix = !!(roadOnlyMask && roadOnlyMask[p]);
            if (isRoadOnlyPix) ferrySet.add(p);
            continue;
          }
          if (isThinPix) {
            // ── Bridge detection ─────────────────────────────────────
            // A road that physically crosses a thin river is a bridge:
            // a real road pixel (not a city) overlaying the river's
            // strict (1-px) core lets the column cross at road cost,
            // no fording surcharge.
            //
            // STRICT_RIVER_PIXEL_MASK is the alpha>230 mask — only the
            // painted river core, no AA halo. Using it here (instead
            // of the expanded thin mask) keeps a road running parallel
            // to a river along the bank from accidentally registering
            // as a continuous bridge via AA-pixel overlap.
            //
            // Road-only (no ctf) for the same reason ferries are: a
            // city sitting on a river isn't a bridge, only a road
            // overlay drawn by the artist counts.
            const isRoadOnlyPix = !!(roadOnlyMask && roadOnlyMask[p]);
            const isStrictRiverCore = !!(STRICT_RIVER_PIXEL_MASK && STRICT_RIVER_PIXEL_MASK[p]);
            if (isRoadOnlyPix && isStrictRiverCore) {
              landSet.add(p);
              if (roadAccepted) roadSet.add(p);
              continue;
            }
            // Otherwise it's a normal thin-river pixel — goes into the
            // FORD bucket so crossings need the Fording surcharge.
            fordSet.add(p);
            continue;
          }
          if (isRoadPix) {
            // Road pixel on non-thick / non-thin terrain. Always counts
            // as land (so the renderer can step through it at land
            // cost) and also as road if the component's road population
            // meets the threshold.
            landSet.add(p);
            if (roadAccepted) roadSet.add(p);
            continue;
          }
          // Pure land pixel. Added unconditionally — the old subhex-
          // class weight gate is gone.
          landSet.add(p);
        }
      }
    }

    // ── Expand ferrySet to the FULL red river of the hex ─────────────
    // If the hex has any painted ferry-mark pixel (road ∩ thick), the
    // whole thick-river area of the hex becomes ferry-crossable — the
    // mask covers the full river so line A* has room to draw the
    // crossing. The line A* is independently forced to pass THROUGH a
    // ferry-mark pixel via the routeLineFromModes waypoint injection
    // (see "ferry-mark waypoints" below), so the line still touches
    // the painted mark while running across the wider river.
    //
    // Hexes WITHOUT any ferry mark keep ferrySet empty, so no
    // ROAD_FERRY mode emits and the thick river remains impassable.
    if (ferrySet.size > 0 && THICK_RIVER_PIXEL_MASK && HEX_PIXELS) {
      const hexAllPx = HEX_PIXELS.get(hid);
      if (hexAllPx) {
        const thick = THICK_RIVER_PIXEL_MASK;
        for (let i = 0; i < hexAllPx.length; i++) {
          const p = hexAllPx[i];
          if (thick[p]) ferrySet.add(p);
        }
      }
    }
    // fordSet: every thin-river pixel of the hex (any hex).

    const hexModes = new Map();

    // For each kind, flood-fill the per-hex pixel bucket into 8-connected
    // components, then add one mode entry per component named like
    // `${kind}#${idx}`. This is what fixes thick-river-split land: the
    // two halves end up as LAND#0 and LAND#1 with no in-hex edge between
    // them, so dijkstra has to go around (or via a ROAD_FERRY mode).
    const emitComponents = (kindName, bucket, cost, isFerry) => {
      if (bucket.size === 0 || !isFinite(cost)) return;
      const kindNum = MODE_KIND_NUMS[kindName];
      // Land-side modes treat naval pixels as flood-fill separators
      // (the same way rivers already are), so a LAND/ROAD/FORD/
      // ROAD_FERRY component can't 8-connect through a lake-pixel
      // pinch — otherwise dijkstra picks a single "land" mode whose
      // pixel set has a naval gap line A* can't actually walk.
      const blockOnCorner = (kindName !== "NAVAL") ? navalSet : null;
      const comps = pruneTinyComponents(floodComponents(bucket, false, blockOnCorner));
      for (let ci = 0; ci < comps.length; ci++) {
        const pixels = comps[ci];
        const name = `${kindName}#${ci}`;
        hexModes.set(name, {
          mode: name,
          kind: kindName,
          pixels,
          cost,
          isFerry,
        });
        // Stamp per-pixel lookup so precomputeHexModeNeighbors and
        // hexModeAtPixel can resolve "what mode owns this pixel" in O(1).
        for (let i = 0; i < pixels.length; i++) {
          PIX_MODE_KIND[pixels[i]] = kindNum;
          PIX_MODE_COMP[pixels[i]] = ci;
        }
      }
    };

    emitComponents("LAND", landSet, hexW, false);
    emitComponents("ROAD", roadSet, roadW, false);
    const isHexNaval = hexT && WATER_TERRAINS.has(hexT);
    const navalW = isHexNaval ? hexW : +weights["Sea"];
    // Naval modes are gated on ARMY_CAN_EMBARK — when off, the army
    // cannot board a ship, so naval pixels become dead-ends and no
    // route through them is possible.
    if (navalSet.size > 0 && ARMY_CAN_EMBARK) {
      // Naval cost: if the hex's sheet terrain is itself naval, use that
      // weight (sailing). Otherwise this is a stranded naval subhex
      // inside a land hex; bill it at "Sea" weight.
      emitComponents("NAVAL", navalSet, navalW, false);
    }
    const ferrySurcharge = +weights["Ferry"]   || 0;
    // Fording cost flips to length-driven when an army is configured;
    // otherwise the static Fording weight is used.
    const fordSurcharge  = armyFordCost();
    if (ferrySet.size > 0 && isFinite(ferrySurcharge) && ferrySurcharge >= 0) {
      // ROAD_FERRY = the painted ferry-mark pixels of this hex (road
      // overlaid on thick river). Single-mode cost = the ferry
      // surcharge alone (0 is allowed — a marked ferry can be free,
      // the road/land bank still pays its own cost via combo).
      emitComponents("ROAD_FERRY", ferrySet, ferrySurcharge, true);
    }
    // FORD is similarly gated on ARMY_CAN_FORD; off means no thin-river
    // crossings exist in the graph at all.
    if (fordSet.size > 0 && isFinite(fordSurcharge) && fordSurcharge >= 0 && ARMY_CAN_FORD) {
      // FORD = thin (green) river pixels of this hex. Separate kind
      // from ROAD_FERRY, separate weight ("Fording").
      emitComponents("FORD", fordSet, fordSurcharge, false);
    }

    // ── COMBO MODES ── pixel-union of multiple single-kind buckets, with
    // costs SUMMED from per-kind base contributions. Lets dijkstra pick a
    // single "what this hex is being used as" node whose pixels exactly
    // cover the chosen traversal (e.g., ROAD+ROAD_FERRY = the road on
    // both banks plus the ferry crossing, with cost road+ferry, NO land
    // pixels included). Solves the "dijkstra picks LAND for a ferry hex,
    // and the line mask drags in all the Plains pixels" problem.
    //
    // Base contributions per kind (always one occurrence per combo):
    //   LAND       → hex weight
    //   ROAD       → road weight
    //   ROAD_FERRY → ferry surcharge alone (the road portion is the
    //                ROAD kind's responsibility if it's also in the combo)
    //   NAVAL      → naval weight (hex's terrain if water, else "Sea")
    //
    // We only generate combos whose pixel union is strictly larger than
    // any constituent kind's set — same pixels at a higher cost would
    // just be dominated, so they're not worth emitting. In practice this
    // skips LAND+ROAD (road ⊂ land already) and any combo whose
    // constituent kinds have empty buckets.
    const baseCosts = {
      LAND: hexW,
      ROAD: roadW,
      ROAD_FERRY: ferrySurcharge,
      NAVAL: navalW,
      FORD: fordSurcharge,
    };
    const kindSets = {
      LAND: landSet,
      ROAD: roadSet,
      ROAD_FERRY: ferrySet,
      NAVAL: navalSet,
      FORD: fordSet,
    };
    const kindList = ["LAND", "ROAD", "ROAD_FERRY", "NAVAL", "FORD"];
    // baseCosts[k] >= 0 (not > 0) so kinds with a 0-cost contribution
    // — e.g., Ferry surcharge defaulting to 0 — still participate in
    // combos. Without this ROAD_FERRY would silently vanish from every
    // combo when Ferry weight is 0.
    // Army-permission gates: when the army can't ford / embark, drop
    // FORD / NAVAL from the constituent set so no combo (LAND+FORD,
    // ROAD+FORD, NAVAL+anything…) carries the forbidden traversal.
    // Without this, dijkstra would still pick a LAND+FORD combo and
    // cross the river even though the standalone FORD mode was gated.
    const presentKinds = kindList.filter(k => {
      if (kindSets[k].size === 0) return false;
      if (!isFinite(baseCosts[k]) || baseCosts[k] < 0) return false;
      if (k === "FORD"  && !ARMY_CAN_FORD)   return false;
      if (k === "NAVAL" && !ARMY_CAN_EMBARK) return false;
      return true;
    });
    const nKinds = presentKinds.length;
    if (nKinds >= 2) {
      for (let mask = 1; mask < (1 << nKinds); mask++) {
        // Need at least 2 kinds for a combo.
        let bits = 0;
        for (let i = 0; i < nKinds; i++) if (mask & (1 << i)) bits++;
        if (bits < 2) continue;
        const kinds = [];
        let cost = 0;
        const union = new Set();
        let maxConstituentSize = 0;
        for (let i = 0; i < nKinds; i++) {
          if (!(mask & (1 << i))) continue;
          const k = presentKinds[i];
          kinds.push(k);
          cost += baseCosts[k];
          for (const p of kindSets[k]) union.add(p);
          if (kindSets[k].size > maxConstituentSize) {
            maxConstituentSize = kindSets[k].size;
          }
        }
        // ── COMBO-LEVEL FILTER ───────────────────────────────────────
        // Skip combos whose pixel union isn't strictly larger than the
        // largest constituent kind's set: same pixels at a higher cost
        // are always dominated.
        if (union.size <= maxConstituentSize) continue;
        // Also skip combos where one constituent kind's pixel set is
        // entirely contained in another's (e.g., ROAD ⊂ LAND because
        // landSet absorbs road pixels). The combo's union is just the
        // larger kind's set; the combo is dominated by that single
        // kind's mode.
        let absorbed = false;
        for (const k1 of kinds) {
          if (absorbed) break;
          const s1 = kindSets[k1];
          for (const k2 of kinds) {
            if (k1 === k2) continue;
            const s2 = kindSets[k2];
            // Quick reject — if s1 has more pixels than s2, can't be ⊂ s2.
            if (s1.size > s2.size) continue;
            let allIn = true;
            for (const p of s1) {
              if (!s2.has(p)) { allIn = false; break; }
            }
            if (allIn) { absorbed = true; break; }
          }
        }
        if (absorbed) continue;
        // ── FORD↔NAVAL GUARD ─────────────────────────────────────────
        // A thin (green) river that meets open water is NOT a legal
        // traversal: FORD models "wade across a narrow stream" and
        // NAVAL models "travel by ship". Even at a stronghold, there's
        // no ferry/disembark semantics for the FORD side — you cross a
        // ford by walking, which doesn't connect to a naval node. Drop
        // any combo that contains BOTH so dijkstra can't use a river
        // mouth as a free river→sea (or sea→river) transition.
        if (kinds.indexOf("FORD") >= 0 && kinds.indexOf("NAVAL") >= 0) continue;
        // LAND+NAVAL (and any other NAVAL + non-NAVAL) combo is now
        // emitted at every coastal hex so dijkstra has a real
        // transition-zone node to pick for embark / disembark routes.
        // The disembark stronghold rule still applies at the OUTBOUND
        // cross-hex boundary (combo at hex A → LAND at hex B is blocked
        // unless B is a stronghold), and the LINE A* is constrained to
        // draw two hexes at a time (see the pair-mask loop in
        // routeLineFromModes), so the line can't sneak corner-cuts
        // across non-stronghold combos.
        if (union.size === 0 || !isFinite(cost) || cost < 0) continue;
        const comboKindName = kinds.join("+");
        // Strict corner-cut for combos: see floodComponents comment. A combo
        // whose two pixel blobs touch only at a diagonal corner would
        // produce one component under the river-aware rule but can't be
        // rendered as a line — line A* refuses to corner-cut. Match it here.
        const comps = pruneTinyComponents(floodComponents(union, true));
        for (let ci = 0; ci < comps.length; ci++) {
          const pixels = comps[ci];
          // ── COMPONENT-LEVEL FILTER ──────────────────────────────────
          // After flood-fill, a combo can produce components that contain
          // pixels from only ONE constituent kind (because that kind's
          // pixels are spatially disjoint from the others' in this hex).
          // Such a component is identical to the single-kind component
          // it overlaps, but at a higher sum-cost — dominated. Drop it.
          let pureSingleKind = false;
          for (const k of kinds) {
            const kSet = kindSets[k];
            let allIn = true;
            for (let pi = 0; pi < pixels.length; pi++) {
              if (!kSet.has(pixels[pi])) { allIn = false; break; }
            }
            if (allIn) { pureSingleKind = true; break; }
          }
          if (pureSingleKind) continue;
          const name = `${comboKindName}#${ci}`;
          hexModes.set(name, {
            mode: name,
            kind: comboKindName,
            kinds,                            // array, for downstream filtering
            isCombo: true,
            pixels,
            cost,
            isFerry: kinds.indexOf("ROAD_FERRY") >= 0,
          });
          // Combos deliberately do NOT stamp PIX_MODE_KIND/PIX_MODE_COMP
          // (those arrays carry a single value per pixel; combos overlap
          // single modes on the same pixels). Combo edges are derived in
          // addComboModeNeighbors from the constituent single modes'
          // neighbors instead.
        }
      }
    }

    if (hexModes.size > 0) HEX_MODES.set(hid, hexModes);
  }
}

// Combo modes don't appear in the PIX_MODE_KIND / PIX_MODE_COMP arrays
// (a pixel can belong to multiple combos at once, but the arrays only
// hold one entry per pixel). So precomputeHexModeNeighbors — which
// derives edges from those arrays — never sees combos. We patch them in
// after the fact: a combo's neighbors are the UNION of all its
// constituent single-kind modes' cross-hex neighbors, plus free intra-hex
// edges to every other mode/combo in the same hex. The reverse direction
// (single mode → combo across a hex boundary) is added symmetrically so
// dijkstra can transition INTO a combo from a neighbor's perspective.
function addComboModeNeighbors() {
  if (!HEX_MODES || !HEX_MODE_NEIGHBORS) return;
  for (const [hid, modes] of HEX_MODES) {
    // Index single modes of this hex by their kind, so a combo can find
    // its constituents' graph keys in O(1).
    const singleKeysByKind = new Map();
    for (const [name, info] of modes) {
      if (info.isCombo) continue;
      const fullKey = `${hid}:${name}`;
      let list = singleKeysByKind.get(info.kind);
      if (!list) { list = []; singleKeysByKind.set(info.kind, list); }
      list.push(fullKey);
    }

    for (const [name, info] of modes) {
      if (!info.isCombo) continue;
      const comboKey = `${hid}:${name}`;
      let nbs = HEX_MODE_NEIGHBORS.get(comboKey);
      if (!nbs) { nbs = new Set(); HEX_MODE_NEIGHBORS.set(comboKey, nbs); }

      // Inherit cross-hex edges only from constituent components whose
      // pixels ACTUALLY overlap with this combo component's pixels. The
      // earlier version unioned every constituent component's edges,
      // which over-connected the combo: a combo component that contained
      // (say) ROAD#1 + ROAD_FERRY#0 would inherit edges from ROAD#0 as
      // well, even though ROAD#0's pixels aren't in this combo — letting
      // dijkstra pick paths the renderer couldn't follow. Now we check
      // overlap per constituent.
      const comboPixSet = new Set();
      for (let i = 0; i < info.pixels.length; i++) comboPixSet.add(info.pixels[i]);
      for (const k of info.kinds) {
        const keys = singleKeysByKind.get(k) || [];
        for (const constituentKey of keys) {
          // Resolve the constituent's mode info to inspect its pixels.
          const colonAt = constituentKey.indexOf(":");
          const constName = constituentKey.slice(colonAt + 1);
          const constMode = modes.get(constName);
          if (!constMode) continue;
          // Quick early-out: scan the constituent's pixels for any
          // membership in comboPixSet. One hit is enough.
          let overlaps = false;
          const cpx = constMode.pixels;
          for (let i = 0; i < cpx.length; i++) {
            if (comboPixSet.has(cpx[i])) { overlaps = true; break; }
          }
          if (!overlaps) continue;
          const constNbs = HEX_MODE_NEIGHBORS.get(constituentKey);
          if (!constNbs) continue;
          for (const nb of constNbs) {
            // Skip intra-hex edges from the constituent's set — we'll
            // add fresh intra-hex edges below covering combos too.
            if (nb.startsWith(`${hid}:`)) continue;
            nbs.add(nb);
          }
        }
      }

      // Free intra-hex edges to every other mode (single or combo) of
      // this hex. Dijkstra's intra-hex transition is free (the running
      // max takes care of the cost), so this gives combos the same
      // intra-hex mobility single modes already have.
      for (const [otherName] of modes) {
        if (otherName === name) continue;
        nbs.add(`${hid}:${otherName}`);
      }

      // Reverse direction: every cross-hex neighbor needs to know it
      // can transition INTO this combo.
      for (const nb of nbs) {
        if (nb.startsWith(`${hid}:`)) continue;
        let nbNbs = HEX_MODE_NEIGHBORS.get(nb);
        if (!nbNbs) { nbNbs = new Set(); HEX_MODE_NEIGHBORS.set(nb, nbNbs); }
        nbNbs.add(comboKey);
      }
    }
  }
}

// Walk the per-pixel mode lookup and link every (hex, mode) node to
// every other (hex, mode) it's 8-connected to (across hex borders or
// across mode boundaries inside the same hex). Both kinds of edges
// share the same map. Diagonals require at least one of the two
// orthogonal corners to also be passable (no corner-cut), matching
// the renderer's A*.
function precomputeHexModeNeighbors() {
  HEX_MODE_NEIGHBORS = new Map();
  if (!HEX_MODES || !HEX_ID_PX || !SUBHEX_ID_IMG_DATA) return;
  if (!PIX_MODE_KIND || !PIX_MODE_COMP) return;
  const W = SUBHEX_ID_IMG_DATA.width, H = SUBHEX_ID_IMG_DATA.height;
  const pixKind = PIX_MODE_KIND;
  const pixComp = PIX_MODE_COMP;
  const pixHex  = HEX_ID_PX;  // already populated globally
  const numToKind = MODE_KIND_NAMES;

  const link = (aKey, bKey) => {
    let set = HEX_MODE_NEIGHBORS.get(aKey);
    if (!set) { set = new Set(); HEX_MODE_NEIGHBORS.set(aKey, set); }
    set.add(bKey);
  };

  // Walk every passable pixel; for each 8-neighbor that's also passable
  // and not the same (hex, kind, comp), link the two mode nodes.
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      const i = row + x;
      const kA = pixKind[i];
      if (!kA) continue;
      const cA = pixComp[i];
      const hA = pixHex[i];
      // Orthogonal
      if (x + 1 < W) checkAndLink(i, i + 1, kA, cA, hA, pixKind, pixComp, pixHex, numToKind, link, x, y, +1, 0, W, H);
      if (y + 1 < H) checkAndLink(i, i + W, kA, cA, hA, pixKind, pixComp, pixHex, numToKind, link, x, y, 0, +1, W, H);
      // Diagonal (no corner-cut)
      if (x + 1 < W && y + 1 < H) checkAndLink(i, i + W + 1, kA, cA, hA, pixKind, pixComp, pixHex, numToKind, link, x, y, +1, +1, W, H);
      if (x > 0     && y + 1 < H) checkAndLink(i, i + W - 1, kA, cA, hA, pixKind, pixComp, pixHex, numToKind, link, x, y, -1, +1, W, H);
    }
  }
}
// Helper hoisted so precomputeHexModeNeighbors stays readable.
function checkAndLink(i, j, kA, cA, hA, pixKind, pixComp, pixHex, numToKind, link, x, y, dx, dy, W, H) {
  const kB = pixKind[j];
  if (!kB) return;
  const hB = pixHex[j];
  const cB = pixComp[j];
  // Same (hex, kind, component) — no edge needed (self-loop).
  if (hA === hB && kA === kB && cA === cB) return;
  // River kinds (FORD = green, ROAD_FERRY = red) are HEX-INTERNAL only.
  // You can't enter a river from a different hex — you must arrive on
  // the bank of THIS hex via LAND or ROAD and then traverse the river
  // within the hex via a LAND+FORD / ROAD+FORD / LAND+ROAD_FERRY /
  // ROAD+ROAD_FERRY combo. FORD cross-hex is fully blocked (rivers don't
  // span a hex boundary as a single fording event). ROAD_FERRY allows
  // ONE exception across hex borders: ROAD_FERRY↔ROAD_FERRY — a ferry
  // mark painted across a hex boundary lives in both hexes' ferry-mark
  // buckets and needs the cross-hex link so the line can traverse it
  // as one continuous crossing. Any mixed pairing with FORD or
  // ROAD_FERRY on one side stays blocked.
  const FORD       = MODE_KIND_NUMS.FORD;
  const ROAD_FERRY = MODE_KIND_NUMS.ROAD_FERRY;
  if (hA !== hB) {
    if (kA === FORD || kB === FORD) return;
    const aIsFerry = (kA === ROAD_FERRY);
    const bIsFerry = (kB === ROAD_FERRY);
    if (aIsFerry !== bIsFerry) return;   // mixed: blocked (e.g., ROAD_FERRY↔LAND)
    // aIsFerry && bIsFerry → both ROAD_FERRY: allow through.
    // !aIsFerry && !bIsFerry → no ferry involved: fall through.
    // Cross-hex DIAGONAL pixel adjacencies don't create a mode edge.
    // Two hexes in a hex grid share an edge, never just a corner; if
    // the only pixel adjacency between two modes is a diagonal pinch
    // there's no orthogonal contact along the shared edge either, so
    // these aren't really neighbors. Line A*'s corner-cut couldn't
    // trace through such a pinch in any case.
    if (dx !== 0 && dy !== 0) return;
  }
  // Corner-cut check on diagonals. MUST match line A*'s rule
  // (aStarInMask in pathfinding.js) so we never create an edge the
  // renderer can't actually trace: line A* blocks the diagonal if
  // EITHER orthogonal corner is impassable.
  if (dx !== 0 && dy !== 0) {
    const ox = y * W + (x + dx);
    const oy = (y + dy) * W + x;
    if (!pixKind[ox] || !pixKind[oy]) return;
    // CATEGORY-MATCH for CROSS-HEX diagonals. Line A* operates on the
    // ROUTE'S mode-pixel mask: a LAND→LAND route includes only LAND-
    // category pixels, so a NAVAL corner pixel isn't in the mask and
    // line A* refuses the diagonal. Mirror that here so dijkstra
    // never picks a "step across a 1-px sea pinch" edge that the line
    // can't render. Intra-hex diagonals are left alone because the
    // route mask includes everything in the chosen mode regardless of
    // kind boundaries.
    if (hA !== hB) {
      // Cross-hex diagonal — same side-based rule the renderer's
      // augmenter uses (routeLineFromModes). The corner kinds must
      // belong to the same "side" as at least one of the diagonal
      // endpoints:
      //   L  = LAND / ROAD            (true land traversal)
      //   R  = FORD / ROAD_FERRY      (river crossings; hex-internal)
      //   N  = NAVAL                  (water)
      // A river pixel can't bridge a LAND-LAND diagonal across a hex
      // border — the only legal way through a river is the intra-hex
      // LAND+FORD / ROAD+FORD combo, which pays the fording surcharge.
      // Same for a ferry-mark pixel.
      const NAVAL = MODE_KIND_NUMS.NAVAL;
      const FORD       = MODE_KIND_NUMS.FORD;
      const ROAD_FERRY = MODE_KIND_NUMS.ROAD_FERRY;
      const sideOf = (k) => {
        if (k === NAVAL) return "N";
        if (k === FORD || k === ROAD_FERRY) return "R";
        return "L";
      };
      const aSide = sideOf(kA);
      const bSide = sideOf(kB);
      const c1Side = sideOf(pixKind[ox]);
      const c2Side = sideOf(pixKind[oy]);
      const c1Ok = c1Side === aSide || c1Side === bSide;
      const c2Ok = c2Side === aSide || c2Side === bSide;
      if (!c1Ok && !c2Ok) return;
    }
  }
  const aKey = `${hA}:${numToKind[kA]}#${cA}`;
  const bKey = `${hB}:${numToKind[kB]}#${cB}`;
  link(aKey, bKey);
  link(bKey, aKey);
}

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
  // Roads-only variant for ferry detection — cities/towns/forts
  // sitting on a thick river should NOT promote that hex to a ferry.
  ROAD_ONLY_PIXEL_MASK = buildBinaryMaskFromLayers(["roads"]);
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
  // ── Diagonal-gap closing ─────────────────────────────────────────────
  // The artwork frequently draws a thin river as a 1-pixel staircase:
  // a sequence of pixels that step diagonally with no orthogonal river
  // connection. The flood-fill corner-cut rule in precomputeHexModes
  // blocks land paths from cutting THROUGH such a pair (because either
  // orthogonal corner of the diagonal step is itself a river pixel),
  // but if the river has a one-pixel BREAK in the middle of the
  // staircase, the gap pixel has no river data at all and the
  // corner-cut check sees nothing — land flood-fill happily steps
  // across the river.
  //
  // Close those gaps: any non-thin pixel that has thin-river 8-neighbors
  // in opposite positions (N+S, E+W, NW+SE, NE+SW) gets promoted to
  // thin-river. Two iterations so a 2-px gap also closes. Bounded by
  // not-thick / not-strict invariants. Doesn't touch the rendered
  // overlay since strict/thick masks aren't mutated.
  for (let iter = 0; iter < 2; iter++) {
    const src = new Uint8Array(out);
    for (let y = 1; y < H - 1; y++) {
      const row = y * W;
      for (let x = 1; x < W - 1; x++) {
        const i = row + x;
        if (out[i]) continue;
        if (thickMask && thickMask[i]) continue;
        const n  = src[i - W];
        const s  = src[i + W];
        const e  = src[i + 1];
        const wp = src[i - 1];
        const ne = src[i - W + 1];
        const nw = src[i - W - 1];
        const se = src[i + W + 1];
        const sw = src[i + W - 1];
        if ((n && s) || (e && wp) || (ne && sw) || (nw && se)) {
          out[i] = 1;
        }
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

// Parallel to precomputeRoadSubhexes — collect every subhex id that contains
// at least one river pixel (rivers.png). Used by the ferry road+river-subhex
// tier in restrict() to decide which subhexes' pixels count as "the route
// belongs here" inside a ferry hex when the route can't be resolved by road
// pixels alone. Pixel-driven, same as ROAD_SUBHEXES: no spreadsheet flag.
function precomputeRiverSubhexes() {
  RIVER_SUBHEXES = new Set();
  if (!HEX_RIVER_PIXELS || !SUBHEX_ID_PX) return;
  for (const arr of HEX_RIVER_PIXELS.values()) {
    for (let i = 0; i < arr.length; i++) {
      const sid = SUBHEX_ID_PX[arr[i]];
      if (sid) RIVER_SUBHEXES.add(sid);
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
  // Reachability dijkstra runs on the SAME hex-mode graph as route
  // pathfinding, so every army-aware cost rule is automatically
  // respected: long-column doubling (baked into LAND/ROAD mode costs),
  // Can ford / Can embark gates (the active HEX_MODES variant simply
  // omits FORD / NAVAL modes when those flags are off), bridge
  // crossings (road pixels overlaid on thin-river are classified as
  // LAND/ROAD, not FORD, in precomputeHexModes), and ferry crossings
  // (ROAD_FERRY modes carry the right ferry surcharge). The previous
  // hex-level simplification ignored every one of those, so an army
  // that "can't ford" still showed a reachable hex on the other side
  // of a thin river.
  isochroneHexIds = null; isochroneSubhexIds = null;
  if (isochroneSourceId == null) return;
  const sub = SUBHEX_INDEX.get(isochroneSourceId);
  if (!sub) return;
  if (!HEX_MODES || !HEX_MODE_NEIGHBORS) return;
  const srcHex = sub.hex;
  const srcModes = HEX_MODES.get(srcHex);
  if (!srcModes) return;

  // Per-(hex, mode) cost-to-reach. distHex is the projected per-hex
  // minimum across modes — used both for the heap-pop staleness check
  // and as the final reached-hex set.
  const distMode = new Map();
  const distHex  = new Map();
  const heap = new MinHeap();

  // Seed every mode of the source hex at cost 0 (free start, same as
  // route pathfinding).
  for (const [mName, mInfo] of srcModes) {
    if (!mInfo || !isFinite(mInfo.cost) || mInfo.cost < 0) continue;
    const key = `${srcHex}:${mName}`;
    distMode.set(key, 0);
    heap.push([0, key, srcHex, mName]);
  }
  distHex.set(srcHex, 0);

  while (heap.size() > 0) {
    const [d, uKey, uHex, uMode] = heap.pop();
    if (d > (distMode.get(uKey) ?? Infinity)) continue;
    const uInfo = HEX_MODES.get(uHex)?.get(uMode);
    if (!uInfo) continue;
    const uIsNaval = modeIsNaval(uInfo);

    const neighbors = HEX_MODE_NEIGHBORS.get(uKey);
    if (!neighbors) continue;

    for (const vKey of neighbors) {
      const colon = vKey.indexOf(":");
      const vHex  = +vKey.slice(0, colon);
      const vMode = vKey.slice(colon + 1);
      // Intra-hex transitions are free under the mode-graph cost model
      // (the cost of being IN a hex was already paid on entry). Skip
      // them — we only care about reaching NEW hexes here.
      if (vHex === uHex) continue;
      const vInfo = HEX_MODES.get(vHex)?.get(vMode);
      if (!vInfo || !isFinite(vInfo.cost) || vInfo.cost < 0) continue;

      // Entering v pays v's mode cost. Land/road/ford/ferry/naval costs
      // are all already baked into vInfo.cost for the active variant
      // (HEX_MODES is whichever HEX_MODES_VARIANTS entry matches the
      // current ARMY_CAN_FORD / ARMY_CAN_EMBARK flags).
      let nd = d + vInfo.cost;

      // Naval-boundary surcharges. Embark fires on land→naval crossings
      // (boarding a ship), Disembark on naval→land (and only at hexes
      // with a Stronghold). ARMY_CAN_EMBARK is enforced both here AND
      // upstream (NAVAL modes don't even exist in the active variant
      // when the flag is off), but the runtime check stays as a
      // belt-and-braces guard for the no-NAVAL-modes-but-still-traversal
      // edge case.
      const vIsNaval = modeIsNaval(vInfo);
      // Mirror the dijkstra rule set. Pure naval → land blocked;
      // any land → naval pays Embark; combo → land requires the
      // combo's hex to be a stronghold.
      const uIsPureNaval = modeIsPureNaval(uInfo);
      const vIsPureNaval = modeIsPureNaval(vInfo);
      const uIsLandSide  = !uIsNaval;
      const vIsLandSide  = !vIsNaval;
      if (uIsPureNaval && vIsLandSide) {
        continue;
      } else if (uIsLandSide && !vIsLandSide) {
        if (!ARMY_CAN_EMBARK) continue;
        const e = +weights["Embark"];
        if (isFinite(e) && e > 0) nd += e;
      } else if (!uIsLandSide && !uIsPureNaval && vIsLandSide) {
        if (!(HEX_STRONGHOLD && HEX_STRONGHOLD.get(uHex))) continue;
        const dw = +weights["Disembark"] || 0;
        if (isFinite(dw) && dw > 0) nd += dw;
      }

      if (nd > ISOCHRONE_BUDGET) continue;
      if (nd < (distMode.get(vKey) ?? Infinity)) {
        distMode.set(vKey, nd);
        heap.push([nd, vKey, vHex, vMode]);
        if (nd < (distHex.get(vHex) ?? Infinity)) distHex.set(vHex, nd);
      }
    }
  }

  // distHex is the reachable set. Project to subhexes for the overlay.
  const reached = new Set(distHex.keys());
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
// Pick the (hex, mode) node that owns a given pixel. The renderer hands
// us a click pixel; we need the matching mode node so dijkstra knows
// which kind of route the user is starting / ending on.
function hexModeAtPixel(pixIdx) {
  if (pixIdx == null || !HEX_MODES || !HEX_ID_PX) return null;
  const hid = HEX_ID_PX[pixIdx];
  if (!hid) return null;
  const modes = HEX_MODES.get(hid);
  if (!modes) return null;
  // O(1) lookup via the per-pixel mode arrays populated by
  // precomputeHexModes. Each pixel belongs to exactly one (kind, comp).
  if (PIX_MODE_KIND && PIX_MODE_COMP) {
    const k = PIX_MODE_KIND[pixIdx];
    if (k) {
      const name = `${MODE_KIND_NAMES[k]}#${PIX_MODE_COMP[pixIdx]}`;
      if (modes.has(name)) return name;
    }
  }
  // Fallback for pixels that aren't in any mode (e.g. user clicked on a
  // blocked pixel) — pick the closest mode-node of the hex by pixel
  // distance so the routing still has somewhere to start/end.
  let best = null, bestDist = Infinity;
  if (SUBHEX_ID_IMG_DATA) {
    const W = SUBHEX_ID_IMG_DATA.width;
    const py = (pixIdx / W) | 0, px = pixIdx - py * W;
    for (const [name, info] of modes) {
      const pxs = info.pixels;
      for (let i = 0; i < pxs.length; i++) {
        const p = pxs[i];
        const qy = (p / W) | 0, qx = p - qy * W;
        const dx = qx - px, dy = qy - py;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestDist) { bestDist = d2; best = name; if (d2 === 0) return name; }
      }
    }
  }
  return best || modes.keys().next().value || null;
}

// Mode-graph dijkstra. State: (hex, mode, runningMaxInCurrentHex). The
// running max model: crossing into a new hex pays the leaving hex's
// running max; intra-hex transitions between modes update the running
// max for free (max(uMax, vMode.cost)). LAND ↔ NAVAL transitions —
// whether intra-hex or cross-hex — add the Embark surcharge. The Ferry
// surcharge is already baked into ROAD_FERRY's mode cost, so just
// entering a ROAD_FERRY node bills it once. Returns:
//   { path: [[hex, mode], ...], hexWeights, pathRoadHexes,
//     pathComponents, totalCost, usedFerryHexes, embarks, ferries }
// path is the (hex, mode) sequence dijkstra picked, in order; the rest
// mirror what the old dijkstra used to return so computeSegment can
// drop in.
// True if the given mode (single OR combo) involves NAVAL traversal. Used
// by dijkstra and the path-reconstruction loop to bill the Embark
// surcharge on transitions in/out of any naval-touching mode. The single
// `info.kind === "NAVAL"` check missed combos like LAND+NAVAL or
// ROAD+NAVAL whose `kind` is the combined string — dijkstra would
// silently route through them embark-free.
function modeIsNaval(info) {
  if (!info) return false;
  if (info.kind === "NAVAL") return true;
  if (info.kinds && info.kinds.indexOf("NAVAL") >= 0) return true;
  return false;
}
// "Pure naval" = NAVAL is the mode's ONLY kind (i.e., it's the NAVAL
// single, not a combo that also includes LAND/ROAD). Used by dijkstra's
// disembark rule: a pure naval → land-side cross-hex edge is blocked
// outright (the only legal disembark is through a LAND+NAVAL combo,
// which exists at every coastal hex but is the only mode-node that
// can mix land and naval kinds in one place).
function modeIsPureNaval(info) {
  if (!info) return false;
  if (info.kind === "NAVAL" && !info.isCombo) return true;
  if (info.kinds && info.kinds.length === 1 && info.kinds[0] === "NAVAL") return true;
  return false;
}
function dijkstraHexModePath(fromHexId, fromMode, toHexId, toMode, fromPixIdx, toPixIdx) {
  if (!HEX_MODES || !HEX_MODE_NEIGHBORS) return null;
  const fromModes = HEX_MODES.get(fromHexId);
  const toModes   = HEX_MODES.get(toHexId);
  if (!fromModes || !toModes) return null;
  // Multi-start / multi-end semantics: the start hex contributes 0 to
  // total cost regardless of which mode is used (free start), and the
  // line A* snaps the click pixel to whichever mode dijkstra picks. So
  // seed every mode of fromHexId as a candidate start, and accept any
  // mode of toHexId as a valid goal.
  //
  // SUBHEX-LEVEL FILTER: only consider modes whose pixel set INCLUDES
  // the click pixel's subhex. Without this, dijkstra can land on a
  // cheaper mode that happens to be in the same hex but a different
  // subhex (e.g., the other bank of a thick river), and the line A*
  // ends up snapping the click pixel to a point on the wrong side of
  // the river. With the filter, dijkstra is forced to enter/exit via
  // a mode that actually covers the click's subhex.
  //
  // Debug overrides (HEX_MODE_OVERRIDES) further restrict the candidate
  // set to just the pinned mode for that hex.
  const startOverride = HEX_MODE_OVERRIDES.get(fromHexId);
  const endOverride   = HEX_MODE_OVERRIDES.get(toHexId);
  // Pixel-level endpoint filter: a mode is a valid start (or end) only
  // if its flood-fill pixel set contains the EXACT click pixel. Looser
  // subhex-level matching let modes on the wrong side of a thick river
  // qualify when their subhex was split — they had pixels in the same
  // subhex as the click, just on the opposite bank. Pixel-level pins
  // the endpoint to a mode that actually reaches the click point.
  const modeContainsPixel = (info, idx) => {
    if (idx == null) return true;   // unknown pixel → no filter
    const pxs = info.pixels;
    for (let i = 0; i < pxs.length; i++) {
      if (pxs[i] === idx) return true;
    }
    return false;
  };

  // DEBUG: detailed log for the long-route diagnostic. Triggered by
  // window.__DEBUG_DIJKSTRA = true in the dev console.
  const DBG = (typeof window !== "undefined") && window.__DEBUG_DIJKSTRA;
  const dbgHexes = (typeof window !== "undefined") && window.__DEBUG_DIJKSTRA_HEXES;
  const dbgLog = DBG ? (...args) => console.log("[djk]", ...args) : () => {};
  if (DBG) {
    dbgLog("start", { fromHexId, fromMode, toHexId, toMode });
    // Dump modes available in 1838 (or whichever hex(es) the user pinned).
    if (dbgHexes) {
      for (const h of dbgHexes) {
        const modes = HEX_MODES.get(h);
        if (modes) {
          const summary = [];
          for (const [name, info] of modes) {
            const nb = HEX_MODE_NEIGHBORS.get(`${h}:${name}`);
            const nbHexes = new Set();
            const nbSelf = [];
            if (nb) for (const k of nb) {
              const c = k.indexOf(":");
              const nh = +k.slice(0, c);
              if (nh === h) nbSelf.push(k.slice(c + 1));
              else nbHexes.add(nh);
            }
            summary.push({ name, cost: info.cost, pixels: info.pixels.length,
              intraHex: nbSelf, neighborHexes: Array.from(nbHexes) });
          }
          dbgLog(`hex ${h} modes:`, summary);
        } else {
          dbgLog(`hex ${h} has NO modes`);
        }
      }
    }
  }

  // Same-hex segment is handled in computeSegment via an early branch
  // that never reaches dijkstra, so fromHexId !== toHexId here.

  const dist = new Map();
  const prev = new Map();
  const heap = new MinHeap2();
  // Heap payload: [d, key, runningMax, hexId, isStart].
  // ── MULTI-START SEED ──
  // Push every candidate start mode of fromHexId at cost 0. Restricted
  // to modes whose pixels include the click pixel's subhex (so dijkstra
  // doesn't snap to a mode on the wrong side of a thick river within
  // the same hex). Pinned start hexes further narrow to just the
  // override.
  const startStateKeys = new Set();
  for (const [mName, mInfo] of fromModes) {
    if (!isFinite(mInfo.cost) || mInfo.cost < 0) continue;
    if (startOverride && mName !== startOverride) continue;
    if (!modeContainsPixel(mInfo, fromPixIdx)) continue;
    const sKey = `${fromHexId}:${mName}`;
    const sStateKey = `${sKey}|${mInfo.cost}`;
    dist.set(sStateKey, 0);
    startStateKeys.add(sStateKey);
    heap.push([0, sKey, mInfo.cost, fromHexId, true]);
  }
  if (heap.size() === 0) return null;     // no valid start modes

  let bestTotal = Infinity, bestStateKey = null;

  while (heap.size() > 0) {
    const [d, , uKey, uMax, uHex, uIsStart] = heap.pop();
    if (d >= bestTotal) break;
    const uStateKey = `${uKey}|${uMax}`;
    if (d > (dist.get(uStateKey) ?? Infinity)) continue;

    // Decode current node.
    const colon = uKey.indexOf(":");
    const uMode = uKey.slice(colon + 1);
    const uInfo = HEX_MODES.get(uHex)?.get(uMode);

    // ── MULTI-END GOAL CHECK ──
    // Any state landing on a mode of toHexId IS a candidate goal — as
    // long as the mode's pixels include the click pixel's subhex (so
    // the line A* actually reaches the click point, not the opposite
    // bank of a river). Pinned end hex further restricts to override.
    if (uHex === toHexId
        && (!endOverride || uMode === endOverride)
        && uInfo && modeContainsPixel(uInfo, toPixIdx)) {
      // Close out destination hex's running max (0 if we never left start).
      const close = uIsStart ? 0 : uMax;
      const total = d + close;
      if (DBG) dbgLog("goal-pop", { d, uMax, close, total, bestTotal });
      if (total < bestTotal) { bestTotal = total; bestStateKey = uStateKey; }
      continue;
    }

    const neighbors = HEX_MODE_NEIGHBORS.get(uKey);
    if (!neighbors) continue;

    const uIsNaval = modeIsNaval(uInfo);

    for (const vKey of neighbors) {
      const colonV = vKey.indexOf(":");
      const vHex = +vKey.slice(0, colonV);
      const vMode = vKey.slice(colonV + 1);
      const vInfo = HEX_MODES.get(vHex)?.get(vMode);
      // Cost of 0 is valid (e.g., Ferry surcharge defaulting to 0).
      // Skip only if cost is non-finite or negative.
      if (!vInfo || !isFinite(vInfo.cost) || vInfo.cost < 0) continue;
      // Honor the debug override — if vHex has a pinned mode, drop edges
      // into any other mode of that hex. Forces dijkstra to traverse the
      // hex via the pinned mode (or fail).
      const vOverride = HEX_MODE_OVERRIDES.get(vHex);
      if (vOverride && vMode !== vOverride) continue;
      const vIsNaval = modeIsNaval(vInfo);

      // ── ONE MODE PER HEX ──
      // Intra-hex transitions (vHex === uHex) are disabled. Every hex
      // must be entered AND exited via the same mode. Multi-kind
      // traversal within a hex has to use a combo mode that bundles
      // the relevant kinds + their sum-cost. Without this skip,
      // dijkstra would chain singletons via free intra-hex moves and
      // the cheapest path would routinely pick multiple modes per
      // hex, defeating the "one picked mode per hex" rule.
      if (vHex === uHex) continue;
      // Cross-hex transition. Pay leaving hex's running max (0 if we
      // never left start), reset to v's mode cost.
      const close = uIsStart ? 0 : uMax;
      let nd = d + close;
      const nMax = vInfo.cost;
      const nHex = vHex;
      const nIsStart = false;
      // ── Naval boundary ──
      // Rule set:
      //   * pure naval → land-side  : BLOCKED. The only legal
      //     disembark is through a LAND+NAVAL combo at a stronghold.
      //   * land-side → any naval   : Embark fires anywhere (no
      //     stronghold required). Covers both direct land→naval
      //     cross-hex edges AND the land→combo entry path.
      //   * combo → land-side       : Disembark, ONLY if the combo
      //     hex (uHex) carries the Stronghold flag. Pays the
      //     Disembark surcharge if any.
      //   * everything else (combo↔combo, combo→naval-pure,
      //     naval-pure→combo, naval-pure→naval-pure) : no boundary
      //     surcharge; the combo's own mode-cost already paid for
      //     the transition.
      const uIsPureNaval = modeIsPureNaval(uInfo);
      const vIsPureNaval = modeIsPureNaval(vInfo);
      const uIsLandSide  = !uIsNaval;
      const vIsLandSide  = !vIsNaval;
      if (uIsPureNaval && vIsLandSide) {
        // Pure naval → land-side: blocked outright.
        continue;
      } else if (uIsLandSide && !vIsLandSide) {
        // Land-side → naval (pure OR combo): Embark fires anywhere.
        const e = +weights["Embark"];
        if (isFinite(e) && e > 0) nd += e;
      } else if (!uIsLandSide && !uIsPureNaval && vIsLandSide) {
        // Combo → land-side: only at strongholds (combo hex = port).
        if (!(HEX_STRONGHOLD && HEX_STRONGHOLD.get(uHex))) continue;
        const dw = +weights["Disembark"] || 0;
        if (isFinite(dw) && dw > 0) nd += dw;
      }

      const nStateKey = `${vKey}|${nMax}`;
      if (nd < (dist.get(nStateKey) ?? Infinity)) {
        dist.set(nStateKey, nd);
        prev.set(nStateKey, uStateKey);
        heap.push([nd, vKey, nMax, nHex, nIsStart]);
      }
    }
  }

  if (bestStateKey == null) return null;

  // Reconstruct (hex, mode) sequence (deduped consecutive same-key).
  const keys = [];
  let cur = bestStateKey;
  // Multi-start prev-chain walk: terminate at any seeded start state
  // (those have no entry in `prev` since they were enqueued without one).
  while (cur != null) {
    keys.push(cur);
    if (startStateKeys.has(cur)) break;
    const p = prev.get(cur);
    if (!p) break;
    cur = p;
  }
  keys.reverse();
  const path = [];
  const hexWeights = new Map();
  const pathRoadHexes = new Set();
  const usedFerryHexes = new Set();
  let embarks = 0, ferries = 0;
  let lastKey = null;
  let prevKind = null;
  for (const sk of keys) {
    const pipe = sk.indexOf("|");
    const k = sk.slice(0, pipe);
    if (k === lastKey) continue;
    const colon = k.indexOf(":");
    const hex = +k.slice(0, colon);
    const mode = k.slice(colon + 1);
    const info = HEX_MODES.get(hex)?.get(mode);
    if (!info) continue;
    path.push([hex, mode]);
    const prevMax = hexWeights.get(hex);
    if (prevMax == null || info.cost > prevMax) hexWeights.set(hex, info.cost);
    // Combo modes carry a `kinds` array; single modes only have `kind`.
    // Normalize so the checks below work on both.
    const infoKinds = info.kinds || [info.kind];
    if (infoKinds.indexOf("ROAD") >= 0 || infoKinds.indexOf("ROAD_FERRY") >= 0) pathRoadHexes.add(hex);
    if (info.isFerry) { ferries++; usedFerryHexes.add(hex); }
    // Embark count tracks land → naval boundary crossings only (boarding
    // a ship). Disembarks (naval → land) are tracked separately because
    // they're free under the current cost model and only allowed at
    // Stronghold hexes. prevKind is a boolean "was the previous mode
    // naval-touching?" so the comparison works for both single and combo
    // modes.
    const isNaval = modeIsNaval(info);
    if (prevKind === false && isNaval === true) embarks++;
    prevKind = isNaval;
    lastKey = k;
  }

  // pathComponents — kept for callers (tooltip, etc.) but mode-graph
  // doesn't track per-component data. Leave empty; downstream consumers
  // that need it will fall through.
  const pathComponents = new Set();

  if (DBG) {
    dbgLog("FINAL path:", path.map(([h, m]) => `${h}:${m}`).join(" -> "));
    dbgLog("FINAL totalCost:", bestTotal, "ferries:", ferries, "embarks:", embarks);
  }

  return {
    path,
    hexWeights,
    pathRoadHexes,
    pathComponents,
    totalCost: bestTotal,
    usedFerryHexes,
    embarks,
    ferries,
  };
}

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
      // (The old assigned-weight transit restriction — blocking land
      // subhexes whose class weight exceeded the parent hex's terrain
      // weight, e.g. a Mountains subhex inside a Flatlands hex — has
      // been removed. Heavier-than-assigned land subhexes are now
      // traversable; the parent hex's terrain weight still drives the
      // per-hex traversal cost.)

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
let MIN_PIXELS_PER_PATH_HEX = 50;

// Walk the rendered line pixel-by-pixel using the same Bresenham+thick
// stamp drawPathLine uses, counting DISTINCT painted pixels per hex.
// Returns EVERY hex the line crossed (in first-seen order). Hexes the
// drawn line covers fewer than MIN_PIXELS_PER_PATH_HEX pixels in are
// kept in the path but their effective weight is forced to 0 — "free"
// hexes. The segment's cost-adjustment step refunds dijkstra's per-hex
// contribution for these hexes downstream.
//
// Returns:
//   hexPath          — full ordered list of hexes the line crossed
//   hexWeights       — per-hex effective weight (0 for sub-threshold hexes)
//   pxCount          — per-hex DISTINCT-painted pixel count (line-width aware)
//   subThresholdHexes — Set of hex ids the line painted < threshold px in
//   allCrossed       — full set (same as hexPath, kept for backward compat)
//
// alwaysInclude is an iterable of hex ids that must be considered full-cost
// regardless of pixel count (start/end hexes — user explicitly clicked them).
function countLineMainHexes(linePts, alwaysInclude) {
  const out = {
    hexPath: [], hexWeights: new Map(), pxCount: new Map(),
    subThresholdHexes: new Set(), allCrossed: new Set(),
  };
  if (!linePts || linePts.length < 1 || !HEX_ID_PX || !SUBHEX_ID_PX || !SUBHEX_ID_IMG_DATA) return out;
  const W = SUBHEX_ID_IMG_DATA.width, H = SUBHEX_ID_IMG_DATA.height;
  // Distinct painted pixels per hex (line-width-aware).
  const painted  = new Map();   // hex_id -> Set<full pixel index>
  const weightMx = new Map();
  const firstAt  = new Map();
  let seq = 0;
  // Mirror drawPathLine's stamp size: a Math.max(1, round(LINE_WIDTH)) ×
  // same square centered at each Bresenham step, with half = floor(thick/2).
  // Adjacent stamps overlap heavily, so we de-dupe via the per-hex Set.
  const thick = Math.max(1, Math.round(LINE_WIDTH));
  const half  = Math.floor(thick / 2);
  // Sample a SINGLE pixel into the per-hex painted set + update weight tracking.
  const sampleOne = (x, y) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const fullIdx = y * W + x;
    const hid = HEX_ID_PX[fullIdx];
    if (!hid) return;
    let set = painted.get(hid);
    if (!set) {
      set = new Set();
      painted.set(hid, set);
      firstAt.set(hid, seq);
    }
    seq++;
    set.add(fullIdx);
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
  // Stamp a thick×thick square at (cx, cy), matching drawPathLine's
  // pixel-perfect Bresenham mode. For thick = 1 it's just the single
  // pixel; for larger thicks the centered square gets painted.
  const stamp = (cx, cy) => {
    if (thick <= 1) { sampleOne(cx, cy); return; }
    for (let oy = -half; oy < thick - half; oy++) {
      for (let ox = -half; ox < thick - half; ox++) {
        sampleOne(cx + ox, cy + oy);
      }
    }
  };
  for (let i = 0; i < linePts.length - 1; i++) {
    let x0 = Math.round(linePts[i].x),     y0 = Math.round(linePts[i].y);
    const x1 = Math.round(linePts[i + 1].x), y1 = Math.round(linePts[i + 1].y);
    const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
    const dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    while (true) {
      stamp(x0, y0);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }
  // Convert the per-hex painted Sets to plain counts for downstream code.
  const count = new Map();
  for (const [hid, set] of painted) count.set(hid, set.size);
  // Force-include start/end (and anything else the caller pins). Pinned
  // hexes always get full cost — they can't be sub-threshold.
  const pinned = new Set();
  if (alwaysInclude) for (const hid of alwaysInclude) { if (hid != null) pinned.add(hid); }
  // Build the full hex path — every hex the line touched, sorted by
  // first-sampled order. A pinned hex the line never sampled (e.g., a
  // start hex where the click pixel lands exactly at the segment endpoint)
  // gets injected with a synthetic earlier order.
  const main = [];
  for (const hid of count.keys()) main.push(hid);
  for (const hid of pinned) {
    if (!firstAt.has(hid)) {
      firstAt.set(hid, -1 - main.length);
      main.push(hid);
    }
  }
  main.sort((a, b) => firstAt.get(a) - firstAt.get(b));
  out.hexPath = main;
  // Per-hex effective weight: 0 for sub-threshold (non-pinned) hexes,
  // otherwise the max effective weight the line actually crossed.
  for (const hid of main) {
    const c = count.get(hid) || 0;
    out.pxCount.set(hid, c);
    const subThreshold = !pinned.has(hid) && c < MIN_PIXELS_PER_PATH_HEX;
    if (subThreshold) {
      out.subThresholdHexes.add(hid);
      out.hexWeights.set(hid, 0);
    } else {
      const w = weightMx.get(hid);
      if (isFinite(w)) out.hexWeights.set(hid, w);
    }
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
    // Count only land → water crossings (embark events). Disembarks
    // (water → land) are free under the current cost model and only
    // allowed at Stronghold hexes — dijkstra refuses the transition
    // otherwise, so we don't separately tally them here.
    const w = WATER_TERRAINS.has(sub.class);
    if (prevIsWater === false && w === true) crossings++;
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
  // ── Same-hex segment ───────────────────────────────────────────────
  // Two waypoints inside one hex. Movement INSIDE a single component
  // (a LAND# or NAVAL# region with no river / shoreline between the
  // two click pixels) is free — the user is already in the hex and
  // doesn't pay the per-hex traversal weight. But a river splitting
  // the hex into two LAND components, or a stranded sea subhex
  // between the two click points, means the route has to cross
  // either via a combo mode (LAND+FORD, LAND+ROAD_FERRY, etc.) or via
  // a detour out through a neighbour hex. The combo carries the
  // fording / ferry / embark surcharges as its mode-cost extras, and
  // those *are* charged even for the starting hex.
  if (wa.hexId === wb.hexId) {
    const hexId = wa.hexId;
    const modes = HEX_MODES && HEX_MODES.get(hexId);
    const Ws = SUBHEX_ID_IMG_DATA ? SUBHEX_ID_IMG_DATA.width : 0;
    const fromPixIdx = (Ws > 0) ? ((wa.px.y | 0) * Ws + (wa.px.x | 0)) : null;
    const toPixIdx   = (Ws > 0) ? ((wb.px.y | 0) * Ws + (wb.px.x | 0)) : null;
    // Find the cheapest mode of this hex whose pixel set contains
    // BOTH endpoint pixels. Returns null if no single mode covers
    // them (caller falls through to the cross-hex detour path).
    const findCoveringMode = () => {
      if (!modes || fromPixIdx == null || toPixIdx == null) return null;
      let bestName = null, bestExtra = Infinity, bestInfo = null;
      for (const [name, info] of modes) {
        const pixs = info.pixels;
        if (!pixs || pixs.length === 0) continue;
        let hasF = false, hasT = false;
        for (let i = 0; i < pixs.length; i++) {
          const p = pixs[i];
          if (p === fromPixIdx) hasF = true;
          if (p === toPixIdx)   hasT = true;
          if (hasF && hasT) break;
        }
        if (!(hasF && hasT)) continue;
        // Same-hex "extras" — the slice of this mode's cost the user
        // still has to pay even though the hex itself is the start.
        // LAND / ROAD / NAVAL by themselves contribute zero (free
        // intra-component movement); FORD and ROAD_FERRY surcharges
        // are real per-crossing costs we keep.
        let extra = 0;
        if (info.kinds) {
          for (const k of info.kinds) {
            if (k === "FORD")       extra += armyFordCost();
            if (k === "ROAD_FERRY") extra += (+weights["Ferry"] || 0);
          }
        }
        if (extra < bestExtra) {
          bestExtra = extra;
          bestName = name;
          bestInfo = info;
        }
      }
      if (bestName == null) return null;
      return { name: bestName, info: bestInfo, extra: bestExtra };
    };
    const covering = findCoveringMode();
    if (covering) {
      // Render via the standard mode-graph pipeline so naval scrub,
      // corner augmentation, ferry-mark / city waypoint injection, and
      // ferry thinning all still apply for in-hex traversals.
      const debugSink = {};
      const linePts = routeLineFromModes(
        [[hexId, covering.name]], wa.px, wb.px, debugSink
      );
      const finalLine = (linePts && linePts.length > 0)
        ? linePts
        : [{ x: wa.px.x, y: wa.px.y }, { x: wb.px.x, y: wb.px.y }];
      const embarks = countSubhexEmbarks(finalLine);
      const fr      = countFerryCrossings(finalLine);
      const ferries = fr.count;
      const usedFerryHexes = fr.used;
      return {
        hexIds: [hexId],
        subhexIds: new Set([wa.subhexId, wb.subhexId]),
        // Combo surcharges + line-derived embark/ferry crossings. A
        // single-LAND/ROAD/NAVAL covering mode contributes nothing on
        // its own — the cost ends up being purely the boundary
        // surcharges the rendered line happens to cross.
        cost: covering.extra
              + embarks * (+weights["Embark"])
              + ferries * (+weights["Ferry"]),
        embarks,
        ferries,
        usedFerryHexes,
        sameHex: true, reachable: true,
        linePts: finalLine,
        debugMask: debugSink.mask ? debugSink : null,
        modePath: [[hexId, covering.name]],
      };
    }
    // Fall through to the dijkstra cross-hex path. The router will
    // detour out through a neighbour hex and back — that's the only
    // way to get between the two subhexes if no single mode of this
    // hex covers both (river impassable, ford disabled, etc.).
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
  // Mode-graph dijkstra: pick start/end (hex, mode) nodes from the
  // click pixels, then route through the hex-mode graph. Both dijkstra
  // and the renderer use this single graph as the source of truth, so
  // there's no "dijkstra found a path the renderer can't follow"
  // mismatch anymore.
  const fromMode = hexModeAtPixel(fromPixIdx);
  const toMode   = hexModeAtPixel(toPixIdx);
  if (!fromMode || !toMode) {
    return { hexIds: [], subhexIds: new Set(), cost: 0, embarks: 0, ferries: 0,
             sameHex: false, reachable: false, linePts: null, debugMask: null };
  }
  const djk = dijkstraHexModePath(wa.hexId, fromMode, wb.hexId, toMode, fromPixIdx, toPixIdx);
  if (!djk) {
    return { hexIds: [], subhexIds: new Set(), cost: 0, embarks: 0, ferries: 0,
             sameHex: false, reachable: false, linePts: null, debugMask: null };
  }
  // Unpack mode-graph results. modeHexPath is the deduplicated hex
  // sequence; modePath is the (hex, mode) sequence dijkstra picked.
  const modePath     = djk.path;          // [[hex, mode], ...]
  const hexWeights   = djk.hexWeights;
  const pathRoadHexes = djk.pathRoadHexes;
  const pathComponents = djk.pathComponents;  // empty in mode-graph; kept for tooltip compat
  const usedFerryHexes = djk.usedFerryHexes;
  const dijkstraTotalCost = djk.totalCost;
  const dijkstraEmbarks = djk.embarks;
  const dijkstraFerries = djk.ferries;
  // Derive the hex path from modePath (consecutive-dedupe).
  const hexPath = [];
  for (const [hex] of modePath) {
    if (hexPath.length === 0 || hexPath[hexPath.length - 1] !== hex) {
      hexPath.push(hex);
    }
  }
  // Legacy subhexPath for downstream code (debug mask, tooltip etc.) — we
  // no longer have a subhex sequence, but expose an empty array so
  // existing access patterns don't crash.
  const subhexPath = [];
  // subSet: subhex ids the chosen mode pixels actually fall in. Used by
  // the path-mask overlay and a few legacy bits of code; derived now
  // from the chosen mode pixels instead of the old subhex sequence.
  const subSet = new Set();
  if (wa.subhexId != null) subSet.add(wa.subhexId);
  if (wb.subhexId != null) subSet.add(wb.subhexId);
  const Wfull = SUBHEX_ID_IMG_DATA ? SUBHEX_ID_IMG_DATA.width : 0;
  if (Wfull > 0 && SUBHEX_ID_PX) {
    for (const [hex, mode] of modePath) {
      const info = HEX_MODES.get(hex)?.get(mode);
      if (!info) continue;
      // Sample one pixel per ~50 to keep this cheap on long routes.
      const step = Math.max(1, (info.pixels.length / 256) | 0);
      for (let i = 0; i < info.pixels.length; i += step) {
        const sid = SUBHEX_ID_PX[info.pixels[i]];
        if (sid) subSet.add(sid);
      }
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
  // Mode-graph rendering: mask is the union of chosen (hex, mode)'s
  // pixel sets, A* finds the shortest path through it. No tier
  // escalation needed — the mode graph guarantees the renderer can
  // follow any path dijkstra picked.
  let linePts = routeLineFromModes(modePath, wa.px, wb.px, debugSink);

  // Embark / ferry counts come from the rendered line so the UI matches
  // the visible line. Dijkstra also tracks its own counts (used in the
  // mode-graph cost optimisation) — we use the line-derived ones for
  // the UI displays since they're tied directly to what's on screen.
  const embarks    = linePts ? countSubhexEmbarks(linePts)   : dijkstraEmbarks;
  const ferryRes   = linePts ? countFerryCrossings(linePts)  : { count: dijkstraFerries, used: usedFerryHexes };
  const ferries    = ferryRes.count;
  const lineUsedFerryHexes = ferryRes.used;

  // Line-derived per-hex pixel count + max effective weight. Hexes the
  // line spent fewer than MIN_PIXELS_PER_PATH_HEX pixels in are flagged
  // sub-threshold and get a hexWeight of 0 (the "barely-touched hexes
  // are free" rule). Start and end hexes are pinned as full-cost so they
  // never count as sub-threshold regardless of how few line pixels they
  // contain.
  const lineMain = countLineMainHexes(linePts, [wa.hexId, wb.hexId]);

  // Cost adjustment for sub-threshold hexes. dijkstra's bestTotal is what
  // dijkstra optimised over (each non-start hex contributed its running
  // max). For every sub-threshold hex EXCEPT the segment's start hex
  // (whose contribution was 0 in dijkstra anyway), refund dijkstra's
  // per-hex contribution to bring the total down to the "barely-touched
  // hexes are free" cost.
  let adjustedCost = dijkstraTotalCost;
  if (lineMain.subThresholdHexes && lineMain.subThresholdHexes.size > 0) {
    for (const subHex of lineMain.subThresholdHexes) {
      if (subHex === wa.hexId) continue;   // start contributed 0 already
      const w = hexWeights.get(subHex);
      if (isFinite(w)) adjustedCost -= w;
    }
    // Floor at 0 just in case of accumulated FP slop or surcharges that
    // shouldn't be negated.
    if (adjustedCost < 0) adjustedCost = 0;
  }
  return {
    hexIds: hexPath,           // hex sequence — drives count, distance, breakdown
    subhexIds: subSet,
    subhexPath,                // empty under mode graph; kept for compat
    pathRoadHexes,             // hexes dijkstra routed via ROAD / ROAD_FERRY
    pathComponents,            // empty under mode graph; kept for compat
    modePath,                  // [[hex, mode], ...] — the actual graph path
    lineHexPath: lineMain.hexPath,
    hexWeights: lineMain.hexWeights.size > 0 ? lineMain.hexWeights : hexWeights,
                               // Line-derived weights for the breakdown UI
                               // when available — falls back to dijkstra's
                               // per-hex mode cost. Sub-threshold hexes
                               // appear here with weight 0.
    dijkstraHexWeights: hexWeights,
    subThresholdHexes: lineMain.subThresholdHexes,
    hexPxCount:        lineMain.pxCount,
    cost: adjustedCost,
    embarks,
    ferries,
    usedFerryHexes: lineUsedFerryHexes,
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
  // forcedSegments is a parallel boolean array — one entry per gap
  // between adjacent waypoints. Keep its length in sync as waypoints are
  // added/removed; preserve existing flags for surviving segments.
  if (!Array.isArray(route.forcedSegments)) route.forcedSegments = [];
  const wantLen = Math.max(0, route.waypoints.length - 1);
  while (route.forcedSegments.length < wantLen) route.forcedSegments.push(false);
  while (route.forcedSegments.length > wantLen) route.forcedSegments.pop();
  for (let i = 1; i < route.waypoints.length; i++) {
    const forced = !!route.forcedSegments[i - 1];
    let seg;
    if (forced) {
      // Swap to the forced-march weight context for this segment only.
      // Same-hex segments use weights["Embark"]/["Ferry"] directly, and
      // dijkstraHexModePath reads HEX_MODES + weights["Embark"|"Disembark"]
      // at runtime — covering both via globals keeps the swap local.
      const _w = weights, _rw = roadWeights, _hm = HEX_MODES;
      weights = forcedWeights;
      roadWeights = forcedRoadWeights;
      if (HEX_MODES_FORCED) HEX_MODES = HEX_MODES_FORCED;
      try {
        seg = computeSegment(route.waypoints[i - 1], route.waypoints[i]);
      } finally {
        weights = _w; roadWeights = _rw; HEX_MODES = _hm;
      }
    } else {
      seg = computeSegment(route.waypoints[i - 1], route.waypoints[i]);
    }
    seg.forced = forced;
    route.segments.push(seg);
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
    // Per-gap forced-march flags. forcedSegments[i] applies to the
    // segment between waypoints[i] and waypoints[i+1].
    forcedSegments: [],
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
  // Keep forcedSegments aligned: removing waypoint `idx` deletes either
  // the outgoing segment (idx → idx+1) at the same index, or the last
  // segment when idx is the tail. The remaining flags then map onto the
  // surviving segment positions correctly.
  if (Array.isArray(route.forcedSegments) && route.forcedSegments.length > 0) {
    const removeAt = Math.min(idx, route.forcedSegments.length - 1);
    route.forcedSegments.splice(removeAt, 1);
  }
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

// ── Debug: hex-mode overrides ─────────────────────────────────────────────
// Pin a specific (hex, mode) so dijkstra is restricted to that mode for the
// given hex. Returns true if the mode exists on the hex.
//
// Pinning does NOT trigger a route recompute — the user explicitly asked
// for the dijkstra path to stay frozen while they stage pins, so they can
// compare the pre-pin path against the post-pin one. The picker exposes an
// "Apply pinned overrides" action that calls applyHexModeOverrides() to
// rebuild routes once the user is ready to see the change.
function setHexModeOverride(hid, modeName) {
  if (!HEX_MODES) return false;
  const modes = HEX_MODES.get(hid);
  if (!modes || !modes.has(modeName)) return false;
  HEX_MODE_OVERRIDES.set(hid, modeName);
  return true;
}
function clearHexModeOverride(hid) {
  if (!HEX_MODE_OVERRIDES.has(hid)) return false;
  HEX_MODE_OVERRIDES.delete(hid);
  return true;
}
function clearAllHexModeOverrides() {
  if (HEX_MODE_OVERRIDES.size === 0) return false;
  HEX_MODE_OVERRIDES.clear();
  return true;
}
function getHexModeOverride(hid) {
  return HEX_MODE_OVERRIDES.get(hid) || null;
}
// Explicit "apply" — rebuild routes so the staged overrides take effect.
function applyHexModeOverrides() {
  for (const r of ROUTES) rebuildRoute(r);
  syncActiveProjection();
}
// Alias retained for any callers that still expect the old name.
const recomputeAllRoutes = applyHexModeOverrides;

// ── Save / load routes ─────────────────────────────────────────────────────
// Serialise the current ROUTES to a compact JSON blob: just waypoint
// identifiers + click pixels + color, no derived state (segments / totals
// rebuild from the waypoints on load). Returns a string ready to download.
function serializeRoutes() {
  const payload = {
    version: 1,
    activeRouteId: ACTIVE_ROUTE_ID,
    routes: ROUTES.map(r => ({
      id: r.id,
      color: r.color.slice(),
      waypoints: r.waypoints.map(wp => ({
        subhexId: wp.subhexId,
        hexId:    wp.hexId,
        px:       { x: wp.px.x, y: wp.px.y },
      })),
      // Per-gap forced-march flags (one entry per segment between
      // adjacent waypoints). Older save files without this field load
      // with every segment at normal march.
      forcedSegments: Array.isArray(r.forcedSegments) ? r.forcedSegments.slice() : [],
    })),
  };
  return JSON.stringify(payload, null, 2);
}

// Trigger a browser download of the current routes as a JSON file. The
// filename includes a timestamp so multiple saves don't clobber each other.
function saveRoutesToFile() {
  const text = serializeRoutes();
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const a = document.createElement("a");
  a.href = url;
  a.download = `ravages-routes-${ts}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Defer revoking so Firefox/Safari can actually start the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Replace the current ROUTES with the contents of a parsed JSON payload.
// Validates each waypoint's subhexId against SUBHEX_INDEX so a stale save
// file (referring to a subhex id that no longer exists) loads partially
// rather than throwing. Each waypoint that survives gets its hexId and
// px snapped to the current SUBHEX_INDEX entry's centroid when the saved
// hexId/px look bogus.
function loadRoutesFromObject(payload) {
  if (!payload || !Array.isArray(payload.routes)) {
    throw new Error("Invalid routes file (missing 'routes' array)");
  }
  clearAllRoutes();
  let firstNewId = -1;
  for (const sr of payload.routes) {
    const route = newRoute();
    if (firstNewId < 0) firstNewId = route.id;
    if (Array.isArray(sr.color) && sr.color.length === 3) {
      route.color = sr.color.slice(0, 3).map(v => Math.max(0, Math.min(255, v | 0)));
    }
    // newRoute() starts the route empty and active. Push waypoints
    // directly (skipping addWaypointToActive's syncActiveProjection
    // churn) and rebuild once at the end.
    for (const wp of (sr.waypoints || [])) {
      const sid = +wp.subhexId;
      if (!isFinite(sid)) continue;
      const sub = SUBHEX_INDEX.get(sid);
      if (!sub) continue;
      const hexId = (typeof wp.hexId === "number") ? wp.hexId : sub.hex;
      const px = (wp.px && isFinite(+wp.px.x) && isFinite(+wp.px.y))
        ? { x: +wp.px.x, y: +wp.px.y }
        : { x: sub.centroid[0], y: sub.centroid[1] };
      route.waypoints.push({ subhexId: sid, hexId, px });
    }
    // Restore per-gap forced-march flags if the save file includes them.
    // rebuildRoute will pad/trim to the right length.
    if (Array.isArray(sr.forcedSegments)) {
      route.forcedSegments = sr.forcedSegments.map(v => !!v);
    }
    rebuildRoute(route);
  }
  // Restore the active-route selection if the saved id is still around;
  // otherwise default to the last route created (newRoute's behavior).
  if (payload.activeRouteId != null) {
    // Saved ids were assigned by the file-writing session; on load we
    // created fresh ids in order, so we map by position.
    const savedIdx = payload.routes.findIndex(r => r.id === payload.activeRouteId);
    if (savedIdx >= 0 && savedIdx < ROUTES.length) {
      ACTIVE_ROUTE_ID = ROUTES[savedIdx].id;
    }
  }
  syncActiveProjection();
}

// Top-level entry from the file-input change handler.
function loadRoutesFromFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        loadRoutesFromObject(data);
        resolve();
      } catch (e) {
        reject(e);
      }
    };
    reader.onerror = () => reject(reader.error || new Error("read failed"));
    reader.readAsText(file);
  });
}

// Compute the image-space bounding box of a route — both the click
// pixels (waypoints) and every rendered line point, so a route that
// snakes far from its waypoints still fits in the camera. Returns null
// if the route is empty.
function routeBoundingBox(route) {
  if (!route || route.waypoints.length === 0) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const grow = (x, y) => {
    if (!isFinite(x) || !isFinite(y)) return;
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  };
  for (const wp of route.waypoints) grow(wp.px.x, wp.px.y);
  if (route.segments) {
    for (const seg of route.segments) {
      if (!seg.linePts) continue;
      for (const p of seg.linePts) grow(p.x, p.y);
    }
  }
  if (!isFinite(x0)) return null;
  return { x0, y0, x1, y1 };
}

// Pan/zoom the camera so the given route fills the stage with a small
// margin. Single-waypoint routes get a fixed zoom so they don't snap to
// absurd magnification.
function fitCameraToRoute(route) {
  const bbox = routeBoundingBox(route);
  if (!bbox || !HEX_DATA) return;
  const r = stage.getBoundingClientRect();
  const PAD = 80;     // px of margin on each side in stage space
  const usableW = Math.max(50, r.width  - PAD * 2);
  const usableH = Math.max(50, r.height - PAD * 2);
  const bw = Math.max(1, bbox.x1 - bbox.x0);
  const bh = Math.max(1, bbox.y1 - bbox.y0);
  // For a single-point route (1 waypoint, no segments) the bbox is a
  // dot — fall back to a comfortable zoom rather than max-out.
  const isPoint = route.waypoints.length === 1 && (!route.segments || route.segments.every(s => !s.linePts || s.linePts.length === 0));
  let scale;
  if (isPoint) {
    scale = Math.min(2, view.scale > 0.8 ? view.scale : 1);
  } else {
    scale = Math.min(usableW / bw, usableH / bh);
    // Clamp to the same range as zoomAt so the view stays sane.
    scale = Math.max(0.05, Math.min(8, scale));
  }
  view.scale = scale;
  const cx = (bbox.x0 + bbox.x1) / 2;
  const cy = (bbox.y0 + bbox.y1) / 2;
  view.x = r.width  / 2 - cx * scale;
  view.y = r.height / 2 - cy * scale;
  applyView();
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
// Draw a line through the mode graph's chosen pixel sets. The mask is
// the union of every (hex, mode)'s pixels along the path; A* finds the
// shortest pixel route inside that mask from the start click pixel to
// the end click pixel. No tier escalation, no adj broadening — the
// mode graph already encodes everything renderable.
//
// modePath: [[hex, mode], ...] from dijkstraHexModePath
// startPt, endPt: { x, y } click pixels
// debugSink (optional): { mask, mw, mh, bx0, by0 } target for the
//                       debug overlay; if omitted, _lastRouteMask is updated.
function routeLineFromModes(modePath, startPt, endPt, debugSink) {
  if (!modePath || modePath.length === 0 || !SUBHEX_ID_IMG_DATA) {
    if (startPt && endPt) return [{ x: startPt.x, y: startPt.y }, { x: endPt.x, y: endPt.y }];
    return [];
  }
  const W = SUBHEX_ID_IMG_DATA.width, H = SUBHEX_ID_IMG_DATA.height;

  // Compute mask bbox = bounding box of every mode's pixels.
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  const modeInfos = [];
  const routeHexSet = new Set();
  for (const [hex, mode] of modePath) {
    const info = HEX_MODES.get(hex)?.get(mode);
    if (!info) continue;
    routeHexSet.add(hex);
    modeInfos.push(info);
    for (let i = 0; i < info.pixels.length; i++) {
      const p = info.pixels[i];
      const py = (p / W) | 0;
      const px = p - py * W;
      if (px < bx0) bx0 = px;
      if (px > bx1) bx1 = px;
      if (py < by0) by0 = py;
      if (py > by1) by1 = py;
    }
  }
  // ── Adjoining-road sub-threshold widening ───────────────────────
  // For each route hex whose chosen mode is road-containing, look at
  // its 6 neighbours. If a neighbour has a single ROAD mode whose
  // component pixel count is BELOW MIN_PIXELS_PER_PATH_HEX AND whose
  // pixels are 8-connected to the route hex's chosen-mode pixels,
  // include that road stub in the mask. Brief line dips through it
  // get refunded as sub-threshold (cost 0) by countLineMainHexes /
  // adjustedCost downstream. Anything else from the neighbour stays
  // out of the mask, so the line is still hex-confined for everything
  // except tiny adjoining road continuations.
  const nbModeInfos = [];
  if (typeof hexNeighbors === "function" && HEX_MODES) {
    for (const [hex, mode] of modePath) {
      const info = HEX_MODES.get(hex)?.get(mode);
      if (!info) continue;
      const routeKinds = info.kinds || (info.kind ? [info.kind] : []);
      if (routeKinds.indexOf("ROAD") < 0) continue;
      // Build a Set of the route mode's pixels so the 8-adjacency
      // check below is O(1) per neighbour pixel.
      const routePixSet = new Set();
      for (let i = 0; i < info.pixels.length; i++) routePixSet.add(info.pixels[i]);
      for (const nbHex of hexNeighbors(hex)) {
        if (routeHexSet.has(nbHex)) continue;
        const nbModes = HEX_MODES.get(nbHex);
        if (!nbModes) continue;
        for (const [, nbInfo] of nbModes) {
          if (nbInfo.isCombo) continue;
          if (nbInfo.kind !== "ROAD") continue;
          if (nbInfo.pixels.length >= MIN_PIXELS_PER_PATH_HEX) continue;
          // 8-adjacency test against the route mode's pixel set.
          let connected = false;
          const npx = nbInfo.pixels;
          for (let i = 0; i < npx.length && !connected; i++) {
            const p = npx[i];
            const py = (p / W) | 0;
            const px = p - py * W;
            for (let dy = -1; dy <= 1 && !connected; dy++) {
              const ny = py + dy;
              if (ny < 0 || ny >= H) continue;
              for (let dx = -1; dx <= 1; dx++) {
                if (dx === 0 && dy === 0) continue;
                const nx = px + dx;
                if (nx < 0 || nx >= W) continue;
                if (routePixSet.has(ny * W + nx)) { connected = true; break; }
              }
            }
          }
          if (!connected) continue;
          // Adjacent + sub-threshold + contiguous: include it.
          nbModeInfos.push(nbInfo);
          for (let i = 0; i < npx.length; i++) {
            const p = npx[i];
            const py = (p / W) | 0;
            const px = p - py * W;
            if (px < bx0) bx0 = px;
            if (px > bx1) bx1 = px;
            if (py < by0) by0 = py;
            if (py > by1) by1 = py;
          }
        }
      }
    }
  }
  // Include start/end pixels in bbox so snapToMask can reach them.
  if (startPt) {
    if ((startPt.x | 0) < bx0) bx0 = startPt.x | 0;
    if ((startPt.x | 0) > bx1) bx1 = startPt.x | 0;
    if ((startPt.y | 0) < by0) by0 = startPt.y | 0;
    if ((startPt.y | 0) > by1) by1 = startPt.y | 0;
  }
  if (endPt) {
    if ((endPt.x | 0) < bx0) bx0 = endPt.x | 0;
    if ((endPt.x | 0) > bx1) bx1 = endPt.x | 0;
    if ((endPt.y | 0) < by0) by0 = endPt.y | 0;
    if ((endPt.y | 0) > by1) by1 = endPt.y | 0;
  }
  if (!isFinite(bx0)) return [];
  bx0 = Math.max(0, bx0 - 1); by0 = Math.max(0, by0 - 1);
  bx1 = Math.min(W - 1, bx1 + 1); by1 = Math.min(H - 1, by1 + 1);
  const mw = bx1 - bx0 + 1, mh = by1 - by0 + 1;

  const mask = new Uint8Array(mw * mh);
  for (const info of modeInfos) {
    for (let i = 0; i < info.pixels.length; i++) {
      const p = info.pixels[i];
      const py = (p / W) | 0;
      const px = p - py * W;
      const idx = (py - by0) * mw + (px - bx0);
      mask[idx] = 1;
    }
  }
  // Stamp the side-compatible neighbour mode pixels gathered above so
  // line A* has them available for brief sub-threshold detours.
  for (const nbInfo of nbModeInfos) {
    for (let i = 0; i < nbInfo.pixels.length; i++) {
      const p = nbInfo.pixels[i];
      const py = (p / W) | 0;
      const px = p - py * W;
      const lx = px - bx0, ly = py - by0;
      if (lx >= 0 && lx < mw && ly >= 0 && ly < mh) {
        mask[ly * mw + lx] = 1;
      }
    }
  }

  // ── Pure-land route: scrub naval-subhex pixels from the mask ─────
  // Routes whose chosen modePath uses no NAVAL kind shouldn't have
  // any naval pixel in the mask in the first place, but if anything
  // slips in (combo build, augmenter, off-by-one), the line A* could
  // still trace through a lake pixel. Belt-and-braces: walk the mask
  // once, drop any pixel whose subhex is naval-classed. Skipped when
  // any chosen mode carries the NAVAL kind so legitimate naval routes
  // keep their pixels.
  let pathHasNaval = false;
  for (const info of modeInfos) {
    const kinds = info.kinds || (info.kind ? [info.kind] : []);
    if (kinds.indexOf("NAVAL") >= 0) { pathHasNaval = true; break; }
  }
  if (!pathHasNaval && SUBHEX_ID_PX && SUBHEX_INDEX) {
    for (let y = 0; y < mh; y++) {
      const rowBase = y * mw;
      for (let x = 0; x < mw; x++) {
        const localIdx = rowBase + x;
        if (!mask[localIdx]) continue;
        const fullIdx = (by0 + y) * W + (bx0 + x);
        const sid = SUBHEX_ID_PX[fullIdx];
        if (!sid) continue;
        const sub = SUBHEX_INDEX.get(sid);
        if (sub && WATER_TERRAINS.has(sub.class)) mask[localIdx] = 0;
      }
    }
  }

  // ── Cross-hex corner augmentation ─────────────────────────────────
  // When two picked-mode pixels are diagonal across a hex border, the
  // line A* needs the orthogonal corner cells to be in the mask to
  // make the diagonal move. Mode-graph edges count diagonals as valid
  // when one corner is globally passable, but the route mask only
  // contains picked-mode pixels — so the corner pixel might exist in
  // some OTHER mode of an adjacent hex and not be in the mask. Result:
  // visible gap, two halves of the route that are diagonally adjacent
  // but disconnected.
  //
  // Scope: only diagonal pairs where the two pixels are in DIFFERENT
  // hexes (cross-hex). Intra-hex diagonals are left untouched so
  // pinned modes stay strict and the line doesn't drift through
  // non-picked modes within a hex.
  //
  // For each cross-hex diagonal in the ORIGINAL mask:
  //   * If a corner pixel is globally passable (some mode owns it),
  //     add it to the mask.
  //   * Skip if the corner falls in a hex with an active override —
  //     that hex's line stays in the pinned mode's pixel set only.
  //
  // Snapshot baseMask so newly-added pixels don't cascade.
  if (PIX_MODE_KIND && HEX_ID_PX) {
    const baseMask = new Uint8Array(mask);
    const dxs = [+1, -1, +1, -1];
    const dys = [+1, +1, -1, -1];
    const overrides = HEX_MODE_OVERRIDES;
    // CATEGORY-MATCH gate with a stronghold guard on naval↔land
    // crossings. Two stages:
    //   1. The corner pixel must be on the same "side" (LAND vs NAVAL)
    //      as at least one of the diagonal endpoints. LAND-side covers
    //      LAND / ROAD / FORD / ROAD_FERRY; NAVAL is its own side.
    //      This blocks NAVAL corners on a LAND-LAND diagonal (sea
    //      pinch) and LAND-side corners on a NAVAL-NAVAL diagonal
    //      (land pinch).
    //   2. Mixed naval-land cross-hex diagonals (one endpoint NAVAL,
    //      the other LAND-side) are allowed only when one of the two
    //      hexes is a stronghold — that's where dijkstra permits a
    //      disembark transition, and embark/disembark drawings need
    //      the corner bridge. Anywhere else the line would be
    //      "cutting corners" through a shoreline it shouldn't.
    const NAVAL_KIND      = MODE_KIND_NUMS.NAVAL;
    const FORD_KIND       = MODE_KIND_NUMS.FORD;
    const ROAD_FERRY_KIND = MODE_KIND_NUMS.ROAD_FERRY;
    // Three-way side mapping. FORD / ROAD_FERRY are river-internal
    // kinds: they can't bridge a cross-hex LAND-LAND diagonal because
    // crossing a river / ferry mark across a hex border without paying
    // the corresponding surcharge isn't legal. Mirrors checkAndLink.
    const sideOf = (k) => {
      if (k === NAVAL_KIND) return "N";
      if (k === FORD_KIND || k === ROAD_FERRY_KIND) return "R";
      return "L";
    };
    const tryAugment = (localIdx, fullIdx, aKind, bKind, hexA, hexB) => {
      if (baseMask[localIdx]) return;             // already in mask
      const cornerKind = PIX_MODE_KIND[fullIdx];
      if (!cornerKind) return;                    // not globally passable
      const aSide = sideOf(aKind);
      const bSide = sideOf(bKind);
      const cSide = sideOf(cornerKind);
      if (cSide !== aSide && cSide !== bSide) return;
      // Stronghold guard for mixed naval↔land diagonals — disembark at
      // non-strongholds is illegal, and the drawing must respect that.
      if ((aSide === "L" && bSide === "N") || (aSide === "N" && bSide === "L")) {
        const aSth = !!(HEX_STRONGHOLD && HEX_STRONGHOLD.get(hexA));
        const bSth = !!(HEX_STRONGHOLD && HEX_STRONGHOLD.get(hexB));
        if (!aSth && !bSth) return;
      }
      if (overrides && overrides.size > 0) {
        const cHex = HEX_ID_PX[fullIdx];
        if (cHex && overrides.has(cHex)) return;  // pinned hex's strict zone
      }
      mask[localIdx] = 1;
    };
    for (let y = 0; y < mh; y++) {
      const rowBase = y * mw;
      for (let x = 0; x < mw; x++) {
        if (!baseMask[rowBase + x]) continue;
        const fullA = (by0 + y) * W + (bx0 + x);
        const hexA  = HEX_ID_PX[fullA];
        const aKind = PIX_MODE_KIND[fullA];
        for (let k = 0; k < 4; k++) {
          const nx = x + dxs[k], ny = y + dys[k];
          if (nx < 0 || ny < 0 || nx >= mw || ny >= mh) continue;
          if (!baseMask[ny * mw + nx]) continue;
          const fullB = (by0 + ny) * W + (bx0 + nx);
          const hexB  = HEX_ID_PX[fullB];
          if (hexA === hexB) continue;            // intra-hex — no augmentation
          const bKind = PIX_MODE_KIND[fullB];
          const c1 = rowBase + nx;     // local (nx, y)
          const c2 = ny * mw + x;      // local (x,  ny)
          tryAugment(c1, (by0 + y)  * W + (bx0 + nx), aKind, bKind, hexA, hexB);
          tryAugment(c2, (by0 + ny) * W + (bx0 + x), aKind, bKind, hexA, hexB);
        }
      }
    }
  }

  const stash = { mask, mw, mh, bx0, by0 };
  if (debugSink) Object.assign(debugSink, stash);
  else            _lastRouteMask = stash;

  const sPt = startPt || { x: bx0, y: by0 };
  const ePt = endPt   || { x: bx1, y: by1 };

  // ── Ferry-mark waypoint injection ──────────────────────────────────
  // For every ferry hex on the modePath whose picked mode is
  // ROAD_FERRY-containing (single ROAD_FERRY OR a combo with
  // ROAD_FERRY among its kinds), force the line to pass through a
  // ferry-mark pixel of that hex. The combo's mask covers the whole
  // river, but the user wants the actual rendered line to touch the
  // painted road+thick overlay — that's where the crossing happens
  // narratively. Picking the centroid of the ferry-mark pixels as an
  // intermediate waypoint and running A* segment-by-segment achieves
  // that without restricting the mask itself.
  // Each markWaypoint is now tagged with the modePath INDEX of the hex
  // it lives in. Downstream we use those indices to build a per-leg
  // sub-mask — the line A* between two waypoints sees only the hexes
  // BETWEEN them, so the rendered line is confined to the dijkstra
  // path's hexes and can't shortcut across a distant hex.
  const markWaypoints = [];
  const ferryRoadMask = ROAD_ONLY_PIXEL_MASK || ROAD_PIXEL_MASK;
  if (HEX_PIXELS) {
    for (let mi = 0; mi < modePath.length; mi++) {
      const [hex, mode] = modePath[mi];
      const info = HEX_MODES.get(hex)?.get(mode);
      if (!info) continue;
      const hexAllPx = HEX_PIXELS.get(hex);
      if (!hexAllPx) continue;

      // Ferry hex: snap the line to the painted ferry-mark crossing.
      const isFerryMode = info.isFerry
        || (info.kinds && info.kinds.indexOf("ROAD_FERRY") >= 0);
      if (isFerryMode && ferryRoadMask && THICK_RIVER_PIXEL_MASK) {
        let sumX = 0, sumY = 0, count = 0;
        for (let i = 0; i < hexAllPx.length; i++) {
          const p = hexAllPx[i];
          if (ferryRoadMask[p] && THICK_RIVER_PIXEL_MASK[p]) {
            const py = (p / W) | 0;
            sumX += p - py * W; sumY += py; count++;
          }
        }
        if (count > 0) markWaypoints.push({ x: sumX / count, y: sumY / count, hexIdx: mi });
        continue;
      }

      // Stronghold combo (LAND+NAVAL or any NAVAL+non-NAVAL mix) on
      // the modePath: drop an invisible waypoint at the city-pixel
      // centroid so the rendered line actually visits the port the
      // army is disembarking at. "City pixels" are the citiestownsforts
      // (ctf) layer alone — ROAD_PIXEL_MASK minus ROAD_ONLY_PIXEL_MASK
      // — so the line snaps to the city, not the road infrastructure
      // around it.
      const isMixedCombo = info.kinds
        && info.kinds.indexOf("NAVAL") >= 0
        && info.kinds.some(k => k !== "NAVAL");
      const isStronghold = !!(HEX_STRONGHOLD && HEX_STRONGHOLD.get(hex));
      if (isMixedCombo && isStronghold && ROAD_PIXEL_MASK) {
        let sumX = 0, sumY = 0, count = 0;
        for (let i = 0; i < hexAllPx.length; i++) {
          const p = hexAllPx[i];
          const inRoadPlus = !!ROAD_PIXEL_MASK[p];
          const inRoadOnly = !!(ROAD_ONLY_PIXEL_MASK && ROAD_ONLY_PIXEL_MASK[p]);
          if (inRoadPlus && !inRoadOnly) {
            const py = (p / W) | 0;
            sumX += p - py * W; sumY += py; count++;
          }
        }
        if (count > 0) markWaypoints.push({ x: sumX / count, y: sumY / count, hexIdx: mi });
      }
    }
  }

  // ── Ferry-crossing thinning ────────────────────────────────────────
  // Visual fix: when a ferry hex's chosen mode is a ROAD_FERRY combo,
  // the route mask normally contains ALL the road pixels of the hex
  // PLUS every ferry-mark pixel (the painted road-on-thick-river
  // overlay). With a curving road that the artist drew along the
  // riverbank, line A* can "cut" the curve by ducking into the wide
  // ferry-mark strip — visually wrong, since the ferry mark is the
  // bridge, not a free-pass area. The fix is to thin the ferry-mark
  // pixels in the primary mask down to the shortest straight line
  // connecting the two banks' road approaches; the road pixels stay,
  // so the line has to follow the road on each bank, then cross via
  // the minimal strip. If A* can't trace through the thinned mask,
  // we fall back to the full mask.
  function bresenhamPath(ax, ay, bx, by) {
    const out = [];
    let x = ax | 0, y = ay | 0;
    const x1 = bx | 0, y1 = by | 0;
    const dx = Math.abs(x1 - x), dy = Math.abs(y1 - y);
    const sx = x < x1 ? 1 : -1, sy = y < y1 ? 1 : -1;
    let err = dx - dy;
    out.push([x, y]);
    while (x !== x1 || y !== y1) {
      const e2 = err * 2;
      if (e2 > -dy) { err -= dy; x += sx; }
      if (e2 <  dx) { err += dx; y += sy; }
      out.push([x, y]);
      if (out.length > 4096) break;
    }
    return out;
  }
  function buildThinnedMask() {
    if (!PIX_MODE_KIND || !PIX_MODE_COMP || !HEX_PIXELS) return null;
    const ROAD_KIND = MODE_KIND_NUMS.ROAD;
    const ROAD_FERRY_KIND = MODE_KIND_NUMS.ROAD_FERRY;
    let touched = false;
    const thinned = new Uint8Array(mask);
    for (const [hex, mode] of modePath) {
      const info = HEX_MODES.get(hex)?.get(mode);
      if (!info) continue;
      const isFerryMode = info.isFerry
        || (info.kinds && info.kinds.indexOf("ROAD_FERRY") >= 0);
      if (!isFerryMode) continue;
      // Group the chosen mode's pixels by road component (banks) and
      // collect the ferry-mark pixel set. ROAD components in a ferry
      // hex are separated by the thick river (which lives in FERRY
      // bucket, not ROAD), so each bank is its own component.
      const banks = new Map();   // compId -> array of full pixel indices
      const ferryMarkPixels = [];
      for (let i = 0; i < info.pixels.length; i++) {
        const p = info.pixels[i];
        const kind = PIX_MODE_KIND[p];
        if (kind === ROAD_KIND) {
          const comp = PIX_MODE_COMP[p];
          let arr = banks.get(comp);
          if (!arr) { arr = []; banks.set(comp, arr); }
          arr.push(p);
        } else if (kind === ROAD_FERRY_KIND) {
          ferryMarkPixels.push(p);
        }
      }
      if (banks.size < 2 || ferryMarkPixels.length === 0) continue;
      // Find ferry-mark centroid — used to pick each bank's "approach
      // pixel" (closest road pixel of that bank to the centroid).
      // Approximates the closest pair across banks, but O(N) instead
      // of O(N²) pair-wise.
      let cx = 0, cy = 0;
      for (const p of ferryMarkPixels) {
        const py = (p / W) | 0; cx += p - py * W; cy += py;
      }
      cx /= ferryMarkPixels.length; cy /= ferryMarkPixels.length;
      const approach = [];
      for (const arr of banks.values()) {
        let best = -1, bestD2 = Infinity;
        for (const p of arr) {
          const py = (p / W) | 0; const px = p - py * W;
          const dx = px - cx, dy = py - cy;
          const d2 = dx * dx + dy * dy;
          if (d2 < bestD2) { bestD2 = d2; best = p; }
        }
        if (best >= 0) approach.push(best);
      }
      if (approach.length < 2) continue;
      // Closest pair of approach pixels — the two banks to actually
      // connect via the shortest straight line.
      let pa = -1, pb = -1, pdist2 = Infinity;
      for (let i = 0; i < approach.length; i++) {
        for (let j = i + 1; j < approach.length; j++) {
          const ai = approach[i], bj = approach[j];
          const ay = (ai / W) | 0, ax = ai - ay * W;
          const by = (bj / W) | 0, bx = bj - by * W;
          const dx = ax - bx, dy = ay - by;
          const d2 = dx * dx + dy * dy;
          if (d2 < pdist2) { pdist2 = d2; pa = ai; pb = bj; }
        }
      }
      if (pa < 0 || pb < 0) continue;
      const ay = (pa / W) | 0, ax = pa - ay * W;
      const by = (pb / W) | 0, bx = pb - by * W;
      const line = bresenhamPath(ax, ay, bx, by);
      const lineSet = new Set();
      for (const [px, py] of line) lineSet.add(py * W + px);
      // Knock every ferry-mark pixel of this hex's mode out of the
      // thinned mask EXCEPT the ones on the Bresenham strip.
      for (const p of ferryMarkPixels) {
        if (lineSet.has(p)) continue;
        const py = (p / W) | 0; const px = p - py * W;
        const lx = px - bx0, ly = py - by0;
        if (lx >= 0 && lx < mw && ly >= 0 && ly < mh) {
          thinned[ly * mw + lx] = 0;
        }
      }
      // Ensure every strip pixel is in the mask (Bresenham may pass
      // through pixels that weren't ferry-marks — typically rare since
      // we pick endpoints from inside the chosen mode, but be safe).
      for (const [px, py] of line) {
        const lx = px - bx0, ly = py - by0;
        if (lx >= 0 && lx < mw && ly >= 0 && ly < mh) {
          thinned[ly * mw + lx] = 1;
        }
      }
      touched = true;
    }
    return touched ? thinned : null;
  }

  const thinnedMask = buildThinnedMask();

  // Helper: run A* between two points against whichever mask we hand
  // it. Use the thinned mask for the primary pass when one was built.
  const runIn = (m, a, b) => routeInBinaryMask(m, mw, mh, bx0, by0, a, b);

  // Build a leg-scoped sub-mask: keep only mask pixels whose hex sits
  // between modePath[lo] and modePath[hi] (inclusive). The line A*
  // between two waypoints then physically can't see hexes outside
  // that span, so a fake waypoint (ferry-mark, stronghold city) now
  // gets the same "the line stays inside the route's hex path"
  // discipline that user-placed waypoints get for free (each route
  // segment is already its own mask).
  // Pre-compute the set of hexes any nbModeInfo pixels belong to.
  // Only THOSE neighbours are allowed into the leg mask — keeps the
  // leg scope tight while still permitting the narrow road-stub dips.
  const nbAllowedHexes = new Set();
  for (const nbInfo of nbModeInfos) {
    if (!nbInfo.pixels || nbInfo.pixels.length === 0) continue;
    const p0 = nbInfo.pixels[0];
    const hexId = HEX_ID_PX ? HEX_ID_PX[p0] : 0;
    if (hexId) nbAllowedHexes.add(hexId);
  }
  const buildLegMask = (srcMask, lo, hi) => {
    if (!HEX_ID_PX) return srcMask;
    const hexSet = new Set(nbAllowedHexes);
    const a = Math.max(0, Math.min(lo, hi));
    const b = Math.min(modePath.length - 1, Math.max(lo, hi));
    for (let i = a; i <= b; i++) hexSet.add(modePath[i][0]);
    const out = new Uint8Array(srcMask.length);
    for (let y = 0; y < mh; y++) {
      const rowBase = y * mw;
      for (let x = 0; x < mw; x++) {
        const localIdx = rowBase + x;
        if (!srcMask[localIdx]) continue;
        const fullIdx = (by0 + y) * W + (bx0 + x);
        const hex = HEX_ID_PX[fullIdx];
        if (hexSet.has(hex)) out[localIdx] = 1;
      }
    }
    return out;
  };

  // Run a sub-A* over a leg-scoped sub-mask first; if that fails,
  // fall back to the full route mask for that one leg only. Returns
  // the polyline of pixel points, or null if neither works.
  const runLeg = (srcMask, fromPt, toPt, lo, hi) => {
    if (lo === hi || lo == null || hi == null) {
      // No leg span (same hex on both ends, or no modePath context):
      // just use the full source mask directly.
      return runIn(srcMask, fromPt, toPt);
    }
    const legMask = buildLegMask(srcMask, lo, hi);
    const sub = runIn(legMask, fromPt, toPt);
    if (sub && sub.length > 0) return sub;
    return runIn(srcMask, fromPt, toPt);
  };

  // tryFullPath does the multi-segment line over a given mask. Each
  // leg between two waypoints uses a sub-mask scoped to just those
  // waypoints' hex span. Returns the polyline or null on failure.
  const tryFullPath = (m) => {
    if (markWaypoints.length === 0) {
      // No fake waypoints — the whole route is one leg from start to
      // end hex. Scope the mask to the modePath's hex span.
      const lastIdx = modePath.length - 1;
      return runLeg(m, sPt, ePt, 0, lastIdx) || null;
    }
    const out = [];
    let prev = sPt;
    let prevIdx = 0;
    for (const wp of markWaypoints) {
      const sub = runLeg(m, prev, wp, prevIdx, wp.hexIdx);
      if (!sub || sub.length === 0) return null;
      if (out.length === 0) for (const p of sub) out.push(p);
      else                  for (let i = 1; i < sub.length; i++) out.push(sub[i]);
      prev = wp;
      prevIdx = wp.hexIdx;
    }
    const lastIdx = modePath.length - 1;
    const finalSeg = runLeg(m, prev, ePt, prevIdx, lastIdx);
    if (!finalSeg || finalSeg.length === 0) return null;
    if (out.length === 0) for (const p of finalSeg) out.push(p);
    else                  for (let i = 1; i < finalSeg.length; i++) out.push(finalSeg[i]);
    return out;
  };

  // Primary: thinned ferry strip if any, full mask otherwise.
  if (thinnedMask) {
    const primary = tryFullPath(thinnedMask);
    if (primary && primary.length > 0) return primary;
  }
  // Fallback: full mask (entire ferry-mark area, original behavior).
  const fallback = tryFullPath(mask);
  if (fallback && fallback.length > 0) return fallback;
  // Last-ditch single-shot through the full mask.
  return runIn(mask, sPt, ePt) || [];
}

// LEGACY: kept for the same-hex code path and a few callers that still
// pass subSet. New code (cross-hex segments) uses routeLineFromModes.
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
  // Ferry hexes only — pixels of every subhex that's either in ROAD_SUBHEXES
  // or RIVER_SUBHEXES, PLUS every road pixel of the hex regardless of subhex
  // classification ("stray" road pixels in stranded water subhexes or
  // overlaid on thick river). Used by the new ferry road+river-subhex
  // restoration tier — sits between the per-pixel ferry/naval tiers and the
  // fullhex tier. Effect: a ferry hex where road-only fill leaves the route
  // disconnected gets broadened to all painted-as-route subhexes (road and
  // river) before any fullhex restore is attempted, and any isolated road
  // subhex surrounded by water (e.g., the road touching down on a riverbank
  // island) gets pulled into the mask via its road pixels.
  const ferryRoadRiverPxByHex = new Map();
  for (const hid of roadHexList) {
    hexPxByHex.set(hid, []);
    roadPxByHex.set(hid, []);
    thickRivPxByHex.set(hid, []);
    thinRivPxByHex.set(hid, []);
    navalPxByHex.set(hid, []);
    pathSubhexPxByHex.set(hid, []);
    if (FERRY_HEXES && FERRY_HEXES.has(hid)) ferryRoadRiverPxByHex.set(hid, []);
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
    const ferryRRList = isRoadHex ? ferryRoadRiverPxByHex.get(hid) || null : null;
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
        // Ferry hex only: pixel belongs to a road OR river subhex (per the
        // pixel-driven ROAD_SUBHEXES / RIVER_SUBHEXES sets), OR the pixel
        // is itself a road pixel (covers strays in a stranded water subhex
        // that wouldn't otherwise qualify). The road+river-subhex tier
        // restores exactly these to bridge a ferry crossing without going
        // all the way to fullhex.
        if (ferryRRList) {
          const inRoadSub  = !!(ROAD_SUBHEXES  && ROAD_SUBHEXES.has(sidHere));
          const inRiverSub = !!(RIVER_SUBHEXES && RIVER_SUBHEXES.has(sidHere));
          const isRoadPix  = !!(ROAD_PIXEL_MASK && ROAD_PIXEL_MASK[fullIdx]);
          if (inRoadSub || inRiverSub || isRoadPix) ferryRRList.push(idx);
        }
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
      else if (what === "ferryroadriver") {
        // Ferry hexes only — restore pixels of road/river subhexes plus
        // stray road pixels. See ferryRoadRiverPxByHex above for the
        // selection rule.
        if (!(FERRY_HEXES && FERRY_HEXES.has(hid))) continue;
        px = ferryRoadRiverPxByHex.get(hid) || null;
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
  //   5. Ferry path road+river    — per ferry path hex, all pixels of
  //                                 road OR river subhexes, plus stray
  //                                 road pixels in stranded subhexes.
  //                                 Resolves the common "road connects
  //                                 to ferry across a river" case without
  //                                 opening the hex's unrelated land
  //                                 subhexes.
  //   6. Ferry path full-hex      — per ferry path hex, ENTIRE hex's
  //                                 pre-clearing mask (every passable
  //                                 pixel, not just dijkstra-chosen
  //                                 components). Resolves ferry-crossing
  //                                 gaps inside the hex without dragging
  //                                 any neighbors into the mask.
  //   7. Regular path full        — per non-ferry path hex, dijkstra-chosen
  //                                 subhexes only.
  //   8. Path full-hex (any path) — per path hex, entire pre-clearing
  //                                 mask (every passable pixel). Last
  //                                 chance to resolve inside the route
  //                                 before the neighbor revert; ensures
  //                                 path hexes get full-hex inclusion
  //                                 before any neighbor does.
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
    // Ferry path hexes: try road+river subhex broadening FIRST, then
    // FULL-HEX as a fallback. The road+river-subhex pass restores every
    // pixel of road or river subhexes (plus any stray road pixels in
    // stranded water subhexes) — ferries usually connect to roads and
    // the road+river subhexes are usually contiguous, so this resolves
    // the typical ferry crossing without dragging in unrelated land
    // subhexes of the hex. If that still doesn't connect, fall through
    // to fullhex.
    // CUMULATIVE is DISABLED on both passes (third arg false) so we
    // don't open every ferry hex when only one is actually the problem;
    // if revert-on-fail can't find a single ferry hex whose loosening
    // solves connectivity, we fall through to per-hex regular-path
    // escalation instead.
    if (perHexEscalate(ferryPathHexes, "ferryroadriver", false)) { connected = true; break; }
    if (perHexEscalate(ferryPathHexes, "fullhex",        false)) { connected = true; break; }
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
  drawHexModeOverrides();
  drawModePreview();
}

// Paint each pinned (hex, mode) override's actual mode-pixel set on the
// highlight canvas. Same cyan style the hover preview uses, so what you
// "see" when staging an override matches what you "see" when hovering a
// row in the picker. Earlier versions washed the whole overridden hex
// in orange — but that obscured WHICH mode is pinned (orange could mean
// LAND, ROAD#0, ROAD+ROAD_FERRY, …). The mode's pixel union answers
// that question directly.
const _dbgOverrideCanvas = document.createElement("canvas");
const _dbgOverrideCtx = _dbgOverrideCanvas.getContext("2d");
function drawHexModeOverrides() {
  if (!HEX_MODE_OVERRIDES || HEX_MODE_OVERRIDES.size === 0) return;
  if (!HEX_MODES || !HEX_DATA) return;
  const W = HEX_DATA.image_width, H = HEX_DATA.image_height;
  if (_dbgOverrideCanvas.width !== W || _dbgOverrideCanvas.height !== H) {
    _dbgOverrideCanvas.width = W; _dbgOverrideCanvas.height = H;
  } else {
    _dbgOverrideCtx.clearRect(0, 0, W, H);
  }
  const img = _dbgOverrideCtx.createImageData(W, H);
  let drewAny = false;
  for (const [hid, modeName] of HEX_MODE_OVERRIDES) {
    const modes = HEX_MODES.get(hid);
    if (!modes) continue;
    const info = modes.get(modeName);
    if (!info || !info.pixels) continue;
    drewAny = true;
    const pxs = info.pixels;
    for (let i = 0; i < pxs.length; i++) {
      const p = pxs[i];
      if (p < 0 || p >= W * H) continue;
      const o = p * 4;
      img.data[o]     = 60;
      img.data[o + 1] = 230;
      img.data[o + 2] = 255;
      img.data[o + 3] = 200;
    }
  }
  if (!drewAny) return;
  _dbgOverrideCtx.putImageData(img, 0, 0);
  hlCtx.drawImage(_dbgOverrideCanvas, 0, 0);
}

// ── Mode preview overlay ────────────────────────────────────────────
// While the mode picker is open, hovering a row paints that mode's
// pixel set on the highlight canvas in a high-contrast cyan, so the
// user can "see what each node version looks like" before pinning.
// MODE_PREVIEW = { hexId, modeName } | null.
let MODE_PREVIEW = null;
const _dbgPreviewCanvas = document.createElement("canvas");
const _dbgPreviewCtx = _dbgPreviewCanvas.getContext("2d");
function setModePreview(p) {
  MODE_PREVIEW = p;
  renderSelection();
}
function drawModePreview() {
  if (!MODE_PREVIEW || !HEX_MODES || !HEX_DATA) return;
  const modes = HEX_MODES.get(MODE_PREVIEW.hexId);
  if (!modes) return;
  const info = modes.get(MODE_PREVIEW.modeName);
  if (!info || !info.pixels) return;
  const W = HEX_DATA.image_width, H = HEX_DATA.image_height;
  if (_dbgPreviewCanvas.width !== W || _dbgPreviewCanvas.height !== H) {
    _dbgPreviewCanvas.width = W; _dbgPreviewCanvas.height = H;
  } else {
    _dbgPreviewCtx.clearRect(0, 0, W, H);
  }
  const img = _dbgPreviewCtx.createImageData(W, H);
  for (let i = 0; i < info.pixels.length; i++) {
    const p = info.pixels[i];
    if (p < 0 || p >= W * H) continue;
    const o = p * 4;
    img.data[o]     = 60;
    img.data[o + 1] = 230;
    img.data[o + 2] = 255;
    img.data[o + 3] = 200;
  }
  _dbgPreviewCtx.putImageData(img, 0, 0);
  hlCtx.drawImage(_dbgPreviewCanvas, 0, 0);
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
// Returns true if the given event's target is inside the mode-picker popup
// (or any other interactive overlay that should swallow stage clicks). Used
// by the mousedown / mouseup handlers below to skip pan + click-to-waypoint
// when the user is interacting with the popup — without this, picking a
// mode in the right-click menu also drops a new waypoint at the click pos.
function eventInsidePicker(e) {
  const mp = document.getElementById("mode-picker");
  if (!mp || mp.classList.contains("hidden")) return false;
  return mp.contains(e.target);
}
stage.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  if (eventInsidePicker(e)) return;
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

// Right-click → mode picker for the hex under the cursor. Lets the user
// pin a specific (hex, mode) so dijkstra is restricted to that mode for
// that hex on the next route recompute. Suppresses the browser context
// menu inside the stage so the picker can take its place.
const modePickerEl = document.getElementById("mode-picker");
function hideModePicker() {
  if (modePickerEl) modePickerEl.classList.add("hidden");
  if (MODE_PREVIEW) {
    MODE_PREVIEW = null;
    renderSelection();
  }
}
function showModePicker(clientX, clientY, hexId) {
  if (!modePickerEl || !HEX_MODES) return;
  const modes = HEX_MODES.get(hexId);
  if (!modes || modes.size === 0) {
    modePickerEl.classList.add("hidden");
    return;
  }
  // Find which mode dijkstra picked for this hex on the active route (so we
  // can mark it). Same logic as the tooltip's pickedModes computation.
  const activeRoute = (typeof getActiveRoute === "function") ? getActiveRoute() : null;
  const debugRoute = activeRoute || (ROUTES.length > 0 ? ROUTES[0] : null);
  const pickedSet = new Set();
  if (debugRoute) {
    for (const seg of debugRoute.segments) {
      if (!seg.modePath) continue;
      for (const [mhex, mmode] of seg.modePath) {
        if (mhex === hexId) pickedSet.add(mmode);
      }
    }
  }
  const currentOverride = HEX_MODE_OVERRIDES.get(hexId) || null;
  // Sort modes by cost (cheapest first), ties broken by name.
  const entries = Array.from(modes.entries())
    .sort((a, b) => (a[1].cost - b[1].cost) || a[0].localeCompare(b[0]));
  const parts = [];
  parts.push(`<div class="mp-header">Hex ${hexId} — pin mode (overrides dijkstra)</div>`);
  // For each mode, compute its cross-hex neighbor MODES, grouped by hex.
  // Showing the actual neighbor modes (not just hex ids) lets you see
  // exactly which (hex, mode) nodes the picked one claims to connect to
  // — phantom edges are then directly readable from this listing.
  const modeNeighborGroups = new Map();   // mode name → "1379(LAND#0, ROAD#1); 1468(ROAD#0)"
  for (const [name] of entries) {
    const key = `${hexId}:${name}`;
    const nbs = HEX_MODE_NEIGHBORS && HEX_MODE_NEIGHBORS.get(key);
    const byHex = new Map();
    if (nbs) {
      for (const nb of nbs) {
        const colonAt = nb.indexOf(":");
        const nh = +nb.slice(0, colonAt);
        if (nh === hexId) continue;       // skip intra-hex
        const m = nb.slice(colonAt + 1);
        let arr = byHex.get(nh);
        if (!arr) { arr = []; byHex.set(nh, arr); }
        arr.push(m);
      }
    }
    let str = "—";
    if (byHex.size > 0) {
      const groups = Array.from(byHex.entries()).sort((a, b) => a[0] - b[0]);
      str = groups.map(([nh, modes]) =>
        `${nh}(${modes.sort().join(", ")})`).join("; ");
    }
    modeNeighborGroups.set(name, str);
  }
  for (const [name, info] of entries) {
    const tags = [];
    if (pickedSet.has(name)) tags.push(`<span class="mp-tag">picked</span>`);
    if (currentOverride === name) tags.push(`<span class="mp-tag">pinned</span>`);
    const klass = "mp-item"
      + (currentOverride === name ? " override" : "")
      + (pickedSet.has(name) && currentOverride !== name ? " picked" : "");
    const nbStr = modeNeighborGroups.get(name) || "—";
    const nbHtml = `<div class="mp-neighbors">→ ${escapeTooltipHtml(nbStr)}</div>`;
    parts.push(
      `<div class="${klass}" data-mode="${escapeTooltipHtml(name)}">`
      + `<div class="mp-row-main">`
      + `<span>${escapeTooltipHtml(name)}${tags.join("")}</span>`
      + `<span class="mp-cost">${(+info.cost).toFixed(2)} · ${info.pixels.length}px</span>`
      + `</div>`
      + nbHtml
      + `</div>`);
  }
  parts.push(`<div class="mp-sep"></div>`);
  if (currentOverride) {
    parts.push(`<div class="mp-action" data-action="clear">Clear pin on hex ${hexId}</div>`);
  }
  if (HEX_MODE_OVERRIDES.size > 0) {
    parts.push(`<div class="mp-action mp-apply" data-action="apply">Apply pinned overrides (${HEX_MODE_OVERRIDES.size}) — recompute routes</div>`);
    parts.push(`<div class="mp-action" data-action="clear-all">Clear ALL pins (${HEX_MODE_OVERRIDES.size})</div>`);
  }
  parts.push(`<div class="mp-action" data-action="cancel">Cancel</div>`);
  modePickerEl.innerHTML = parts.join("");

  // Click handlers — delegated to the popup container. Pinning a mode is
  // STAGED only (no route rebuild) — the user explicitly wants the
  // dijkstra path to stay frozen while they stage overrides. The
  // "Apply" action above triggers the rebuild on demand.
  modePickerEl.onclick = (ev) => {
    const item = ev.target.closest(".mp-item");
    if (item) {
      const mode = item.getAttribute("data-mode");
      if (mode) setHexModeOverride(hexId, mode);
      setModePreview(null);
      hideModePicker();
      renderSelection(); updateEndpoints(); updateStatus();
      return;
    }
    const action = ev.target.closest(".mp-action");
    if (action) {
      const a = action.getAttribute("data-action");
      if (a === "clear")     clearHexModeOverride(hexId);
      else if (a === "clear-all") clearAllHexModeOverrides();
      else if (a === "apply")     applyHexModeOverrides();
      setModePreview(null);
      hideModePicker();
      renderSelection(); updateEndpoints(); updatePathInfo(); updateStatus();
      return;
    }
  };

  // Hover a mode row → preview its pixel set on the highlight canvas.
  // Lets the user "see what each node version looks like" before pinning.
  // mouseover/mouseout (not mouseenter/mouseleave) so it works with the
  // event delegation pattern; check the closest .mp-item to filter.
  modePickerEl.onmouseover = (ev) => {
    const item = ev.target.closest(".mp-item");
    if (!item) return;
    const mode = item.getAttribute("data-mode");
    if (mode) {
      setModePreview({ hexId, modeName: mode });
    }
  };
  modePickerEl.onmouseout = (ev) => {
    const item = ev.target.closest(".mp-item");
    if (!item) return;
    // mouseout fires on every child element too; only clear if we're
    // actually leaving the item entirely.
    const related = ev.relatedTarget;
    if (related && item.contains(related)) return;
    setModePreview(null);
  };

  // Position the popup near the cursor but keep it on-screen.
  const stageRect = stage.getBoundingClientRect();
  modePickerEl.classList.remove("hidden");
  // Measure after un-hiding so offsetWidth/Height are valid.
  const pw = modePickerEl.offsetWidth || 280;
  const ph = modePickerEl.offsetHeight || 200;
  let lx = (clientX - stageRect.left) + 8;
  let ly = (clientY - stageRect.top) + 8;
  if (lx + pw > stageRect.width)  lx = Math.max(0, stageRect.width  - pw - 4);
  if (ly + ph > stageRect.height) ly = Math.max(0, stageRect.height - ph - 4);
  modePickerEl.style.left = lx + "px";
  modePickerEl.style.top  = ly + "px";
}
stage.addEventListener("contextmenu", (e) => {
  // Mode picker is a debug tool — it explains which hex-mode dijkstra
  // would pick and lets you pin overrides. Only useful when a [debug]
  // overlay is showing the raw graph state. When no debug overlay is
  // active, swallow the event silently so right-click doesn't pop the
  // picker in normal use; the picker would otherwise distract from
  // ordinary route-planning.
  const anyDebugOn = DEBUG_SHOW_MASK || DEBUG_SHOW_RIVER_TYPES
                  || DEBUG_SHOW_FERRY_HEXES || DEBUG_SHOW_SUBHEX_TYPES;
  if (!anyDebugOn) {
    e.preventDefault();
    hideModePicker();
    return;
  }
  e.preventDefault();
  const ipt = stageToImage(e.clientX, e.clientY);
  if (!ipt) { hideModePicker(); return; }
  const hx = pointToHex(ipt.x, ipt.y);
  if (!hx) { hideModePicker(); return; }
  showModePicker(e.clientX, e.clientY, hx.id);
});
// Clicks outside the popup dismiss it. Inside-clicks are handled by the
// delegated onclick above (which also hides the popup explicitly).
window.addEventListener("mousedown", (e) => {
  if (!modePickerEl || modePickerEl.classList.contains("hidden")) return;
  if (modePickerEl.contains(e.target)) return;
  hideModePicker();
});
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && modePickerEl && !modePickerEl.classList.contains("hidden")) {
    hideModePicker();
  }
});

function escapeTooltipHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Explain why a given pixel ended up in or out of the route mask (only
// meaningful when DEBUG_SHOW_MASK is on and a route is active). Returns a
// multi-line description, or null if there's no useful info. Enumerates
// the classification reasons under the current combo-mode schema:
//   * Hex membership (on the route's hex path, adjacent to one, or off).
//   * Mode-graph pick — which (hex, mode) dijkstra chose for this hex.
//     Modes can be single-kind (LAND / ROAD / ROAD_FERRY / NAVAL) or
//     combos (LAND+ROAD_FERRY, ROAD+ROAD_FERRY, …) with bundled costs
//     (e.g., ROAD+ROAD_FERRY = road weight + ferry surcharge).
//   * Which modes this pixel actually belongs to, and whether any of
//     them is in the picked-modes set for this hex. The pixel is in the
//     line mask iff at least one of its owning modes was picked.
//   * Thick-river status — only in the mask when dijkstra picked a
//     combo containing ROAD_FERRY (or the single ROAD_FERRY mode) here.
//   * Ferry-mark pixels (ROAD ∩ THICK overlay) — same rule.
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
  // (Heavier-than-assigned land subhexes are no longer excluded; the LAND
  // mode includes their pixels and the parent hex's terrain drives cost.)

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
  // What mode (single or combo) did dijkstra pick for this hex on the
  // active route? Lets the tooltip distinguish "you're hovering a LAND
  // pixel and dijkstra picked LAND" from "you're hovering a LAND pixel
  // but dijkstra picked ROAD+ROAD_FERRY combo, so this pixel isn't in
  // the line mask".
  const pickedModes = [];
  for (const seg of debugSegments) {
    if (!seg.modePath) continue;
    for (const [mhex, mmode] of seg.modePath) {
      if (mhex === hid) pickedModes.push(mmode);
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

  // ── DIJKSTRA / MODE-GRAPH ── did the router use this subhex / road in this hex?
  if (sub) {
    if (inDijkstraPath) lines.push("Dijkstra picked this subhex on a chosen path");
    if (pickedModes.length > 0) {
      // Show every mode dijkstra picked for this hex (usually one — but
      // intra-hex transitions can pick up multiple, e.g., entry mode +
      // transition into a combo).
      lines.push(`Mode-graph pick for this hex: ${pickedModes.join(", ")}`);
    }
    // Show any debug override pinned on this hex (independent of whether
    // it's on the active route).
    const override = HEX_MODE_OVERRIDES.get(hid);
    if (override) {
      lines.push(`⚑ Mode override pinned: ${override} (right-click to clear / change)`);
    }
    if (routedViaRoadHere) lines.push("→ Mode-graph picked a ROAD or ROAD_FERRY (or combo containing one) for this hex");
    else if (onPath && isRoadSubhex) {
      // Under the combo-mode schema, the rendered line mask is exactly
      // the union of the dijkstra-chosen (hex, mode)'s pixel sets, no
      // post-hoc broadening. If dijkstra picked a non-road combo here,
      // the road pixels aren't in the line mask — even though the
      // subhex contains road pixels — because cost-wise that wasn't the
      // chosen traversal.
      lines.push("Hex has road pixels but dijkstra didn't pick any ROAD-containing mode/combo here — the road pixels are NOT in the line mask for this route");
    }
  }

  // ── WEIGHTS ──
  if (sub) {
    const subWStr = isFinite(subW) ? subW : "?";
    const effWStr = isFinite(effW) ? effW : "?";
    const hexWStr = isFinite(hexW) ? hexW : "?";
    lines.push(`Weights: subhex canonical (${subCanon})=${subWStr} · effective=${effWStr} · hex assigned=${hexWStr}`);
    if (!isNavalClass && !isRoadComp && isFinite(subW) && isFinite(hexW) && subW > hexW) {
      lines.push("→ Subhex class is heavier than the hex's assigned terrain — still traversable; cost billed at the hex's assigned weight, not the subhex's class weight.");
    }
  }

  // ── FERRY / RIVER / ROAD FLAGS ──
  // Pixel-level facts. With combo modes, whether a pixel ends up in the
  // line mask is entirely determined by which (hex, mode) dijkstra picked
  // — combos like LAND+ROAD_FERRY or ROAD+ROAD_FERRY are explicit graph
  // nodes whose pixel sets are exactly the painted road / river / land
  // pixels you'd expect.
  const isPaintedRiver = !!(RIVER_PIXEL_MASK && RIVER_PIXEL_MASK[idx]);
  const isFerryMark    = isRoad && isThick;   // road overlaid on thick river
  if (isThick) {
    lines.push("Thick river: pixel is in THICK_RIVER_PIXEL_MASK"
      + (isThickBlock ? " (incl. blocking halo)" : "")
      + " → in the mask ONLY if dijkstra picked a ROAD_FERRY-containing single mode or combo for this hex");
  }
  if (isThin) lines.push("Thin river: fordable (green-overlay) — passable to the line");
  if (isFerryHex) {
    // The hex is a ferry. Dijkstra has explicit combos for it
    // (ROAD+ROAD_FERRY, LAND+ROAD_FERRY, etc.) with bundled costs —
    // road+ferry, land+ferry — and picks the cheapest one whose pixel
    // union actually connects the route's neighbors.
    lines.push("Hex is a FERRY hex (road+thick overlay artwork) → combo modes available in dijkstra: ROAD+ROAD_FERRY (road on banks + crossing, road+ferry cost), LAND+ROAD_FERRY (land approach + crossing, land+ferry cost), …");
  }
  if (isFerryMark) {
    lines.push("Ferry-mark pixel: ROAD ∩ THICK_RIVER overlay — DEFINES this hex as a ferry; in the line mask iff dijkstra picked a combo containing ROAD_FERRY");
  }
  if (isRoadComp) {
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
  // Per-pixel verdict — which mode(s) own this pixel, and is any of them
  // a mode dijkstra picked? Under the combo schema, a pixel can belong
  // to multiple modes at once (e.g., a road pixel belongs to ROAD#0, to
  // LAND#0 if road pixels are also in landSet, and to every combo that
  // includes ROAD or LAND). The pixel is in the line mask iff ANY of the
  // modes it belongs to is in pickedModes for this hex.
  if (isFerryHex && pickedModes.length > 0) {
    const pickedSet = new Set(pickedModes);
    const owningModes = [];
    if (HEX_MODES && HEX_MODES.get(hid)) {
      for (const [mname, minfo] of HEX_MODES.get(hid)) {
        // Cheap membership test: does this mode's pixel array contain idx?
        // For typical mode sizes (hundreds to thousands of pixels) this is
        // an O(n) scan per mode, but the tooltip only runs on hover so a
        // few thousand operations per mouseover is fine.
        const pxs = minfo.pixels;
        for (let i = 0; i < pxs.length; i++) {
          if (pxs[i] === idx) { owningModes.push(mname); break; }
        }
      }
    }
    if (owningModes.length > 0) {
      const owningPicked = owningModes.filter(m => pickedSet.has(m));
      if (owningPicked.length > 0) {
        lines.push(`Pixel belongs to: ${owningModes.join(", ")} — picked: ${owningPicked.join(", ")}`);
      } else {
        lines.push(`Pixel belongs to: ${owningModes.join(", ")} — NONE picked by dijkstra (so not in the line mask)`);
      }
    } else {
      lines.push("Pixel belongs to NO mode of this hex (water barrier / dropped)");
    }
  }

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
  buildArmyControls();
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
