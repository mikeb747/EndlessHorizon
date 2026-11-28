/**
 * Pure TypeScript single-line drawing tracer for GPS Art routes.
 *
 * Converts any black-on-white (or dark-on-light) line drawing RGBA buffer into
 * a continuous, ordered, aspect-ratio-preserving normalized 2D polyline using:
 * 1. Luminance/alpha ink thresholding
 * 2. Zhang-Suen morphological thinning (1-pixel skeleton) + staircase cleanup
 * 3. Junction supernode clustering & degree-2 chain graph extraction
 * 4. Momentum-guided Hierholzer Eulerian traversal (continues straight through
 *    self-intersections and splices internal loops like bicycle wheel hubs)
 * 5. Ramer-Douglas-Peucker simplification + North-up coordinate normalization
 *
 * Zero DOM dependency in core functions so it runs identically in browser Canvas
 * uploads and Node.js automated tests.
 */

export interface NormalizedPoint {
  /** Horizontal East coordinate in [0..aspectRatio] */
  x: number;
  /** Vertical North coordinate in [0..1] (flipped from image Y so GPS plots right-side-up) */
  y: number;
}

export interface LineTraceResult {
  points: NormalizedPoint[];
  aspectRatio: number;
  closedLoop: boolean;
  edgeCoverage: number;
}

interface RawPoint {
  x: number;
  y: number;
}

interface SkeletonNode {
  id: number;
  x: number;
  y: number;
  pixels: number[];
  edges: number[];
}

interface SkeletonEdge {
  id: number;
  a: number;
  b: number;
  pts: RawPoint[];
  tanA: [number, number];
  tanB: [number, number];
  used: boolean;
}

const DX8 = [0, 1, 1, 1, 0, -1, -1, -1];
const DY8 = [-1, -1, 0, 1, 1, 1, 0, -1];

function zhangSuenThinning(mask: Uint8Array, w: number, h: number): void {
  const del = new Uint8Array(w * h);
  let changed = true;
  let iters = 0;

  while (changed && iters < 48) {
    changed = false;
    iters++;
    for (let step = 0; step < 2; step++) {
      del.fill(0);
      for (let y = 1; y < h - 1; y++) {
        const row = y * w;
        for (let x = 1; x < w - 1; x++) {
          const idx = row + x;
          if (!mask[idx]) continue;

          const p2 = mask[idx - w];
          const p3 = mask[idx - w + 1];
          const p4 = mask[idx + 1];
          const p5 = mask[idx + w + 1];
          const p6 = mask[idx + w];
          const p7 = mask[idx + w - 1];
          const p8 = mask[idx - 1];
          const p9 = mask[idx - w - 1];

          const neighbors = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (neighbors < 2 || neighbors > 6) continue;

          const transitions =
            (!p2 && p3 ? 1 : 0) +
            (!p3 && p4 ? 1 : 0) +
            (!p4 && p5 ? 1 : 0) +
            (!p5 && p6 ? 1 : 0) +
            (!p6 && p7 ? 1 : 0) +
            (!p7 && p8 ? 1 : 0) +
            (!p8 && p9 ? 1 : 0) +
            (!p9 && p2 ? 1 : 0);
          if (transitions !== 1) continue;

          if (step === 0) {
            if (p2 * p4 * p6 !== 0 || p4 * p6 * p8 !== 0) continue;
          } else {
            if (p2 * p4 * p8 !== 0 || p2 * p6 * p8 !== 0) continue;
          }

          del[idx] = 1;
          changed = true;
        }
      }
      for (let i = 0; i < w * h; i++) {
        if (del[i]) mask[i] = 0;
      }
    }
  }
}

function cleanupStaircases(mask: Uint8Array, w: number, h: number): void {
  for (let y = 1; y < h - 1; y++) {
    const row = y * w;
    for (let x = 1; x < w - 1; x++) {
      const idx = row + x;
      if (!mask[idx]) continue;

      const n = mask[idx - w];
      const s = mask[idx + w];
      const e = mask[idx + 1];
      const we = mask[idx - 1];
      const ne = mask[idx - w + 1];
      const nw = mask[idx - w - 1];
      const se = mask[idx + w + 1];
      const sw = mask[idx + w - 1];

      if ((n && e && !sw) || (n && we && !se) || (s && e && !nw) || (s && we && !ne)) {
        const pts: Array<[number, number]> = [];
        for (let k = 0; k < 8; k++) {
          if (mask[(y + DY8[k]) * w + x + DX8[k]]) {
            pts.push([DX8[k], DY8[k]]);
          }
        }
        if (pts.length >= 2) {
          const visited = new Uint8Array(pts.length);
          visited[0] = 1;
          const queue = [0];
          let count = 1;
          while (queue.length > 0) {
            const cur = queue.shift()!;
            for (let j = 0; j < pts.length; j++) {
              if (
                !visited[j] &&
                Math.abs(pts[cur][0] - pts[j][0]) <= 1 &&
                Math.abs(pts[cur][1] - pts[j][1]) <= 1
              ) {
                visited[j] = 1;
                count++;
                queue.push(j);
              }
            }
          }
          if (count === pts.length) {
            mask[idx] = 0;
          }
        }
      }
    }
  }
}

function perpendicularDistance(pt: RawPoint, a: RawPoint, b: RawPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-9) return Math.hypot(pt.x - a.x, pt.y - a.y);
  const t = Math.max(0, Math.min(1, ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / lenSq));
  return Math.hypot(pt.x - (a.x + t * dx), pt.y - (a.y + t * dy));
}

function rdpSimplify(points: RawPoint[], epsilon: number): RawPoint[] {
  if (points.length <= 2) return points;
  let maxDist = 0;
  let maxIdx = 0;
  const first = points[0];
  const last = points[points.length - 1];

  for (let i = 1; i < points.length - 1; i++) {
    const d = perpendicularDistance(points[i], first, last);
    if (d > maxDist) {
      maxDist = d;
      maxIdx = i;
    }
  }

  if (maxDist > epsilon) {
    const left = rdpSimplify(points.slice(0, maxIdx + 1), epsilon);
    const right = rdpSimplify(points.slice(maxIdx), epsilon);
    return [...left.slice(0, -1), ...right];
  }
  return [first, last];
}

function smoothPolyline(points: RawPoint[], passes = 1): RawPoint[] {
  let cur = points;
  for (let p = 0; p < passes; p++) {
    if (cur.length <= 2) return cur;
    const next: RawPoint[] = [cur[0]];
    for (let i = 1; i < cur.length - 1; i++) {
      next.push({
        x: cur[i - 1].x * 0.2 + cur[i].x * 0.6 + cur[i + 1].x * 0.2,
        y: cur[i - 1].y * 0.2 + cur[i].y * 0.6 + cur[i + 1].y * 0.2,
      });
    }
    next.push(cur[cur.length - 1]);
    cur = next;
  }
  return cur;
}

/**
 * Trace a dark-on-light (or transparent-background dark ink) line drawing RGBA buffer
 * into a continuous normalized 2D polyline (East = +X, North = +Y).
 */
export function traceLineDrawingRgba(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  options?: {
    luminanceThreshold?: number;
    simplifyEpsilonPx?: number;
  }
): LineTraceResult {
  const lumThresh = options?.luminanceThreshold ?? 185;
  const epsilonPx = options?.simplifyEpsilonPx ?? 1.15;

  // Pad by 1px border so edge pixels can safely check 8-neighbors
  const w = width + 2;
  const h = height + 2;
  const mask = new Uint8Array(w * h);

  // Detect whether image is dark-on-light or light-on-dark
  let opaqueCount = 0;
  let brightCount = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const a = rgba[i + 3];
      if (a > 80) {
        opaqueCount++;
        const lum = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
        if (lum >= 128) brightCount++;
      }
    }
  }
  const invertLightOnDark = opaqueCount > 0 && brightCount / opaqueCount < 0.35;

  let inkCount = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const a = rgba[i + 3];
      if (a <= 80) continue;
      const lum = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
      const isInk = invertLightOnDark ? lum > 255 - lumThresh : lum < lumThresh;
      if (isInk) {
        mask[(y + 1) * w + (x + 1)] = 1;
        inkCount++;
      }
    }
  }

  if (inkCount < 8) {
    return { points: [], aspectRatio: 1, closedLoop: false, edgeCoverage: 0 };
  }

  zhangSuenThinning(mask, w, h);
  cleanupStaircases(mask, w, h);

  const degArr = new Uint8Array(w * h);
  const nodePixels: number[] = [];
  let anySkeletonPixel = -1;

  for (let y = 1; y < h - 1; y++) {
    const row = y * w;
    for (let x = 1; x < w - 1; x++) {
      const idx = row + x;
      if (!mask[idx]) continue;
      if (anySkeletonPixel === -1) anySkeletonPixel = idx;
      let d = 0;
      for (let k = 0; k < 8; k++) {
        if (mask[(y + DY8[k]) * w + x + DX8[k]]) d++;
      }
      degArr[idx] = d;
      if (d !== 2) nodePixels.push(idx);
    }
  }

  // Pure closed loop with zero crossings/endpoints: promote one pixel to anchor node
  const isPureLoop = nodePixels.length === 0 && anySkeletonPixel !== -1;
  if (isPureLoop) {
    nodePixels.push(anySkeletonPixel);
  }

  // Merge adjacent junction pixels (within Chebyshev radius 3) into supernodes
  const pixelToNode = new Int32Array(w * h).fill(-1);
  const nodes: SkeletonNode[] = [];

  for (const idx of nodePixels) {
    if (pixelToNode[idx] !== -1) continue;
    const nid = nodes.length;
    const cluster = [idx];
    pixelToNode[idx] = nid;
    const q = [idx];

    while (q.length > 0) {
      const cur = q.shift()!;
      const cx = cur % w;
      const cy = (cur / w) | 0;
      for (let oy = -3; oy <= 3; oy++) {
        for (let ox = -3; ox <= 3; ox++) {
          const nx = cx + ox;
          const ny = cy + oy;
          if (nx < 1 || nx >= w - 1 || ny < 1 || ny >= h - 1) continue;
          const nidx = ny * w + nx;
          if (mask[nidx] && (degArr[nidx] !== 2 || isPureLoop) && pixelToNode[nidx] === -1) {
            pixelToNode[nidx] = nid;
            cluster.push(nidx);
            q.push(nidx);
          }
        }
      }
    }

    let sx = 0;
    let sy = 0;
    for (const p of cluster) {
      sx += p % w;
      sy += (p / w) | 0;
    }
    nodes.push({
      id: nid,
      x: sx / cluster.length,
      y: sy / cluster.length,
      pixels: cluster,
      edges: [],
    });
  }

  // Extract all degree-2 pixel chains connecting supernodes
  const edgeVisited = new Uint8Array(w * h);
  const edges: SkeletonEdge[] = [];

  for (const node of nodes) {
    for (const p of node.pixels) {
      const px = p % w;
      const py = (p / w) | 0;
      for (let k = 0; k < 8; k++) {
        const nx = px + DX8[k];
        const ny = py + DY8[k];
        const nidx = ny * w + nx;
        if (!mask[nidx] || pixelToNode[nidx] !== -1 || edgeVisited[nidx]) continue;

        const chain: RawPoint[] = [{ x: node.x, y: node.y }];
        let prev = p;
        let cur = nidx;
        let endNode = -1;

        while (true) {
          edgeVisited[cur] = 1;
          const cx = cur % w;
          const cy = (cur / w) | 0;
          chain.push({ x: cx, y: cy });

          let nextNode = -1;
          let nextPix = -1;
          for (let m = 0; m < 8; m++) {
            const tx = cx + DX8[m];
            const ty = cy + DY8[m];
            const tidx = ty * w + tx;
            if (!mask[tidx] || tidx === prev) continue;
            if (pixelToNode[tidx] !== -1) {
              if (pixelToNode[tidx] !== node.id || chain.length > 5) {
                nextNode = pixelToNode[tidx];
                break;
              }
            } else if (!edgeVisited[tidx]) {
              nextPix = tidx;
            }
          }

          if (nextNode !== -1) {
            endNode = nextNode;
            chain.push({ x: nodes[endNode].x, y: nodes[endNode].y });
            break;
          }
          if (nextPix === -1) break;
          prev = cur;
          cur = nextPix;
        }

        if (endNode !== -1 && chain.length >= 3) {
          const eid = edges.length;
          const sIdx = Math.min(chain.length - 1, 8);
          const eIdx = Math.max(0, chain.length - 1 - 8);
          const sdx = chain[sIdx].x - chain[0].x;
          const sdy = chain[sIdx].y - chain[0].y;
          const sl = Math.hypot(sdx, sdy) || 1;
          const edx = chain[eIdx].x - chain[chain.length - 1].x;
          const edy = chain[eIdx].y - chain[chain.length - 1].y;
          const el = Math.hypot(edx, edy) || 1;

          edges.push({
            id: eid,
            a: node.id,
            b: endNode,
            pts: chain,
            tanA: [sdx / sl, sdy / sl],
            tanB: [edx / el, edy / el],
            used: false,
          });
          nodes[node.id].edges.push(eid);
          if (endNode !== node.id) {
            nodes[endNode].edges.push(eid);
          }
        }
      }
    }
  }

  if (edges.length === 0) {
    return { points: [], aspectRatio: 1, closedLoop: false, edgeCoverage: 0 };
  }

  interface TrailStep {
    nodeId: number;
    edgeId: number;
    fromA: boolean;
    inDir: [number, number];
  }

  const walkTrail = (startNodeId: number, initDir: [number, number]): TrailStep[] => {
    const steps: TrailStep[] = [
      { nodeId: startNodeId, edgeId: -1, fromA: true, inDir: initDir },
    ];
    let cur = startNodeId;
    let dir: [number, number] = initDir;

    while (true) {
      const avail = nodes[cur].edges.filter((eid) => !edges[eid].used);
      if (avail.length === 0) break;

      let bestEid = avail[0];
      let bestScore = -2;
      let bestFromA = true;

      for (const eid of avail) {
        const e = edges[eid];
        const opts = e.a === e.b ? [true, false] : [e.a === cur];
        for (const fromA of opts) {
          const tan = fromA ? e.tanA : e.tanB;
          const score = tan[0] * dir[0] + tan[1] * dir[1];
          if (score > bestScore) {
            bestScore = score;
            bestEid = eid;
            bestFromA = fromA;
          }
        }
      }

      const chosen = edges[bestEid];
      chosen.used = true;
      cur = bestFromA ? chosen.b : chosen.a;
      const outTan = bestFromA ? chosen.tanB : chosen.tanA;
      dir = [-outTan[0], -outTan[1]];
      steps.push({ nodeId: cur, edgeId: bestEid, fromA: bestFromA, inDir: dir });
    }
    return steps;
  };

  // Start at the leftmost degree-1 endpoint (or leftmost node if all nodes are even-degree loops)
  const degreeOneNodes = nodes.filter((n) => n.edges.length === 1);
  const startNode =
    degreeOneNodes.length > 0
      ? degreeOneNodes.sort((a, b) => a.x - b.x)[0]
      : [...nodes].sort((a, b) => a.x - b.x)[0];

  const trail = walkTrail(startNode.id, [1, 0]);

  // Hierholzer splicing: seamlessly insert any remaining unvisited cycles/loops at shared crossings
  let spliced = true;
  while (spliced) {
    spliced = false;
    for (let i = 0; i < trail.length; i++) {
      const nid = trail[i].nodeId;
      if (nodes[nid].edges.some((eid) => !edges[eid].used)) {
        const sub = walkTrail(nid, trail[i].inDir);
        if (sub.length > 1) {
          const subEndId = sub[sub.length - 1].nodeId;
          const distBack = Math.hypot(
            nodes[subEndId].x - nodes[nid].x,
            nodes[subEndId].y - nodes[nid].y
          );
          if (subEndId === nid || distBack <= 16) {
            // Closed loop (or slightly split crossing loop like a bicycle hub): splice cleanly in-place
            trail.splice(i + 1, 0, ...sub.slice(1));
          } else {
            // Open spur branch: walk out and retrace smoothly back to nid so zero teleport occurs
            const reverseSteps: TrailStep[] = [];
            for (let k = sub.length - 1; k >= 1; k--) {
              const st = sub[k];
              reverseSteps.push({
                nodeId: sub[k - 1].nodeId,
                edgeId: st.edgeId,
                fromA: !st.fromA,
                inDir: [-st.inDir[0], -st.inDir[1]],
              });
            }
            trail.splice(i + 1, 0, ...sub.slice(1), ...reverseSteps);
          }
          spliced = true;
          break;
        }
      }
    }
  }

  // Assemble continuous pixel polyline
  const rawPath: RawPoint[] = [];
  for (let i = 1; i < trail.length; i++) {
    const step = trail[i];
    const edge = edges[step.edgeId];
    const pts = step.fromA ? edge.pts : [...edge.pts].reverse();
    for (let j = rawPath.length > 0 ? 1 : 0; j < pts.length; j++) {
      rawPath.push(pts[j]);
    }
  }

  // Gentle 1-pass smoothing removes 1-pixel staircase jitter while keeping sharp tips crisp,
  // then RDP simplification compacts the polyline without losing shape fidelity
  const smoothed = smoothPolyline(rawPath, 1);
  const simplified = rdpSimplify(smoothed, epsilonPx);

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const pt of simplified) {
    if (pt.x < minX) minX = pt.x;
    if (pt.x > maxX) maxX = pt.x;
    if (pt.y < minY) minY = pt.y;
    if (pt.y > maxY) maxY = pt.y;
  }

  const spanX = Math.max(1, maxX - minX);
  const spanY = Math.max(1, maxY - minY);
  const aspectRatio = spanX / spanY;

  // Flip Y so top of drawing = +North (1.0) and bottom of drawing = 0.0
  const normalized: NormalizedPoint[] = simplified.map((pt) => ({
    x: Math.round(((pt.x - minX) / spanY) * 10000) / 10000,
    y: Math.round(((maxY - pt.y) / spanY) * 10000) / 10000,
  }));

  const usedEdges = edges.filter((e) => e.used).length;
  const startPt = normalized[0];
  const endPt = normalized[normalized.length - 1];
  const closedLoop =
    isPureLoop ||
    (degreeOneNodes.length === 0 &&
      Math.hypot(endPt.x - startPt.x, endPt.y - startPt.y) < 0.08);

  return {
    points: normalized,
    aspectRatio,
    closedLoop,
    edgeCoverage: usedEdges / edges.length,
  };
}

/**
 * Browser helper: decode an uploaded PNG/JPG/SVG File into an offscreen HTML5 Canvas
 * (downscaled to max 640px for fast <40ms skeletonization) and trace into a GPS Art polyline.
 */
export async function traceImageFileToNormalizedPath(file: File): Promise<LineTraceResult> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Could not decode image file.'));
      el.src = url;
    });

    const maxDim = 620;
    const scale = Math.min(1, maxDim / Math.max(1, img.naturalWidth, img.naturalHeight));
    const w = Math.max(16, Math.round(img.naturalWidth * scale));
    const h = Math.max(16, Math.round(img.naturalHeight * scale));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable.');

    // Paint solid white backdrop first so transparent PNG/SVG strokes composite cleanly
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);

    const imageData = ctx.getImageData(0, 0, w, h);
    return traceLineDrawingRgba(imageData.data, w, h);
  } finally {
    URL.revokeObjectURL(url);
  }
}
