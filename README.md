# Ravages Map Calculator

A browser-based map utility for the **Ravages** hex map. Pick two points on the
map and the calculator works out the shortest route between them, honoring the
terrain costs defined in the campaign's shared spreadsheet.

## Using it

1. **Hover** anywhere on the map — the tooltip shows the hex ID, its main
   terrain, its current traversal weight, and the specific subhex under the
   cursor.
2. **Click** a subhex to set the route's **From** point. Click again to set
   **To**. The optimal road is drawn between the two as a single line that
   stays inside the terrain it claims to be crossing.
3. Click again to start a new route. Use **Swap** to flip From and To, or
   **Clear** (or press *Esc*) to reset.

### Layers
The sidebar's **Layers** section toggles each map overlay independently and
controls its opacity. The base art, the sea fill, the terrain elevation
shading, the rivers and roads, plus two hex-grid styles are all switchable.

### Settings
Hidden behind a *Show settings* button to keep the everyday view tidy:

- **Traversal weights** — numeric cost of *entering* a hex of each terrain.
  Lower = easier. The path recomputes the instant you change one.
- **Colors** — RGB + opacity sliders for the From / To / path-fill / path-line
  / hex-outline highlights.
- **Path line** — line width, vertex point size, anti-aliasing toggle, and an
  optional outline drawn around the hexes the path touches (perimeter only,
  no internal seams). The outline has its own width and AA toggle.

## How the routing works

Pathfinding runs on the hex graph using Dijkstra. Each hex has one **main
terrain** (from the spreadsheet) and one weight (from the *Traversal weights*
panel). The starting hex is free; every subsequent hex you enter contributes
its weight to the total cost.

The drawn road is a separate problem: A* on the union of the path hexes'
subhex pixel masks, smoothed with line-of-sight string-pulling so each
segment is a straight line that can't visually exit the terrain it's on. By
default the mask includes only subhexes whose own class weight is *≤* their
hex's main-terrain weight, so the line prefers cheap terrain when possible; if
that filter would leave the road unreachable, it falls back to the hex's full
pixel area so the route still renders.

## Data source

Hex terrain comes from a public Google Sheet, fetched fresh on every page
load via the no-cache gviz CSV endpoint. Editing the sheet immediately
affects the next page reload — no rebuild needed.

Sheet:
<https://docs.google.com/spreadsheets/d/1jC2kO_Hidhg4WoL-jBGw1lKKD5s6a1-xoqv1omTZR_k>

Required columns:

| Column   | Meaning                                                      |
| -------- | ------------------------------------------------------------ |
| Hexcode  | Numeric hex id, matching the labeled grid on the base map.   |
| Terrain  | One of: Flatlands, Woodland, Hills, Mountains, Lake, Sea, Ocean. Anything not in the weights table is treated as impassable. |

Extra columns (e.g. Stronghold, River, Road) are ignored.
