/* ==========================================================================
   Superpoint Graph Viewer — app.js
   Renders the exported NAG (see tools/export_nag.py) with Plotly's WebGL
   3D scatter trace. No build step: this file is loaded directly by
   index.html after vendor/plotly.min.js.

   Layout of the code:
     1. small utilities (typed-array fetch, colour helpers)
     2. state + manifest bootstrap
     3. per-level data loading (cached, so switching "colour by" is instant)
     4. trace builders — one function per colour mode
     5. the two render paths: single level, and the stacked hierarchy
     6. UI wiring
   ========================================================================== */

'use strict';

// ---------------------------------------------------------------- 1. utils

const DTYPE_CTOR = {
  float32: Float32Array,
  uint8: Uint8Array,
  int32: Int32Array,
};

async function fetchField(field) {
  // field: {file, dtype, shape, bytes} as written by export_nag.py
  const res = await fetch(`data/${field.file}`);
  if (!res.ok) throw new Error(`could not fetch ${field.file} (${res.status})`);
  const buf = await res.arrayBuffer();
  const Ctor = DTYPE_CTOR[field.dtype];
  if (!Ctor) throw new Error(`unknown dtype ${field.dtype} for ${field.file}`);
  return new Ctor(buf);
}

/** Split an interleaved [N,3] typed array into three plain arrays. */
function splitXYZ(flat) {
  const n = flat.length / 3;
  const x = new Array(n), y = new Array(n), z = new Array(n);
  for (let i = 0; i < n; i++) {
    x[i] = flat[3 * i]; y[i] = flat[3 * i + 1]; z[i] = flat[3 * i + 2];
  }
  return { x, y, z };
}

/** Split an interleaved [N,2] int array into two plain arrays. */
function splitPairs(flat) {
  const n = flat.length / 2;
  const a = new Array(n), b = new Array(n);
  for (let i = 0; i < n; i++) { a[i] = flat[2 * i]; b[i] = flat[2 * i + 1]; }
  return { a, b };
}

/** Deterministic hash -> [0,1). Small-integer inputs scramble well (this is
 * the xorshift* finalizer), which matters here: neighbouring superpoint ids
 * are usually spatially adjacent, so a naive id->hue map would make
 * neighbours nearly the same colour -- the exact problem noted in the
 * static partition figure (make_method_figures.py, fig_partition). */
function hash01(i) {
  let x = (i + 0x9e3779b9) | 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  x = (x ^ (x >>> 16)) >>> 0;
  return x / 4294967296;
}

/** Build a cached lookup of `count` visually separated hex colours. */
const structureColorCache = new Map();
function structureColors(count) {
  if (structureColorCache.has(count)) return structureColorCache.get(count);
  const lut = new Array(count);
  for (let i = 0; i < count; i++) {
    const h = hash01(i) * 360;
    const s = 55 + (hash01(i * 7 + 3) * 25);       // 55-80%
    const l = 48 + (hash01(i * 13 + 5) * 14);       // 48-62%
    lut[i] = `hsl(${h.toFixed(1)},${s.toFixed(0)}%,${l.toFixed(0)}%)`;
  }
  structureColorCache.set(count, lut);
  return lut;
}

const DIVERGING = [
  [0, '#1565c0'], [0.5, '#eef2f6'], [1, '#b71c1c'],
];
const SEQUENTIAL = [
  [0, '#0d1b2a'], [0.35, '#12466b'], [0.7, '#5fb3ff'], [1, '#eaf6ff'],
];

/** Fixed saturation half-ranges for the diverging (change) fields, taken
 * directly from Table 3.4 rather than computed from the data. A handful of
 * points carry genuine outlier values -- e.g. Stretch reaches into the
 * thousands at a few degenerate-normal boundary points, the same population
 * Section 3.3 documents as excluded by the significance test -- and scaling
 * to the data max would wash the whole reach out to white to accommodate
 * them. cmin/cmax clip rather than rescale: an outlier still renders, just
 * saturated at the end colour, exactly as CloudCompare does for Figure 3.5.
 * M3C2 has no table entry; it is given Translation's range, since Section 3.4
 * calls Translation "the direct analogue of the M3C2 distance". */
const DIVERGING_RANGE = {
  m3c2: 1.0, translation: 1.0, rotation: 0.3, stretch: 0.05, distortion: 0.5,
};

/** min/max over a (possibly 150,000-element) array without spreading it into
 * Math.min/max -- `Math.max(...bigArray)` blows the call stack well before
 * that size (the argument-count ceiling is engine-dependent but well under
 * 150k), which is exactly the bug this replaced. */
function minMax(arr, fn) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < arr.length; i++) {
    const v = fn ? fn(arr[i]) : arr[i];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return [lo, hi];
}

function fmt(n, d = 2) {
  return (typeof n === 'number' && isFinite(n)) ? n.toFixed(d) : '—';
}
function fmtInt(n) { return n.toLocaleString('en-US'); }

// ---------------------------------------------------------- 2. state / boot

const state = {
  manifest: null,
  level: '0',              // '0' | '1' | '2' | '3' | 'stack'
  colorBy: null,            // key into the colour-mode table for this level
  pointSize: 3,
  showEdges: false,
  keptOnly: false,
  overlayOn: {},             // overlay key -> bool
  overlayData: {},           // overlay key -> the fetched rings, cached
  gap: 12,
  stackFocus: 0,             // 0=all, 1/2/3 = that stack level only, rest greyed
  cache: {},                 // level -> {field: typedArray}; '0-thin' on phones
  plotted: false,
  drawerOpen: false,         // small screens only; the sidebar is fixed above 820px
};

/* ---------------------------------------------------- responsive plumbing

 * One media query drives everything: the same 820px at which the stylesheet
 * turns the sidebar into a drawer. Keeping the threshold in both files is a
 * duplication, but matchMedia is the only way JS can ask the question, and a
 * mismatch would show up immediately as a drawer that will not close.
 *
 * Nothing here re-lays-out the plot. The drawer is positioned OVER the viewer
 * rather than in the flex row, so opening and closing it never changes the
 * canvas size and Plotly is never asked to re-measure on a menu tap. */
const SMALL_SCREEN = window.matchMedia('(max-width: 820px)');
const isSmallScreen = () => SMALL_SCREEN.matches;

function setDrawer(open) {
  const bar = document.getElementById('sidebar');
  const scrim = document.getElementById('sidebar-scrim');
  const btn = document.getElementById('btn-menu');
  bar.classList.toggle('open', open);
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  btn.setAttribute('aria-label', open ? 'Hide controls' : 'Show controls');
  if (open) {
    scrim.hidden = false;
    requestAnimationFrame(() => scrim.classList.add('show'));
  } else {
    scrim.classList.remove('show');
    // Wait out the fade before hiding, or the scrim vanishes instead of fading.
    setTimeout(() => { if (!bar.classList.contains('open')) scrim.hidden = true; }, 240);
  }
  state.drawerOpen = open;
}

/* Choosing a level or a colour mode on a phone should show you the result, not
 * leave you looking at the menu you chose it from. On desktop the sidebar is
 * permanent and there is nothing to close. */
function closeDrawerAfterChoice() {
  if (isSmallScreen() && state.drawerOpen) setDrawer(false);
}

const COLOR_MODES = {
  0: [
    { key: 'rgb', label: 'True colour', swatch: 'rgbtrue' },
    { key: 'class', label: 'Class (rebuilt label)', swatch: 'grad-random', categorical: true },
    { key: 'elevation', label: 'Elevation', swatch: 'grad-sequential' },
    { key: 'm3c2', label: 'M3C2 distance', swatch: 'grad-diverging' },
    { key: 'translation', label: 'Translation', swatch: 'grad-diverging' },
    { key: 'rotation', label: 'Rotation', swatch: 'grad-diverging' },
    { key: 'stretch', label: 'Stretch', swatch: 'grad-diverging' },
    { key: 'distortion', label: 'Distortion', swatch: 'grad-diverging' },
    { key: 'parent1', label: 'Parent P₁ unit (structure)', swatch: 'grad-random' },
    // The gate is a property of a P1 unit, but the question it answers is
    // asked about ground, so this pushes each unit's verdict back down onto
    // its voxels. Switch it on with the river extent to see the discarded
    // ground lying along the margin.
    { key: 'gate1', label: 'Purity gate of parent P₁', swatch: 'grad-random', categorical: true },
  ],
  1: [
    { key: 'class', label: 'Class (majority)', swatch: 'grad-random', categorical: true },
    { key: 'kept', label: 'Purity gate (kept / discarded)', swatch: 'grad-random', categorical: true },
    { key: 'purity', label: 'Purity', swatch: 'grad-sequential' },
    { key: 'n_voxels', label: 'Voxel count', swatch: 'grad-sequential' },
    { key: 'self', label: 'Unit id (structure)', swatch: 'grad-random' },
    { key: 'parent', label: 'Parent P₂ unit (structure)', swatch: 'grad-random' },
  ],
  2: [
    { key: 'class', label: 'Class (majority)', swatch: 'grad-random', categorical: true },
    { key: 'purity', label: 'Purity', swatch: 'grad-sequential' },
    { key: 'n_voxels', label: 'Voxel count', swatch: 'grad-sequential' },
    { key: 'self', label: 'Unit id (structure)', swatch: 'grad-random' },
    { key: 'parent', label: 'Parent P₃ unit (structure)', swatch: 'grad-random' },
  ],
  3: [
    { key: 'class', label: 'Class (majority)', swatch: 'grad-random', categorical: true },
    { key: 'purity', label: 'Purity', swatch: 'grad-sequential' },
    { key: 'n_voxels', label: 'Voxel count', swatch: 'grad-sequential' },
    { key: 'self', label: 'Unit id (structure)', swatch: 'grad-random' },
  ],
  stack: [
    { key: 'class', label: 'Class (majority)', swatch: 'grad-random', categorical: true },
    { key: 'purity', label: 'Purity', swatch: 'grad-sequential' },
    { key: 'self', label: 'Unit id (structure, per level)', swatch: 'grad-random' },
  ],
};

async function boot() {
  setLoading(true, 'Loading manifest…');
  const res = await fetch('data/manifest.json');
  if (!res.ok) {
    setLoading(true,
      'Could not load data/manifest.json — run tools/export_nag.py first, ' +
      'and serve this folder over HTTP (see README.md).');
    return;
  }
  state.manifest = await res.json();
  state.colorBy = COLOR_MODES['0'][0].key;

  renderStats();
  wireControls();
  buildColorByList();
  await renderCurrentLevel();
  setLoading(false);
}

function setLoading(show, text) {
  const el = document.getElementById('loading');
  if (text) document.getElementById('loading-text').textContent = text;
  el.classList.toggle('hidden', !show);
}

// --------------------------------------------------------- 3. data loading

/* P0 ships as a 150,000-point sample, chosen for a desktop GPU. On a phone that
 * is too many, and the binding constraint is not the GPU: the default colour
 * mode is true colour, and rgbTrace builds one "rgb(r,g,b)" STRING per point,
 * so 150,000 points means 150,000 string allocations before anything is drawn.
 * That is a multi-second stall on a mid-range phone and an out-of-memory risk
 * on a weak one.
 *
 * So P0 is thinned again on small screens, by a fixed stride over an already
 * random sample, which keeps it a uniform sample of the reach. Only level 0 is
 * touched: P1 is 10,061 points and the levels above it are smaller still.
 *
 * The count this returns is the count actually drawn, and the level hint reads
 * it from here, so the number on screen is never a number that was true on a
 * different device. */
// A target, not the count: the stride is an integer, so 150,000 at a target of
// 45,000 gives stride 4 and 37,500 drawn. The thesis no longer quotes that
// figure -- section 4.8 was rewritten to report what the product offers rather
// than how it is built -- so this constant is free to change. What must stay
// true is the claim that did survive there: the interface reports the number
// actually drawn, never the number exported. updateLevelHint() is what keeps it.
const MOBILE_P0_TARGET = 45000;

function thinLevel0(data) {
  const stride = Math.ceil(data.count / MOBILE_P0_TARGET);
  if (stride <= 1) return data;
  const n = Math.floor(data.count / stride);
  const out = { count: n, fields: {}, thinnedFrom: data.count, stride };
  for (const [key, arr] of Object.entries(data.fields)) {
    const w = arr.length / data.count;          // 3 for pos and rgb, else 1
    if (!Number.isInteger(w)) { out.fields[key] = arr; continue; }
    const dst = new arr.constructor(n * w);
    for (let i = 0; i < n; i++) {
      const s = i * stride * w;
      for (let c = 0; c < w; c++) dst[i * w + c] = arr[s + c];
    }
    out.fields[key] = dst;
  }
  return out;
}

async function getLevelData(level) {
  const key = level === '0' && isSmallScreen() ? '0-thin' : level;
  if (state.cache[key]) return state.cache[key];
  const entry = state.manifest.levels[level];
  const out = { count: entry.count, fields: {} };
  const jobs = Object.entries(entry.fields).map(async ([k, field]) => {
    out.fields[k] = await fetchField(field);
  });
  await Promise.all(jobs);
  state.cache[level] = out;
  const use = key === '0-thin' ? thinLevel0(out) : out;
  state.cache[key] = use;
  return use;
}

// ------------------------------------------------------- 4. trace builders

function classTraces(pos, classArr, mask, sizePx, opacity, label3d, opts) {
  const names = state.manifest.class_names;
  const colors = state.manifest.class_colors;
  const showlegend = !opts || opts.showlegend !== false;
  const traces = [];
  for (let c = 0; c < 5; c++) {
    const xs = [], ys = [], zs = [], txt = [];
    for (let i = 0; i < classArr.length; i++) {
      if (mask && !mask[i]) continue;
      if (classArr[i] !== c) continue;
      xs.push(pos.x[i]); ys.push(pos.y[i]); zs.push(pos.z[i]);
      if (label3d) txt.push(label3d(i));
    }
    if (!xs.length) continue;
    traces.push({
      type: 'scatter3d', mode: 'markers', name: `${c} ${names[c]}`,
      legendgroup: `class-${c}`, showlegend,
      x: xs, y: ys, z: zs,
      text: txt.length ? txt : undefined,
      hovertemplate: txt.length ? '%{text}<extra></extra>' : undefined,
      marker: { size: sizePx, color: colors[c], opacity },
    });
  }
  return traces;
}

function continuousTrace(pos, values, mask, sizePx, opacity, opts) {
  const xs = [], ys = [], zs = [], vs = [], txt = [];
  for (let i = 0; i < values.length; i++) {
    if (mask && !mask[i]) continue;
    xs.push(pos.x[i]); ys.push(pos.y[i]); zs.push(pos.z[i]); vs.push(values[i]);
    if (opts.label3d) txt.push(opts.label3d(i));
  }
  const marker = {
    size: sizePx, opacity,
    color: vs, colorscale: opts.diverging ? DIVERGING : SEQUENTIAL,
    showscale: opts.showscale !== false,
    colorbar: { title: { text: opts.title, side: 'right', font: { color: '#94a3b8', size: 11 } },
      tickfont: { color: '#94a3b8', size: 10 }, thickness: 14, len: 0.55,
      outlinewidth: 0, x: 1.0 },
  };
  if (opts.diverging) {
    // A fixed range (opts.range, from Table 3.4) always wins when supplied.
    // It is only left to fall back on the data's own extent for a field with
    // no table entry, and even then the outlier bug this replaced showed why
    // that fallback is a last resort, not a default.
    const m = opts.range || Math.max(1e-9, minMax(vs, Math.abs)[1]);
    marker.cmin = -m; marker.cmax = m; marker.cmid = 0;
  }
  return [{
    type: 'scatter3d', mode: 'markers', name: opts.title,
    x: xs, y: ys, z: zs, marker,
    text: txt.length ? txt : undefined,
    hovertemplate: txt.length ? '%{text}<extra></extra>' : undefined,
    showlegend: false,
  }];
}

function structureTrace(pos, ids, mask, sizePx, opacity, title, label3d) {
  const n = ids.length;
  let maxId = 0;
  for (let i = 0; i < n; i++) if (ids[i] > maxId) maxId = ids[i];
  const lut = structureColors(maxId + 1);
  const xs = [], ys = [], zs = [], cs = [], txt = [];
  for (let i = 0; i < n; i++) {
    if (mask && !mask[i]) continue;
    xs.push(pos.x[i]); ys.push(pos.y[i]); zs.push(pos.z[i]); cs.push(lut[ids[i]]);
    if (label3d) txt.push(label3d(i));
  }
  return [{
    type: 'scatter3d', mode: 'markers', name: title,
    x: xs, y: ys, z: zs,
    text: txt.length ? txt : undefined,
    hovertemplate: txt.length ? '%{text}<extra></extra>' : undefined,
    marker: { size: sizePx, color: cs, opacity }, showlegend: false,
  }];
}

function rgbTrace(pos, rgb, sizePx, opacity, label3d) {
  const n = rgb.length / 3;
  const xs = pos.x, ys = pos.y, zs = pos.z, cs = new Array(n);
  const txt = label3d ? new Array(n) : undefined;
  for (let i = 0; i < n; i++) {
    cs[i] = `rgb(${rgb[3 * i]},${rgb[3 * i + 1]},${rgb[3 * i + 2]})`;
    if (label3d) txt[i] = label3d(i);
  }
  return [{
    type: 'scatter3d', mode: 'markers', name: 'True colour',
    x: xs, y: ys, z: zs,
    text: txt,
    hovertemplate: txt ? '%{text}<extra></extra>' : undefined,
    marker: { size: sizePx, color: cs, opacity: 1 }, showlegend: false,
  }];
}

function edgeTrace(pos, pairFlat, zOffset, color, width) {
  const n = pairFlat.length / 2;
  const xs = [], ys = [], zs = [];
  for (let i = 0; i < n; i++) {
    const a = pairFlat[2 * i], b = pairFlat[2 * i + 1];
    xs.push(pos.x[a], pos.x[b], null);
    ys.push(pos.y[a], pos.y[b], null);
    zs.push(pos.z[a] + zOffset, pos.z[b] + zOffset, null);
  }
  return {
    type: 'scatter3d', mode: 'lines', name: 'edges',
    x: xs, y: ys, z: zs,
    line: { color, width }, hoverinfo: 'skip', showlegend: false,
  };
}

// ------------------------------------------------- 4b. river extent overlay

/* The river extents, as digitised for the labelling and exported by
 * Python/Claude/river_extent_purity.py. They are the delineations the
 * transformed classes are defined against: a unit is stable where the two
 * epochs agree and transformed where they differ, so drawing them under the
 * purity-gate colouring shows directly what the Discussion claims -- units
 * that fail the gate cluster on these lines, because a unit straddling one
 * contains two classes and cannot be pure. The same script measures the
 * relationship these render.
 *
 * Driven by the manifest rather than a hardcoded list, so exporting a third
 * extent needs no change here. Each is fetched once, on first use: together
 * they are 43 kB, and most sessions never switch either on.
 *
 * The colour is the manifest's, so the viewer and any figure made from the
 * same export cannot disagree about which epoch is which. */
const OVERLAY_KEYS = ['river_aug', 'river_nov'];

function overlayMeta(key) {
  return (state.manifest.overlays || {})[key] || null;
}

async function getOverlay(key) {
  if (state.overlayData[key]) return state.overlayData[key];
  const ov = overlayMeta(key);
  if (!ov) return null;
  const res = await fetch('data/' + ov.file);
  if (!res.ok) return null;
  state.overlayData[key] = await res.json();
  return state.overlayData[key];
}

/* Every overlay currently switched on, as traces. Returns an array so the two
 * call sites (single level and stack) stay one line each. */
async function overlayTraces(zOffset) {
  const out = [];
  for (const key of OVERLAY_KEYS) {
    if (!state.overlayOn[key]) continue;
    const data = await getOverlay(key);
    if (!data) continue;
    const meta = overlayMeta(key);
    out.push(riverTrace(data, zOffset, meta.color || '#ffb04d',
                        meta.label || key));
  }
  return out;
}

/* One trace for the whole extent: the rings are joined with nulls, which is
 * how Plotly breaks a line without starting a new trace. Twenty-one separate
 * traces would each claim a legend entry and each cost a draw call.
 *
 * `hole` rings are drawn in the same colour deliberately. On the ground a hole
 * is a bar standing dry inside the wetted area, and its edge is as much a class
 * margin as the outer bank is -- distinguishing them would imply the classifier
 * treats them differently, and it does not. */
function riverTrace(river, zOffset, color, name) {
  const xs = [], ys = [], zs = [];
  for (const r of river.rings) {
    for (let i = 0; i < r.x.length; i++) {
      xs.push(r.x[i]); ys.push(r.y[i]); zs.push(r.z[i] + zOffset);
    }
    xs.push(r.x[0]); ys.push(r.y[0]); zs.push(r.z[0] + zOffset);  // close it
    xs.push(null); ys.push(null); zs.push(null);
  }
  return {
    type: 'scatter3d', mode: 'lines', name,
    x: xs, y: ys, z: zs,
    line: { color, width: 4 },
    hoverinfo: 'skip', showlegend: true,
  };
}

// ---------------------------------------------------- 5a. single-level render

// A render can still be awaiting its data when a newer one starts -- a user
// switching levels quickly enough that two overlapping fetches are in
// flight at once. Without a guard, whichever resolves LAST wins and can
// silently overwrite a newer, already-correct render with a stale one --
// every call captures the generation counter at entry and checks it again
// right before
// touching the plot; if a newer render has since started, it steps aside.
let _renderGen = 0;

async function renderCurrentLevel() {
  const gen = ++_renderGen;
  const lvl = state.level;
  updateColorByAvailability();

  if (lvl === 'stack') return renderStack(gen);

  const data = await getLevelData(lvl);
  if (gen !== _renderGen) return;
  updateLevelHint();          // the P0 count is only knowable once it is loaded
  const pos = splitXYZ(data.fields.pos);
  const n = data.count;

  let mask = null;
  if (lvl === '1' && state.keptOnly && data.fields.kept) {
    mask = data.fields.kept;
  }

  const label3d = buildHoverLabeller(lvl, data);
  let traces = [];
  const mode = COLOR_MODES[lvl].find((m) => m.key === state.colorBy) || COLOR_MODES[lvl][0];

  if (mode.key === 'rgb') {
    traces = rgbTrace(pos, data.fields.rgb, state.pointSize, 0.95, label3d);
  } else if (mode.key === 'class') {
    traces = classTraces(pos, data.fields.class, mask, state.pointSize, 0.95, label3d);
  } else if (mode.key === 'kept' || mode.key === 'gate1') {
    let keptCat = data.fields.kept; // 0/1
    if (mode.key === 'gate1') {
      //  Level 0 carries no gate flag of its own: the gate is decided one
      //  level up. Fetch P1's flags and read each voxel's parent through
      //  parent1. getLevelData caches, so this costs one fetch per session.
      const d1 = await getLevelData('1');
      if (gen !== _renderGen) return;
      const par = data.fields.parent1, k1 = d1.fields.kept;
      keptCat = new Uint8Array(n);
      for (let i = 0; i < n; i++) keptCat[i] = k1[par[i]];
      data.fields.gate1 = keptCat;          // so the legend can count it
    }
    const names = ['discarded', 'kept'];
    const colors = ['#5b6675', '#5fb3ff'];
    for (let c = 0; c <= 1; c++) {
      const xs = [], ys = [], zs = [], txt = [];
      for (let i = 0; i < n; i++) {
        if (keptCat[i] !== c) continue;
        xs.push(pos.x[i]); ys.push(pos.y[i]); zs.push(pos.z[i]);
        txt.push(label3d(i));
      }
      if (!xs.length) continue;
      traces.push({
        type: 'scatter3d', mode: 'markers', name: names[c],
        x: xs, y: ys, z: zs, text: txt, hovertemplate: '%{text}<extra></extra>',
        marker: { size: state.pointSize, color: colors[c], opacity: 0.95 },
      });
    }
  } else if (mode.key === 'self') {
    traces = structureTrace(pos, indices(n), mask, state.pointSize, 0.95, 'Unit id', label3d);
  } else if (mode.key === 'parent1' || mode.key === 'parent') {
    traces = structureTrace(pos, data.fields[mode.key === 'parent1' ? 'parent1' : 'parent'],
      mask, state.pointSize, 0.95, 'Parent unit', label3d);
  } else {
    // continuous numeric field
    const titles = {
      elevation: 'elevation (m)', m3c2: 'M3C2 distance (m)',
      translation: 'Translation (m)', rotation: 'Rotation', stretch: 'Stretch',
      distortion: 'Distortion', purity: 'purity', n_voxels: 'voxels in unit',
    };
    const diverging = mode.key in DIVERGING_RANGE;
    traces = continuousTrace(pos, data.fields[mode.key], mask, state.pointSize, 0.95,
      { title: titles[mode.key] || mode.key, diverging, label3d,
        range: DIVERGING_RANGE[mode.key] });
  }

  if (state.showEdges && data.fields.edges) {
    traces.push(edgeTrace(pos, data.fields.edges, 0, '#5fb3ff88', 1.5));
    document.getElementById('edge-count').textContent =
      `(${fmtInt(data.fields.edges.length / 2)})`;
  } else {
    document.getElementById('edge-count').textContent = '';
  }

  const overlays = await overlayTraces(0);
  if (gen !== _renderGen) return;
  traces.push(...overlays);

  if (gen !== _renderGen) return;
  draw(traces, axisTitlesFor(lvl));
  updateLegend(mode, lvl, data, mask);
}

function indices(n) { const a = new Array(n); for (let i = 0; i < n; i++) a[i] = i; return a; }

function buildHoverLabeller(lvl, data) {
  const names = state.manifest.class_names;
  if (lvl === '0') {
    return (i) => `voxel ${i}<br>class: ${names[data.fields.class[i]]}`;
  }
  return (i) => {
    const c = data.fields.class ? names[data.fields.class[i]] : '';
    const p = data.fields.purity ? data.fields.purity[i].toFixed(2) : '';
    const nv = data.fields.n_voxels ? data.fields.n_voxels[i] : '';
    return `P${lvl} unit ${i}<br>class: ${c}<br>purity: ${p}<br>voxels: ${nv}`;
  };
}

function axisTitlesFor() {
  return { x: 'easting (m, local)', y: 'northing (m, local)', z: 'elevation (m)' };
}

// -------------------------------------------------------- 5b. stack render

async function renderStack(gen) {
  const [d1, d2, d3] = await Promise.all([getLevelData('1'), getLevelData('2'), getLevelData('3')]);
  if (gen !== _renderGen) return;
  const p1 = splitXYZ(d1.fields.pos);
  const p2 = splitXYZ(d2.fields.pos);
  const p3 = splitXYZ(d3.fields.pos);

  const gap = state.gap;
  const off1 = offsetPos(p1, gap * 1);
  const off2 = offsetPos(p2, gap * 2);
  const off3 = offsetPos(p3, gap * 3);

  const mode = COLOR_MODES.stack.find((m) => m.key === state.colorBy) || COLOR_MODES.stack[0];

  // Legend and colourbar are shown once, on the base (P1) layer only --
  // otherwise every one of the three layers repeats the same five class
  // names, or draws its own colourbar, and the legend triples for nothing.
  const layerTraces = (pos, data, sizePx, isBase) => {
    if (mode.key === 'class') {
      return classTraces(pos, data.fields.class, null, sizePx, 0.95, null,
        { showlegend: isBase });
    }
    if (mode.key === 'purity') {
      return continuousTrace(pos, data.fields.purity, null, sizePx, 0.95,
        { title: 'purity', diverging: false, showscale: isBase });
    }
    return structureTrace(pos, indices(data.count), null, sizePx, 0.95, 'Unit id');
  };

  const t1 = layerTraces(off1, d1, Math.max(2, state.pointSize - 1), true);
  const t2 = layerTraces(off2, d2, state.pointSize + 1, false);
  const t3 = layerTraces(off3, d3, state.pointSize + 3, false);
  const traces = [...t1, ...t2, ...t3];
  // One entry per trace above, same order, naming its stack level -- this is
  // what the focus slider dims against. Recorded on state rather than
  // returned, because applyStackFocus runs later, from a slider event, well
  // after this function has returned.
  const levelOf = [...t1.map(() => 1), ...t2.map(() => 2), ...t3.map(() => 3)];

  if (state.showEdges) {
    traces.push(connectorTrace(p1, off1, d1.fields.parent, off2, '#5fb3ff55'));
    traces.push(connectorTrace(p2, off2, d2.fields.parent, off3, '#ffd58a55'));
    levelOf.push('edge', 'edge');
    document.getElementById('edge-count').textContent =
      `(${fmtInt(d1.count + d2.count)})`;
  } else {
    document.getElementById('edge-count').textContent = '';
  }

  //  In the stack the extents belong on the P1 plane: it is the P1 gate they
  //  explain, and a line floating at true elevation would sit below every
  //  layer and read as a fourth one.
  const stackOverlays = await overlayTraces(gap * 1);
  if (gen !== _renderGen) return;
  stackOverlays.forEach((t) => { traces.push(t); levelOf.push(1); });

  if (gen !== _renderGen) return;
  state._stackLevelOf = levelOf;
  draw(traces, { x: 'easting (m, local)', y: 'northing (m, local)', z: 'elevation (m) + level offset' });
  updateLegendStack(mode);
  applyStackFocus(state.stackFocus);
}

const STACK_DIM_COLOR = '#3a4452';
const STACK_FOCUS_LABELS = ['All levels', 'P₁ focused', 'P₂ focused', 'P₃ focused'];

/** Grey out every stack trace not in `focus` (0 = show all normally), without
 * hiding or rebuilding anything -- Plotly.restyle swaps each trace's marker
 * or line back and forth between the colours renderStack originally computed
 * (captured once, on first touch) and a flat grey. No data is re-fetched. */
function applyStackFocus(focus) {
  const slider = document.getElementById('stack-focus-slider');
  if (slider) slider.value = focus;
  const label = document.getElementById('stack-focus-value');
  if (label) label.textContent = STACK_FOCUS_LABELS[focus];

  if (state.level !== 'stack' || !state._stackLevelOf) return;
  const gd = document.getElementById('plot');
  if (!gd || !gd.data) return;

  const markerIdx = [], markerVals = [], lineIdx = [], lineVals = [];
  state._stackLevelOf.forEach((lvl, i) => {
    const trace = gd.data[i];
    if (!trace) return;
    const dim = focus !== 0 && lvl !== focus;
    if (trace.marker) {
      if (!trace._origMarker) trace._origMarker = trace.marker;
      markerIdx.push(i);
      markerVals.push(dim
        ? { ...trace._origMarker, color: STACK_DIM_COLOR, opacity: 0.25, showscale: false }
        : trace._origMarker);
    } else if (trace.line) {
      if (!trace._origLine) trace._origLine = trace.line;
      lineIdx.push(i);
      lineVals.push(dim ? { ...trace._origLine, color: STACK_DIM_COLOR } : trace._origLine);
    }
  });
  if (markerIdx.length) Plotly.restyle(gd, { marker: markerVals }, markerIdx);
  if (lineIdx.length) Plotly.restyle(gd, { line: lineVals }, lineIdx);
}

function offsetPos(pos, dz) {
  return { x: pos.x, y: pos.y, z: pos.z.map((v) => v + dz) };
}

function connectorTrace(childPos, childOffsetPos, parentIds, parentOffsetPos, color) {
  const n = parentIds.length;
  const xs = [], ys = [], zs = [];
  for (let i = 0; i < n; i++) {
    const p = parentIds[i];
    xs.push(childOffsetPos.x[i], parentOffsetPos.x[p], null);
    ys.push(childOffsetPos.y[i], parentOffsetPos.y[p], null);
    zs.push(childOffsetPos.z[i], parentOffsetPos.z[p], null);
  }
  return { type: 'scatter3d', mode: 'lines', x: xs, y: ys, z: zs,
    line: { color, width: 1 }, hoverinfo: 'skip', showlegend: false };
}

// ---------------------------------------------------------------- drawing

// Plotly's default camera (eye at (1.25,1.25,1.25) in the axis-normalised
// cube) frames a near-cubic scene well, but this reach is roughly 700 x 500 m
// across and about 10 m tall -- aspectmode:'data' renders that at true
// relative scale, so the default eye ends up grazing the ribbon edge-on. A
// near-overhead start reads as a map on first load; the mouse still orbits
// freely from there, and any camera the user sets is kept (uirevision).
// Set from the viewer itself on 2026-09-02: the author framed the reach by
// hand and copied the camera off the readout, so these are not tuned numbers
// but a chosen view. Azimuth -93.0 deg, elevation 56.7 deg, roll 0, at an eye
// distance of 6.000 from its centre -- a high, near-overhead oblique that puts
// the whole braid in frame.
//
// NOTE THE CENTRE IS NOT THE ORIGIN. This camera was panned as well as
// orbited, so `center` carries an offset, and every distance here has to be
// measured from it rather than from (0,0,0). Two things below depend on that
// and both were written when the centre was the origin: DEFAULT_EYE_DIST and
// the eye-distance clamp in draw(). Fixed on 2026-09-02.
//
// AND NOTE the distance is 6.000 exactly, which was MAX_EYE_DIST when this
// camera was captured: it was framed by zooming out until the clamp refused to
// go further. Left as-is the reset view would open pinned against its own
// ceiling, with no room to pull back and a clamp liable to re-fire on
// floating-point drift, so MAX_EYE_DIST was raised to 12 in the same change.
//
// Do not "tidy" the decimals. They are the camera that produced the framing,
// and rounding them moves it.
const DEFAULT_CAMERA = {
  eye: { x: -1.8576416023352393, y: -3.7880951301812407, z: 4.879291812950161 },
  up: { x: 0, y: 0, z: 1 },
  center: { x: -1.687102947500927, y: -0.4948907780653177, z: -0.13326458697314078 },
  projection: { type: 'perspective' },
};

// Plotly's 3D camera has no discrete "zoom level" like a slippy map -- `eye`
// is a continuous distance from `center`, in the scene's own normalised
// units. Close enough to inspect individual superpoints, far enough out to
// see the whole reach, never so far either way that the scene degenerates.
//
// MAX was 6.0 until 2026-09-02 and is now 12.0. The default camera was framed
// at a distance of exactly 6.000, which is to say against the old ceiling, so
// keeping it there would have left the reset view unable to zoom out at all.
// At 12.0 the default has 17x of zoom IN and 2x of zoom OUT.
const MIN_EYE_DIST = 0.35;
const MAX_EYE_DIST = 12.0;

// The default eye's distance FROM ITS OWN CENTRE, used as the unit of the zoom
// factor, so that "x1.00" means the view this viewer opens at rather than
// Plotly's. Measuring it from the origin instead would only be right for a
// camera that has never been panned, and the default has been: it would report
// 3.622 against the readout's 2.677 and the reset view would open at x1.35.
const DEFAULT_EYE_DIST = Math.hypot(
  DEFAULT_CAMERA.eye.x - DEFAULT_CAMERA.center.x,
  DEFAULT_CAMERA.eye.y - DEFAULT_CAMERA.center.y,
  DEFAULT_CAMERA.eye.z - DEFAULT_CAMERA.center.z);

/* Plotly's 3D camera is a position, not a set of angles: there is no rotation
 * triple to read off it. The three angles below are derived from the eye, the
 * centre and the up vector, in the convention a reader of a map expects:
 *
 *   azimuth    compass-style rotation about the vertical, atan2(y, x)
 *   elevation  height of the eye above the horizontal plane
 *   roll       tilt of the up vector about the view axis, measured against
 *              world up, so it reads 0 for every camera this viewer sets
 *
 * Eye coordinates are in Plotly's normalised scene units, not metres: the
 * scene box is roughly [-1, 1] whatever the reach measures on the ground.
 * That is why the readout labels them "scene units" and reports a separate
 * zoom factor, which is the quantity actually worth comparing between views. */
function cameraAngles(cam) {
  const e = cam.eye, c = cam.center || { x: 0, y: 0, z: 0 };
  const u = cam.up || { x: 0, y: 0, z: 1 };
  const v = { x: e.x - c.x, y: e.y - c.y, z: e.z - c.z };
  const d = Math.hypot(v.x, v.y, v.z) || 1e-9;
  const vh = { x: v.x / d, y: v.y / d, z: v.z / d };

  const deg = (r) => r * 180 / Math.PI;
  const az = deg(Math.atan2(vh.y, vh.x));
  const el = deg(Math.asin(Math.max(-1, Math.min(1, vh.z))));

  // World up projected into the plane perpendicular to the view axis gives the
  // zero-roll reference; the roll is the signed angle from it to the camera's
  // own up. Degenerate when looking straight down, where every up is a roll.
  const dot = vh.z;                                   // (0,0,1) . vh
  let n = { x: -dot * vh.x, y: -dot * vh.y, z: 1 - dot * vh.z };
  const nl = Math.hypot(n.x, n.y, n.z);
  let roll = 0;
  if (nl > 1e-6) {
    n = { x: n.x / nl, y: n.y / nl, z: n.z / nl };
    const r = { x: vh.y * n.z - vh.z * n.y,
                y: vh.z * n.x - vh.x * n.z,
                z: vh.x * n.y - vh.y * n.x };
    const ud = u.x * vh.x + u.y * vh.y + u.z * vh.z;
    const up = { x: u.x - ud * vh.x, y: u.y - ud * vh.y, z: u.z - ud * vh.z };
    const ul = Math.hypot(up.x, up.y, up.z);
    if (ul > 1e-6) {
      roll = deg(Math.atan2((up.x * r.x + up.y * r.y + up.z * r.z) / ul,
                            (up.x * n.x + up.y * n.y + up.z * n.z) / ul));
    }
  }
  return { az, el, roll, dist: d, zoom: DEFAULT_EYE_DIST / d };
}

const f3 = (v) => (v >= 0 ? ' ' : '') + v.toFixed(3);
const fdeg = (v) => (v >= 0 ? ' ' : '') + v.toFixed(1) + '°';

function updateCameraReadout() {
  const el = document.getElementById('camera-readout');
  if (!el) return;
  const cam = state._camera || DEFAULT_CAMERA;
  const a = cameraAngles(cam);
  const e = cam.eye;
  el.innerHTML =
    `<span class="k">eye </span>${f3(e.x)} ${f3(e.y)} ${f3(e.z)}\n` +
    `<span class="k">rot </span>${fdeg(a.az)} ${fdeg(a.el)} ${fdeg(a.roll)}\n` +
    `<span class="k">zoom</span> ×${a.zoom.toFixed(2)}` +
    `<span class="k">  dist </span>${a.dist.toFixed(3)}`;
  el._copy =
    `eye x=${e.x.toFixed(4)} y=${e.y.toFixed(4)} z=${e.z.toFixed(4)}  ` +
    `azimuth=${a.az.toFixed(2)} elevation=${a.el.toFixed(2)} ` +
    `roll=${a.roll.toFixed(2)}  zoom=x${a.zoom.toFixed(3)} ` +
    `dist=${a.dist.toFixed(4)} (Plotly scene units)\n` +
    JSON.stringify(cam);
}

/* Copy on click. navigator.clipboard needs a secure context, which localhost
 * satisfies but file:// does not, and the README tells the reader they may
 * open this straight off a disk during the defence -- so the textarea route
 * is a real fallback here, not defensive habit. */
function legacyCopy(text) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (err) {
    return false;
  }
}

async function copyCamera() {
  const el = document.getElementById('camera-readout');
  const text = el._copy || '';
  let ok = false;
  // The API is tried first and its failure is NOT terminal. writeText rejects
  // with NotAllowedError whenever the click carried no user activation, and an
  // early version treated that as the end of the matter, so the fallback below
  // was unreachable in exactly the cases it existed for.
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch (err) {
      ok = false;
    }
  }
  if (!ok) ok = legacyCopy(text);
  el.classList.add('copied');
  const held = el.innerHTML;
  el.textContent = ok ? 'camera copied' : 'copy failed, select it by hand';
  setTimeout(() => {
    el.classList.remove('copied');
    el.innerHTML = held;
  }, 1100);
}

function draw(traces, axisTitles) {
  const layout = {
    paper_bgcolor: '#0b0e13', plot_bgcolor: '#0b0e13',
    margin: { l: 0, r: 0, t: 0, b: 0 },
    showlegend: true,
    /* itemsizing:'constant' is load-bearing, not decoration. Without it a
       legend swatch inherits the trace's marker.size, which here is the point
       size slider -- so at the default of 3 the legend dots were 3px beside
       11.5px text, and dragging the slider down to 1 made them vanish. The
       legend has to stay readable at every point size, so it gets its own. */
    legend: { font: { color: '#cbd5e1', size: 11.5 }, x: 0.01, y: 0.99,
      itemsizing: 'constant',
      bgcolor: '#12161ccc', bordercolor: '#2a3441', borderwidth: 1 },
    scene: {
      aspectmode: 'data',
      xaxis: axisStyle(axisTitles.x), yaxis: axisStyle(axisTitles.y), zaxis: axisStyle(axisTitles.z),
      bgcolor: '#0b0e13',
      camera: state._camera || DEFAULT_CAMERA,
    },
    uirevision: 'keep',
  };
  //  The modebar is hover-revealed and its buttons are ~20px, so on a touch
  //  screen it is a row of targets nobody can hit that sits on top of the
  //  camera readout. Orbit, pan and pinch-zoom all work by touch without it.
  const config = { displaylogo: false, responsive: true,
    displayModeBar: !isSmallScreen(),
    modeBarButtonsToRemove: ['toImage'] };

  Plotly.react('plot', traces, layout, config).then((gd) => {
    if (!state._wiredRelayout) {
      gd.on('plotly_relayout', (ev) => {
        if (!ev['scene.camera']) return;
        const cam = ev['scene.camera'];
        /* Zoom is the eye's distance from the CENTRE, and the centre moves
           whenever the user pans. Measuring |eye| from the origin instead --
           as this did until 2026-09-02 -- clamps the wrong quantity the moment
           anything is panned: it lets a genuinely too-close view through
           because the eye is still far from (0,0,0), and it trips the far
           limit early on a view panned away from it. Rescaling about the
           origin was the worse half of the same mistake, since it drags the
           camera sideways relative to what it is looking at, changing the
           framing rather than only the distance. */
        const c = cam.center || { x: 0, y: 0, z: 0 };
        const v = { x: cam.eye.x - c.x, y: cam.eye.y - c.y, z: cam.eye.z - c.z };
        const dist = Math.hypot(v.x, v.y, v.z);
        if (dist > 0 && (dist < MIN_EYE_DIST || dist > MAX_EYE_DIST)) {
          const scale = Math.min(MAX_EYE_DIST, Math.max(MIN_EYE_DIST, dist)) / dist;
          state._camera = { ...cam, eye: { x: c.x + v.x * scale,
                                           y: c.y + v.y * scale,
                                           z: c.z + v.z * scale } };
          // Re-applying the clamped eye fires another relayout, but that one
          // is already in bounds, so this does not loop.
          Plotly.relayout(gd, { 'scene.camera': state._camera });
        } else {
          state._camera = cam;
        }
        updateCameraReadout();
      });
      gd.on('plotly_click', onPointClick);
      const cr = document.getElementById('camera-readout');
      if (cr) cr.addEventListener('click', copyCamera);
      state._wiredRelayout = true;
    }
    updateCameraReadout();
  });
  state.plotted = true;
}

/** Click-to-inspect: local coordinates come straight off the trace; UTM is
 * local + ply_offset (the same offset notebook 004's QGIS export and
 * cv_predictions.csv both apply), so a point picked here can be located in
 * QGIS by the same two numbers. */
function onPointClick(ev) {
  const p = ev.points && ev.points[0];
  if (!p) return;
  const off = state.manifest.ply_offset || [0, 0];
  const utmX = p.x + off[0], utmY = p.y + off[1];
  const label = p.data.name || '';
  const extra = p.text ? `<br>${p.text}` : '';
  const el = document.getElementById('hover-readout');
  el.innerHTML =
    `<b>${label}</b>${extra}<br>` +
    `local  x ${fmt(p.x, 2)}  y ${fmt(p.y, 2)}  z ${fmt(p.z, 3)}<br>` +
    `UTM 32N  ${fmt(utmX, 2)}  ${fmt(utmY, 2)}`;
  el.classList.add('show');
}

function axisStyle(title) {
  return {
    title: { text: title, font: { color: '#5b6675', size: 11 } },
    color: '#5b6675', gridcolor: '#1d2531', zerolinecolor: '#2a3441',
    showbackground: true, backgroundcolor: '#0e1218',
    tickfont: { size: 9 },
  };
}

// ----------------------------------------------------------- 6. screenshot

/* Plotly draws the 3D scene into a WebGL canvas, and `toImage`/`downloadImage`
 * snapshot that canvas and hand back a PNG. Two consequences worth knowing
 * before using a capture in a document:
 *
 *   - It captures the PLOT ONLY. The sidebar, the stack-focus bar and the
 *     hover readout are ordinary DOM elements sitting beside or over the
 *     canvas, so they do not appear. For a figure this is usually what you
 *     want; for a screenshot that has to show the interface, use the operating
 *     system's own screen capture instead.
 *   - The colours are exactly what is on screen, dark background included.
 *     Re-rendering onto white is not offered, because the axis titles, tick
 *     labels and grid are all styled for the dark theme and would come back
 *     invisible.
 *
 * SHOT_SCALE multiplies the pixel dimensions without changing the layout, so
 * text and lines keep their proportions and the file is simply larger. At a
 * maximised window the plot is roughly 1200 px wide, so 2x lands near 2400 px
 * -- about 300 dpi across a 15 cm text block. */
const SHOT_SCALE = 2;

/** Name the file after the state that produced it, so a folder of captures can
 *  still be told apart a week later: level, stack focus, purity gate, colour
 *  mode. Shift-clicking the button overrides this with a typed name, which is
 *  how the specific file names the thesis chapters expect get produced. */
function screenshotName() {
  const parts = ['viewer'];
  parts.push(state.level === 'stack' ? 'stack' : 'P' + state.level);
  if (state.level === 'stack' && state.stackFocus > 0) {
    parts.push('focus-P' + state.stackFocus);
  }
  if (state.level === '1' && state.keptOnly) parts.push('kept');
  const on = OVERLAY_KEYS.filter((k) => state.overlayOn[k]);
  if (on.length) parts.push(on.map((k) => k.replace('river_', '')).join('-'));
  parts.push(String(state.colorBy).replace(/[^A-Za-z0-9]+/g, '-'));
  return parts.join('_');
}

async function saveScreenshot(ev) {
  const btn = document.getElementById('btn-screenshot');
  const gd = document.getElementById('plot');
  if (!state.plotted) return;

  let name = screenshotName();
  if (ev && ev.shiftKey) {
    const typed = window.prompt('Save screenshot as (without .png):', name);
    if (typed === null) return;                       // cancelled
    const cleaned = typed.trim().replace(/\.png$/i, '');
    if (cleaned) name = cleaned;
  }

  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    // Passing width/height explicitly pins the capture to the plot's current
    // size; `scale` then multiplies both. Without them Plotly falls back to
    // the layout's own width/height, which this page never sets.
    await Plotly.downloadImage(gd, {
      format: 'png',
      filename: name,
      width: gd.clientWidth,
      height: gd.clientHeight,
      scale: SHOT_SCALE,
    });
    btn.textContent = 'Saved';
  } catch (err) {
    console.error('screenshot failed', err);
    btn.textContent = 'Failed';
  }
  setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 1400);
}

// ------------------------------------------------------------------- UI

function buildColorByList() {
  const el = document.getElementById('colorby-list');
  el.innerHTML = '';
  const modes = COLOR_MODES[state.level];
  modes.forEach((m) => {
    const row = document.createElement('div');
    row.className = 'opt' + (m.key === state.colorBy ? ' active' : '');
    row.innerHTML = `<span class="swatch ${m.swatch}"></span><span>${m.label}</span>`;
    row.addEventListener('click', () => {
      state.colorBy = m.key;
      [...el.children].forEach((c) => c.classList.remove('active'));
      row.classList.add('active');
      closeDrawerAfterChoice();
      renderCurrentLevel();
    });
    el.appendChild(row);
  });
}

function updateColorByAvailability() {
  const modes = COLOR_MODES[state.level];
  if (!modes.find((m) => m.key === state.colorBy)) {
    state.colorBy = modes[0].key;
  }
  buildColorByList();

  updateLevelHint();
  document.getElementById('row-kept-only').style.display = state.level === '1' ? 'flex' : 'none';
  document.getElementById('row-gap').style.display = state.level === 'stack' ? 'flex' : 'none';
  const edgeLabelSpan = document.querySelector('#chk-edges + span');
  edgeLabelSpan.firstChild.textContent =
    state.level === 'stack' ? 'Hierarchy connectors ' : 'Adjacency edges ';
  document.getElementById('chk-edges').parentElement.style.display =
    (state.level === '0') ? 'none' : 'flex';
  document.getElementById('stack-focus-bar').classList.toggle('hidden', state.level !== 'stack');
}

/* Separate from updateColorByAvailability because it has to run TWICE per
 * render: once up front, and again once the level's data has arrived. P0's
 * count is read from the cache rather than written into the string, since a
 * small screen thins it further, and on the first render the cache is still
 * empty -- which is exactly how this first shipped saying "150,000" on a phone
 * that was drawing 37,500. */
function updateLevelHint() {
  const shown = (state.cache['0-thin'] || state.cache['0'] || {}).count;
  const thin = state.cache['0-thin'];
  const hints = {
    0: (shown ? fmtInt(shown) : '150,000') +
       (thin ? ' of 150,000 sampled voxels' : ' of 756,061 voxels') +
       ', randomly sampled for interactive framerate.' +
       (thin ? ' Thinned for this screen.' : ''),
    1: 'All 10,061 P₁ superpoints — the unit of classification.',
    2: 'All 1,756 P₂ superpoints — the parent level, ≈8 m span.',
    3: 'All 244 P₃ superpoints — the coarsest level, ≈30 m span.',
    stack: 'P₁–P₃ drawn one above another, offset by the level-spacing slider, with a line from every unit to its parent centroid.',
  };
  document.getElementById('level-hint').textContent = hints[state.level] || '';
}

function updateLegend(mode, lvl, data, mask) {
  const el = document.getElementById('legend-body');
  el.innerHTML = '';
  if (mode.key === 'rgb') {
    el.innerHTML = '<p class="hint">Photogrammetric true colour, per voxel.</p>';
    return;
  }
  const isGate = mode.key === 'kept' || mode.key === 'gate1';
  if (mode.categorical || isGate) {
    const names = isGate ? ['discarded', 'kept'] : state.manifest.class_names;
    const colors = isGate ? ['#5b6675', '#5fb3ff'] : state.manifest.class_colors;
    const arr = isGate ? data.fields[mode.key] : data.fields.class;
    if (!arr) return;
    const counts = new Array(names.length).fill(0);
    for (let i = 0; i < arr.length; i++) {
      if (mask && !mask[i]) continue;
      counts[arr[i]]++;
    }
    names.forEach((name, i) => {
      const row = document.createElement('div');
      row.className = 'legend-row';
      row.innerHTML = `<span class="sw" style="background:${colors[i]}"></span>` +
        `<span>${name}</span><b style="margin-left:auto">${fmtInt(counts[i])}</b>`;
      el.appendChild(row);
    });
    return;
  }
  if (mode.swatch === 'grad-random') {
    el.innerHTML = '<p class="hint">Colours are arbitrary — assigned to separate neighbouring units, nothing more.</p>';
    return;
  }
  // continuous
  const fixedRange = DIVERGING_RANGE[mode.key];
  const grad = fixedRange !== undefined ? 'grad-diverging' : 'grad-sequential';
  let lo, hi, note = '';
  if (fixedRange !== undefined) {
    // Table 3.4's saturation range, not the data's own min/max: a few
    // degenerate-normal outliers (see DIVERGING_RANGE above) would otherwise
    // set lo/hi and make the bar's labels disagree with what is actually
    // plotted, since the marker colour itself is clipped to this range too.
    lo = -fixedRange; hi = fixedRange;
    note = '<p class="hint">Saturated at the range Table 3.4 uses for Figure 3.5 — ' +
      'a small number of degenerate-normal points exceed it and are clipped, not hidden.</p>';
  } else {
    const values = [];
    const raw = data.fields[mode.key];
    for (let i = 0; i < raw.length; i++) { if (!mask || mask[i]) values.push(raw[i]); }
    [lo, hi] = minMax(values);
  }
  const bar = document.createElement('div');
  bar.className = `legend-bar ${grad}`;
  const labels = document.createElement('div');
  labels.className = 'legend-scale-labels';
  labels.innerHTML = `<span>${fmt(lo)}</span>${grad === 'grad-diverging' ? '<span>0</span>' : ''}<span>${fmt(hi)}</span>`;
  el.appendChild(bar);
  el.appendChild(labels);
  if (note) el.insertAdjacentHTML('beforeend', note);
}

function updateLegendStack(mode) {
  const el = document.getElementById('legend-body');
  el.innerHTML = '<p class="hint">P₁ (small) · P₂ (medium) · P₃ (large), stacked bottom to top. ' +
    (mode.key === 'class' ? 'Coloured by majority class.' :
      mode.key === 'purity' ? 'Coloured by purity.' :
        'Colours are arbitrary — one per unit.') + '</p>';
  if (mode.key === 'class') {
    state.manifest.class_names.forEach((name, i) => {
      const row = document.createElement('div');
      row.className = 'legend-row';
      row.innerHTML = `<span class="sw" style="background:${state.manifest.class_colors[i]}"></span><span>${name}</span>`;
      el.appendChild(row);
    });
  }
}

function renderStats() {
  const g = state.manifest.gate;
  const lv = state.manifest.levels;
  const el = document.getElementById('stats-body');
  const line = (label, val) => `<div class="stat-line"><span>${label}</span><b>${val}</b></div>`;
  el.innerHTML =
    line('P₀ voxels', fmtInt(lv['0'].count) + ' shown') +
    line('P₁ superpoints', fmtInt(lv['1'].count)) +
    line('P₂ superpoints', fmtInt(lv['2'].count)) +
    line('P₃ superpoints', fmtInt(lv['3'].count)) +
    line('Purity gate', `≥ ${g.min_purity}, ≥ ${g.min_voxels} vox.`) +
    line('P₁ kept', `${fmtInt(g.p1_kept)} / ${fmtInt(g.p1_total)} (${(100 * g.p1_kept / g.p1_total).toFixed(1)} %)`);

  //  An extent's checkbox is hidden entirely when that overlay has not been
  //  exported, rather than left to fail silently on click. An older data
  //  directory has no overlays key at all, and one exported before November
  //  was added has only the August entry.
  OVERLAY_KEYS.forEach((key) => {
    const ov = overlayMeta(key);
    const row = document.getElementById('row-' + key);
    if (!row) return;
    if (!ov) { row.style.display = 'none'; return; }
    const note = document.getElementById('note-' + key);
    if (note) note.textContent = `(${fmtInt(Math.round(ov.area_m2))} m²)`;
    //  The swatch takes the manifest's colour, so the sidebar key and the line
    //  in the scene cannot drift apart.
    const key_ = row.querySelector('.key');
    if (key_ && ov.color) key_.style.background = ov.color;
  });
}

function wireControls() {
  document.querySelectorAll('#level-tabs .tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#level-tabs .tab').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.level = btn.dataset.level;
      if (state.level === 'stack') state.stackFocus = 0;   // fresh entry starts at "All"
      closeDrawerAfterChoice();
      setLoading(true, 'Loading level…');
      renderCurrentLevel().finally(() => setLoading(false));
    });
  });

  document.getElementById('btn-menu').addEventListener('click', () => {
    setDrawer(!state.drawerOpen);
  });
  document.getElementById('sidebar-scrim').addEventListener('click', () => setDrawer(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.drawerOpen) setDrawer(false);
  });

  /* Leaving the small-screen regime (rotating a tablet, dragging a desktop
     window wider) must drop the drawer state, or the sidebar reappears in the
     flex row still carrying .open and its shadow. */
  /* Crossing the breakpoint changes two things a redraw owns: which P0 cache
     is used (thinned or full) and whether the modebar is drawn. Neither is
     re-evaluated by a resize on its own, so a tablet rotated into landscape
     would keep the phone's thinned cloud until the next level pick. Redrawing
     here is cheap: both caches are already in memory by then. */
  const onBreakpoint = () => {
    if (!isSmallScreen()) setDrawer(false);
    if (state.plotted) renderCurrentLevel();
  };
  if (SMALL_SCREEN.addEventListener) SMALL_SCREEN.addEventListener('change', onBreakpoint);
  else SMALL_SCREEN.addListener(onBreakpoint);        // Safari < 14

  /* Plotly's responsive:true handles width changes, but not the iOS soft
     keyboard, the URL bar collapsing on scroll, or an orientation change,
     each of which alters the visual viewport without a window resize Plotly
     acts on. A debounced explicit resize covers all three. */
  let resizeTimer = null;
  const nudge = () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (state.plotted) Plotly.Plots.resize(document.getElementById('plot'));
    }, 180);
  };
  window.addEventListener('orientationchange', nudge);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', nudge);

  document.getElementById('stack-focus-slider').addEventListener('input', (e) => {
    state.stackFocus = parseInt(e.target.value, 10);
    applyStackFocus(state.stackFocus);   // pure restyle -- no data refetch, no rebuild
  });

  document.getElementById('point-size').addEventListener('input', (e) => {
    state.pointSize = parseFloat(e.target.value);
    renderCurrentLevel();
  });
  document.getElementById('chk-edges').addEventListener('change', (e) => {
    state.showEdges = e.target.checked;
    renderCurrentLevel();
  });
  document.getElementById('chk-kept-only').addEventListener('change', (e) => {
    state.keptOnly = e.target.checked;
    renderCurrentLevel();
  });
  OVERLAY_KEYS.forEach((key) => {
    const box = document.getElementById('chk-' + key);
    if (!box) return;
    box.addEventListener('change', (e) => {
      state.overlayOn[key] = e.target.checked;
      renderCurrentLevel();
    });
  });
  document.getElementById('gap-size').addEventListener('input', (e) => {
    state.gap = parseFloat(e.target.value);
    renderCurrentLevel();
  });
  document.getElementById('btn-screenshot').addEventListener('click', saveScreenshot);
  document.getElementById('btn-reset-camera').addEventListener('click', () => {
    state._camera = undefined;
    renderCurrentLevel();
  });
  document.getElementById('btn-help').addEventListener('click', (e) => {
    e.preventDefault();
    document.getElementById('help-overlay').classList.remove('hidden');
  });
  document.getElementById('help-close').addEventListener('click', () => {
    document.getElementById('help-overlay').classList.add('hidden');
  });
  document.getElementById('help-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'help-overlay') e.target.classList.add('hidden');
  });
}

boot().catch((err) => {
  console.error(err);
  setLoading(true, `Failed to start: ${err.message}`);
});
