export type RgbaImage = { width: number; height: number; data: Uint8Array };
type Rgba = [number, number, number, number];
export type Box = { x: number; y: number; width: number; height: number };
export type Region = Box & { id: string; area: number; diffPixels: number; mismatch: number };
type DiffResult = { width: number; height: number; mask: Uint8Array; count: number };

const MAX_YIQ_DELTA = 35215;
const NEIGHBOURS = [-1, 0, 1].flatMap((dy) => [-1, 0, 1].map((dx) => [dx, dy] as const));

export function createImage(width: number, height: number, fill: Rgba = [0, 0, 0, 0]): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let index = 0; index < data.length; index += 4) data.set(fill, index);
  return { width, height, data };
}

export function fillRect(image: RgbaImage, box: Box, color: Rgba) {
  const right = Math.min(image.width, box.x + box.width);
  const bottom = Math.min(image.height, box.y + box.height);
  for (let y = Math.max(0, box.y); y < bottom; y += 1) {
    for (let x = Math.max(0, box.x); x < right; x += 1)
      image.data.set(color, (y * image.width + x) * 4);
  }
}

export function flattenOnWhite(image: RgbaImage): RgbaImage {
  const data = new Uint8Array(image.data.length);
  for (let index = 0; index < data.length; index += 4) {
    const alpha = (image.data[index + 3] ?? 255) / 255;
    for (let channel = 0; channel < 3; channel += 1)
      data[index + channel] = Math.floor(255 + ((image.data[index + channel] ?? 0) - 255) * alpha);
    data[index + 3] = 255;
  }
  return { width: image.width, height: image.height, data };
}

export function crop(image: RgbaImage, box: Box): RgbaImage {
  const x = Math.max(0, Math.min(image.width, box.x));
  const y = Math.max(0, Math.min(image.height, box.y));
  const width = Math.max(0, Math.min(image.width - x, box.width));
  const height = Math.max(0, Math.min(image.height - y, box.height));
  const data = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row += 1) {
    const start = ((y + row) * image.width + x) * 4;
    data.set(image.data.subarray(start, start + width * 4), row * width * 4);
  }
  return { width, height, data };
}

function boxDownsample(image: RgbaImage, factor: number): RgbaImage {
  const width = Math.max(1, Math.floor(image.width / factor));
  const height = Math.max(1, Math.floor(image.height / factor));
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sums = [0, 0, 0, 0];
      let count = 0;
      for (let dy = 0; dy < factor; dy += 1) {
        const sy = y * factor + dy;
        if (sy >= image.height) break;
        for (let dx = 0; dx < factor; dx += 1) {
          const sx = x * factor + dx;
          if (sx >= image.width) break;
          const offset = (sy * image.width + sx) * 4;
          for (let channel = 0; channel < 4; channel += 1)
            sums[channel] = (sums[channel] ?? 0) + (image.data[offset + channel] ?? 0);
          count += 1;
        }
      }
      for (let channel = 0; channel < 4; channel += 1)
        data[(y * width + x) * 4 + channel] = Math.round((sums[channel] ?? 0) / count);
    }
  }
  return { width, height, data };
}

function bilinear(image: RgbaImage, width: number, height: number): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  const scaleX = image.width / width;
  const scaleY = image.height / height;
  for (let y = 0; y < height; y += 1) {
    const sy = Math.min(image.height - 1, Math.max(0, (y + 0.5) * scaleY - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(image.height - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < width; x += 1) {
      const sx = Math.min(image.width - 1, Math.max(0, (x + 0.5) * scaleX - 0.5));
      const x0 = Math.floor(sx);
      const x1 = Math.min(image.width - 1, x0 + 1);
      const fx = sx - x0;
      for (let channel = 0; channel < 4; channel += 1) {
        const at = (px: number, py: number) =>
          image.data[(py * image.width + px) * 4 + channel] ?? 0;
        const top = at(x0, y0) * (1 - fx) + at(x1, y0) * fx;
        const bottom = at(x0, y1) * (1 - fx) + at(x1, y1) * fx;
        data[(y * width + x) * 4 + channel] = Math.round(top * (1 - fy) + bottom * fy);
      }
    }
  }
  return { width, height, data };
}

export function resize(image: RgbaImage, width: number, height: number): RgbaImage {
  if (width === image.width && height === image.height) return image;
  const factor = Math.floor(Math.min(image.width / width, image.height / height));
  const reduced = factor >= 2 ? boxDownsample(image, factor) : image;
  if (reduced.width === width && reduced.height === height) return reduced;
  return bilinear(reduced, width, height);
}

function nearestUpscale(image: RgbaImage, factor: number): RgbaImage {
  const width = image.width * factor;
  const height = image.height * factor;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const source = (Math.floor(y / factor) * image.width + Math.floor(x / factor)) * 4;
      data.set(image.data.subarray(source, source + 4), (y * width + x) * 4);
    }
  }
  return { width, height, data };
}

export function scaleForModel(image: RgbaImage, maxSide: number, minSide: number): RgbaImage {
  const longest = Math.max(image.width, image.height);
  if (longest > maxSide) {
    const scale = maxSide / longest;
    return resize(
      image,
      Math.max(1, Math.round(image.width * scale)),
      Math.max(1, Math.round(image.height * scale)),
    );
  }
  if (longest > 0 && longest < minSide)
    return nearestUpscale(image, Math.min(8, Math.max(1, Math.floor(minSide / longest))));
  return image;
}

function yiqDelta(a: Uint8Array, ai: number, b: Uint8Array, bi: number) {
  const dr = (a[ai] ?? 0) - (b[bi] ?? 0);
  const dg = (a[ai + 1] ?? 0) - (b[bi + 1] ?? 0);
  const db = (a[ai + 2] ?? 0) - (b[bi + 2] ?? 0);
  const y = dr * 0.29889531 + dg * 0.58662247 + db * 0.11448223;
  const i = dr * 0.59597799 - dg * 0.2741761 - db * 0.32180189;
  const q = dr * 0.21147017 - dg * 0.52261711 + db * 0.31114694;
  return 0.5053 * y * y + 0.299 * i * i + 0.1957 * q * q;
}

function matchesNeighbour(
  source: Uint8Array,
  offset: number,
  other: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
  limit: number,
) {
  for (const [dx, dy] of NEIGHBOURS) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
    if (yiqDelta(source, offset, other, (ny * width + nx) * 4) <= limit) return true;
  }
  return false;
}

export function diffImages(
  reference: RgbaImage,
  page: RgbaImage,
  options: { tolerance: number },
): DiffResult {
  if (reference.width !== page.width || reference.height !== page.height) {
    throw new Error(
      `diffImages needs images of the same size, got ${reference.width}x${reference.height} and ${page.width}x${page.height}.`,
    );
  }
  const { width, height } = reference;
  const a = flattenOnWhite(reference).data;
  const b = flattenOnWhite(page).data;
  const limit = MAX_YIQ_DELTA * options.tolerance * options.tolerance;
  const mask = new Uint8Array(width * height);
  let count = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      if (yiqDelta(a, offset, b, offset) <= limit) continue;
      if (
        matchesNeighbour(b, offset, a, width, height, x, y, limit) &&
        matchesNeighbour(a, offset, b, width, height, x, y, limit)
      )
        continue;
      mask[y * width + x] = 1;
      count += 1;
    }
  }
  return { width, height, mask, count };
}

type Cluster = { left: number; top: number; right: number; bottom: number; pixels: number };

class DisjointSet {
  private readonly parent: Int32Array;

  constructor(size: number) {
    this.parent = new Int32Array(size);
    for (let index = 0; index < size; index += 1) this.parent[index] = index;
  }

  find(index: number): number {
    let root = index;
    while (this.parent[root] !== root) root = this.parent[root] ?? root;
    let current = index;
    while (current !== root) {
      const next = this.parent[current] ?? root;
      this.parent[current] = root;
      current = next;
    }
    return root;
  }

  union(a: number, b: number) {
    const left = this.find(a);
    const right = this.find(b);
    if (left === right) return false;
    this.parent[Math.max(left, right)] = Math.min(left, right);
    return true;
  }
}

function gapBetween(a: Cluster, b: Cluster) {
  const dx = Math.max(0, Math.max(a.left, b.left) - Math.min(a.right, b.right) - 1);
  const dy = Math.max(0, Math.max(a.top, b.top) - Math.min(a.bottom, b.bottom) - 1);
  return Math.max(dx, dy);
}

function mergeGroups(clusters: Cluster[], sets: DisjointSet) {
  const merged = new Map<number, Cluster>();
  clusters.forEach((cluster, index) => {
    const root = sets.find(index);
    const target = merged.get(root);
    if (!target) {
      merged.set(root, { ...cluster });
      return;
    }
    target.left = Math.min(target.left, cluster.left);
    target.top = Math.min(target.top, cluster.top);
    target.right = Math.max(target.right, cluster.right);
    target.bottom = Math.max(target.bottom, cluster.bottom);
    target.pixels += cluster.pixels;
  });
  return [...merged.values()];
}

function cellClusters(diff: DiffResult, mergeGap: number) {
  const cell = Math.max(1, Math.floor(mergeGap / 2));
  const reach = Math.max(1, Math.ceil(mergeGap / cell));
  const columns = Math.ceil(diff.width / cell);
  const rows = Math.ceil(diff.height / cell);
  const slot = new Int32Array(columns * rows).fill(-1);
  const cells: Cluster[] = [];
  const keys: number[] = [];
  for (let y = 0; y < diff.height; y += 1) {
    const rowKey = Math.floor(y / cell) * columns;
    for (let x = 0; x < diff.width; x += 1) {
      if (!diff.mask[y * diff.width + x]) continue;
      const key = rowKey + Math.floor(x / cell);
      const index = slot[key] ?? -1;
      if (index === -1) {
        slot[key] = cells.length;
        keys.push(key);
        cells.push({ left: x, right: x, top: y, bottom: y, pixels: 1 });
        continue;
      }
      const found = cells[index];
      if (!found) continue;
      if (x < found.left) found.left = x;
      if (x > found.right) found.right = x;
      found.bottom = y;
      found.pixels += 1;
    }
  }
  const sets = new DisjointSet(cells.length);
  cells.forEach((current, index) => {
    const key = keys[index] ?? 0;
    const cx = key % columns;
    const cy = Math.floor(key / columns);
    for (let dy = 0; dy <= reach; dy += 1) {
      for (let dx = -reach; dx <= reach; dx += 1) {
        if (dy === 0 && dx <= 0) continue;
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= columns || ny >= rows) continue;
        const other = slot[ny * columns + nx] ?? -1;
        const neighbour = cells[other];
        if (!neighbour || gapBetween(current, neighbour) > mergeGap) continue;
        sets.union(index, other);
      }
    }
  });
  return mergeGroups(cells, sets);
}

function mergeClose(clusters: Cluster[], mergeGap: number) {
  let current = clusters;
  const bucketSize = Math.max(64, mergeGap * 4);
  const half = Math.ceil(mergeGap / 2);
  for (;;) {
    const sets = new DisjointSet(current.length);
    const buckets = new Map<number, number[]>();
    let merged = false;
    current.forEach((cluster, index) => {
      const left = Math.floor(Math.max(0, cluster.left - half) / bucketSize);
      const right = Math.floor((cluster.right + half) / bucketSize);
      const top = Math.floor(Math.max(0, cluster.top - half) / bucketSize);
      const bottom = Math.floor((cluster.bottom + half) / bucketSize);
      for (let by = top; by <= bottom; by += 1) {
        for (let bx = left; bx <= right; bx += 1) {
          const key = by * 1_000_003 + bx;
          const members = buckets.get(key);
          if (!members) {
            buckets.set(key, [index]);
            continue;
          }
          for (const other of members) {
            const neighbour = current[other];
            if (
              !neighbour ||
              sets.find(other) === sets.find(index) ||
              gapBetween(cluster, neighbour) > mergeGap
            )
              continue;
            sets.union(other, index);
            merged = true;
          }
          members.push(index);
        }
      }
    });
    if (!merged) return current;
    current = mergeGroups(current, sets);
  }
}

export function clusterRegions(
  diff: DiffResult,
  options: { minArea: number; mergeGap: number },
): Region[] {
  if (diff.count === 0) return [];
  const clusters = mergeClose(cellClusters(diff, options.mergeGap), options.mergeGap);
  return clusters
    .map((cluster) => {
      const width = cluster.right - cluster.left + 1;
      const height = cluster.bottom - cluster.top + 1;
      return {
        x: cluster.left,
        y: cluster.top,
        width,
        height,
        area: width * height,
        diffPixels: cluster.pixels,
        mismatch: cluster.pixels / (width * height),
      };
    })
    .filter((region) => region.area >= options.minArea)
    .toSorted((left, right) => right.area - left.area || left.y - right.y || left.x - right.x)
    .map((region, index) => ({
      id: `R${index + 1}`,
      x: region.x,
      y: region.y,
      width: region.width,
      height: region.height,
      area: region.area,
      diffPixels: region.diffPixels,
      mismatch: region.mismatch,
    }));
}

const OUTLINE: Rgba = [255, 0, 255, 255];
const CHANGED: Rgba = [255, 0, 0, 255];

export function renderDiffImage(page: RgbaImage, diff: DiffResult, regions: Box[]): RgbaImage {
  const flat = flattenOnWhite(page);
  const data = new Uint8Array(flat.data.length);
  for (let index = 0; index < data.length; index += 4) {
    const gray =
      0.299 * (flat.data[index] ?? 0) +
      0.587 * (flat.data[index + 1] ?? 0) +
      0.114 * (flat.data[index + 2] ?? 0);
    const faded = Math.round(255 - (255 - gray) * 0.3);
    data[index] = faded;
    data[index + 1] = faded;
    data[index + 2] = faded;
    data[index + 3] = 255;
  }
  const image = { width: page.width, height: page.height, data };
  for (let index = 0; index < diff.mask.length; index += 1)
    if (diff.mask[index]) data.set(CHANGED, index * 4);
  for (const region of regions) {
    const outer = {
      x: region.x - 3,
      y: region.y - 3,
      width: region.width + 6,
      height: region.height + 6,
    };
    fillRect(image, { x: outer.x, y: outer.y, width: outer.width, height: 2 }, OUTLINE);
    fillRect(
      image,
      { x: outer.x, y: outer.y + outer.height - 2, width: outer.width, height: 2 },
      OUTLINE,
    );
    fillRect(image, { x: outer.x, y: outer.y, width: 2, height: outer.height }, OUTLINE);
    fillRect(
      image,
      { x: outer.x + outer.width - 2, y: outer.y, width: 2, height: outer.height },
      OUTLINE,
    );
  }
  return image;
}
