"use strict";

// Min-heap on [priority, ...payload] tuples (sorted by priority ascending).
class MinHeap {
  constructor() { this.h = []; }
  size() { return this.h.length; }
  push(item) { this.h.push(item); this._up(this.h.length - 1); }
  pop() {
    const top = this.h[0], last = this.h.pop();
    if (this.h.length > 0) { this.h[0] = last; this._down(0); }
    return top;
  }
  _up(i) {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.h[p][0] <= this.h[i][0]) break;
      [this.h[p], this.h[i]] = [this.h[i], this.h[p]];
      i = p;
    }
  }
  _down(i) {
    const n = this.h.length;
    while (true) {
      const l = 2 * i + 1, r = 2 * i + 2;
      let m = i;
      if (l < n && this.h[l][0] < this.h[m][0]) m = l;
      if (r < n && this.h[r][0] < this.h[m][0]) m = r;
      if (m === i) break;
      [this.h[m], this.h[i]] = [this.h[i], this.h[m]];
      i = m;
    }
  }
}

// Dijkstra under the per-hex max-weight TRAVERSAL cost model.
//
// Cost is paid per hex TRANSITION (crossing into a new hex), not per hex
// visited. The starting hex is free (you're already in it). Each subsequent
// hex you enter contributes max(weights of subhexes traversed in that hex)
// to the total. Movements between subhexes WITHIN a hex are 0 cost in
// themselves, but they raise the running max if you cross into a heavier
// subhex inside that hex.
//
// State = (subhex_id, max_class_in_current_hex, is_start_hex).
// Encoded as "sid|className|S" where S = "1" if still inside the start hex.
// Distance d at a popped state = cost of all completed hex transitions; the
// CURRENT hex's contribution is added when you leave it (or at termination,
// for the destination hex). When you leave the start hex, you pay 0 instead
// of its running max.
function findPath(fromId, toId, subhexIndex, neighbors, weights) {
  if (fromId == null || toId == null) return null;
  if (fromId === toId) return { ids: [fromId], cost: 0, hexes: 1 };
  const srcSub = subhexIndex.get(fromId);
  if (!srcSub) return null;

  const dist = new Map();
  const prev = new Map();
  const heap = new MinHeap();

  const startKey = fromId + "|" + srcSub.class + "|1";
  dist.set(startKey, 0);
  heap.push([0, fromId, srcSub.class, true]);

  let bestTotal = Infinity, bestKey = null;

  while (heap.size() > 0) {
    const [d, u, maxClass, isStart] = heap.pop();
    if (d >= bestTotal) break;
    const k = u + "|" + maxClass + "|" + (isStart ? "1" : "0");
    if (d > (dist.get(k) ?? Infinity)) continue;

    if (u === toId) {
      // Close out current hex: 0 if we never left the starting hex, else max.
      const close = isStart ? 0 : (+weights[maxClass]);
      const total = d + close;
      if (total < bestTotal) { bestTotal = total; bestKey = k; }
      continue;
    }

    const uSub = subhexIndex.get(u);
    const adj = neighbors.get(u);
    if (!adj) continue;

    for (const v of adj) {
      const vSub = subhexIndex.get(v);
      if (!vSub) continue;
      const vW = +weights[vSub.class];
      if (!isFinite(vW) || vW <= 0) continue;

      let nd, nMax, nIsStart;
      if (vSub.hex === uSub.hex) {
        // Same hex: free move; just update the running max.
        nd = d;
        nMax = ((+weights[maxClass]) >= vW) ? maxClass : vSub.class;
        nIsStart = isStart;
      } else {
        // Crossing into a new hex.
        const close = isStart ? 0 : (+weights[maxClass]);
        nd = d + close;
        nMax = vSub.class;
        nIsStart = false;
      }
      const nk = v + "|" + nMax + "|" + (nIsStart ? "1" : "0");
      if (nd < (dist.get(nk) ?? Infinity)) {
        dist.set(nk, nd);
        prev.set(nk, k);
        heap.push([nd, v, nMax, nIsStart]);
      }
    }
  }

  if (bestKey == null) return null;

  const keys = [];
  let cur = bestKey;
  while (cur != null) {
    keys.push(cur);
    if (cur === startKey) break;
    cur = prev.get(cur);
  }
  keys.reverse();
  const ids = keys.map(k => +k.split("|")[0]);

  let hexes = 1;
  for (let i = 1; i < ids.length; i++) {
    if (subhexIndex.get(ids[i]).hex !== subhexIndex.get(ids[i - 1]).hex) hexes++;
  }
  return { ids, cost: bestTotal, hexes };
}

// Per-hex max-weight breakdown for an existing path (must match findPath cost).
// Starting hex contributes 0; every subsequent hex contributes its max.
function pathBreakdown(pathIds, subhexIndex, weights) {
  if (!pathIds || pathIds.length === 0) {
    return { hexes: 0, subhexes: 0, cost: 0, byClass: {} };
  }
  const byClass = {};
  let cost = 0, hexes = 0;
  let i = 0;
  let isFirstHex = true;
  while (i < pathIds.length) {
    const hexId = subhexIndex.get(pathIds[i]).hex;
    let maxW = 0;
    while (i < pathIds.length && subhexIndex.get(pathIds[i]).hex === hexId) {
      const s = subhexIndex.get(pathIds[i]);
      byClass[s.class] = (byClass[s.class] || 0) + 1;
      const w = +weights[s.class];
      if (w > maxW) maxW = w;
      i++;
    }
    if (!isFirstHex) cost += maxW;
    isFirstHex = false;
    hexes++;
  }
  return { hexes, subhexes: pathIds.length, cost, byClass };
}

// ---------------------------------------------------------------------------
// Pixel-grid helpers used to constrain the rendered road to subhex masks.
// ---------------------------------------------------------------------------

// 8-connectivity A* within a binary mask. Returns array of [x, y] in LOCAL
// (mask-relative) coords, or null if unreachable.
function aStarInMask(mask, w, h, sx, sy, tx, ty) {
  if (sx < 0 || sx >= w || sy < 0 || sy >= h) return null;
  if (tx < 0 || tx >= w || ty < 0 || ty >= h) return null;
  if (!mask[sy * w + sx] || !mask[ty * w + tx]) return null;
  const SQRT2 = Math.SQRT2;
  const N = w * h;
  const gScore = new Float64Array(N); gScore.fill(Infinity);
  const cameFrom = new Int32Array(N); cameFrom.fill(-1);
  const closed = new Uint8Array(N);
  const start = sy * w + sx, goal = ty * w + tx;
  gScore[start] = 0;
  const heap = new MinHeap();
  heap.push([heuristic8(sx, sy, tx, ty), start, sx, sy]);
  while (heap.size() > 0) {
    const [, k, x, y] = heap.pop();
    if (closed[k]) continue;
    closed[k] = 1;
    if (k === goal) {
      const out = [];
      let c = k;
      while (c !== -1) { out.push([c % w, (c / w) | 0]); c = cameFrom[c]; }
      out.reverse();
      return out;
    }
    const g = gScore[k];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        if (!mask[ny * w + nx]) continue;
        // Disallow diagonal "corner cutting" through non-mask cells.
        if (dx !== 0 && dy !== 0) {
          if (!mask[y * w + nx] || !mask[ny * w + x]) continue;
        }
        const cost = (dx !== 0 && dy !== 0) ? SQRT2 : 1;
        const nk = ny * w + nx;
        const ng = g + cost;
        if (ng < gScore[nk]) {
          gScore[nk] = ng;
          cameFrom[nk] = k;
          heap.push([ng + heuristic8(nx, ny, tx, ty), nk, nx, ny]);
        }
      }
    }
  }
  return null;
}
function heuristic8(x0, y0, x1, y1) {
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  return (Math.max(dx, dy) - Math.min(dx, dy)) + Math.SQRT2 * Math.min(dx, dy);
}

// Snap (x, y) to the nearest pixel where mask=1. Spiral BFS in growing rings.
function snapToMask(mask, w, h, x, y) {
  if (x >= 0 && x < w && y >= 0 && y < h && mask[y * w + x]) return [x, y];
  const maxR = Math.max(w, h);
  for (let r = 1; r <= maxR; r++) {
    for (let dy = -r; dy <= r; dy++) {
      const aDy = Math.abs(dy);
      for (let dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) !== r && aDy !== r) continue;
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && nx < w && ny >= 0 && ny < h && mask[ny * w + nx]) return [nx, ny];
      }
    }
  }
  return null;
}

// Douglas-Peucker polyline simplification (iterative to avoid stack blowups).
function simplifyPolyline(pts, epsilon) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = 1; keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length > 0) {
    const [a, b] = stack.pop();
    let maxD = 0, maxI = -1;
    for (let i = a + 1; i < b; i++) {
      const d = perpDist(pts[i], pts[a], pts[b]);
      if (d > maxD) { maxD = d; maxI = i; }
    }
    if (maxD > epsilon && maxI !== -1) {
      keep[maxI] = 1;
      stack.push([a, maxI]);
      stack.push([maxI, b]);
    }
  }
  const out = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
  return out;
}
function perpDist(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = a.x + t * dx, cy = a.y + t * dy;
  return Math.hypot(p.x - cx, p.y - cy);
}

// Bresenham line-of-sight test: returns true iff every pixel on the line from
// (x0,y0) to (x1,y1) is mask=1 (inside the passable region).
function lineOfSight(mask, w, h, x0, y0, x1, y1) {
  let dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
  let dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  while (true) {
    if (x0 < 0 || x0 >= w || y0 < 0 || y0 >= h) return false;
    if (!mask[y0 * w + x0]) return false;
    if (x0 === x1 && y0 === y1) return true;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

// "String pull" / any-angle smoothing of an A* pixel path. For each anchor i,
// find the farthest j such that the straight line from pixPath[i] to pixPath[j]
// stays entirely inside the mask. Keep only those anchors. The result is a
// minimal-vertex polyline where every segment is provably inside the mask.
function stringPull(pixPath, mask, w, h) {
  if (pixPath.length < 3) return pixPath.slice();
  const out = [pixPath[0]];
  let i = 0;
  while (i < pixPath.length - 1) {
    let j = pixPath.length - 1;
    while (j > i + 1) {
      if (lineOfSight(mask, w, h, pixPath[i][0], pixPath[i][1],
                                  pixPath[j][0], pixPath[j][1])) break;
      j--;
    }
    out.push(pixPath[j]);
    i = j;
  }
  return out;
}
