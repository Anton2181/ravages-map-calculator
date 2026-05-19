# Ravages Map Calculator

Browser-based map utility for the Ravages hex map: layer toggles, click two
subhexes to compute and visualize the optimal route between them.

## Hosting on GitHub Pages

1. Create a new public GitHub repository, e.g. `ravages-map-calculator`.
2. Commit the entire contents of this folder to the repo's default branch.
3. In the repo on GitHub: **Settings → Pages → Build and deployment**, set
   *Source* to `Deploy from a branch` and *Branch* to your default branch
   (`main`) with folder `/ (root)`. Save.
4. After a minute or two the site is live at
   `https://<your-username>.github.io/<repo-name>/`.

The terrain spreadsheet is fetched fresh on every page load via the public
gviz CSV endpoint, so edits to the linked Google Sheet show up immediately
without rebuilding/redeploying the site.

## File layout

Static site (the only files GitHub Pages serves):

| File                          | Role                                                   |
| ----------------------------- | ------------------------------------------------------ |
| `index.html`                  | Markup; loads CSS + JS + map assets.                   |
| `style.css`                   | Sidebar, tooltips, swatches.                           |
| `app.js`                      | Layer rendering, hover/click, hex pathfinding driver.  |
| `ui.js`                       | Sidebar widgets (layers, weights, colors, line style). |
| `pathfinding.js`              | MinHeap, hex/subhex helpers, A* + string-pull.         |
| `hex_data.json`               | Hex grid geometry.                                     |
| `subhex_data.json`            | Per-subhex metadata.                                   |
| `neighbors.json`              | Subhex adjacency graph.                                |
| `subhex_id_map.png`           | Per-pixel subhex id lookup (RGB-encoded).              |
| `Ravages_ver_6.3_hex.png` ... | Map image layers.                                      |

Build artifact (do not need to commit, but harmless):

- `process_map.py` — the script that regenerates `hex_data.json`,
  `subhex_data.json`, `neighbors.json`, and `subhex_id_map.png` from the
  source PNGs. Re-run only when the source map images change.

## Data source

Hex main-terrain table:
https://docs.google.com/spreadsheets/d/1jC2kO_Hidhg4WoL-jBGw1lKKD5s6a1-xoqv1omTZR_k

The site fetches `…/gviz/tq?tqx=out:csv&gid=0` (no cache) at load. Anyone
with edit access to the sheet can change a hex's terrain and the routing
will pick it up on the next reload.
