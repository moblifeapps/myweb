/**
 * pptx-video.js — MLApplications
 *
 * Turns a loaded pptx-browser PptxRenderer into a video:
 *   • per-shape entrance / exit / emphasis animations (layered rendering)
 *   • slide transitions (uses the package's renderTransitionFrame)
 *   • optional background video (transparent slide, inset frame or blend)
 *   • fast export with WebCodecs + Mediabunny, or real-time playback/recording
 *
 * Requires the patched pptx-browser renderSlide(index, canvas, width, opts) with
 * opts.background / opts.masterShapes / opts.filter.
 */

import { renderTransitionFrame } from '../pptxpackage/pptxsrc/index.js';

// ── Mediabunny (loaded only when the fast exporter is used) ──────────────────
let mbPromise = null;
export function loadMediabunny() {
  if (!mbPromise) mbPromise = import('../mediabunny/mediabunny.min.mjs');
  return mbPromise;
}
export function webCodecsAvailable() {
  return typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined';
}

// ── Small XML helpers ────────────────────────────────────────────────────────
const SHAPE_TAGS = new Set(['sp', 'pic', 'grpSp', 'graphicFrame', 'cxnSp']);
function child(node, name) {
  if (!node) return null;
  for (const c of node.children) if (c.localName === name) return c;
  return null;
}
function desc(node, name) {
  if (!node) return [];
  const out = [];
  const all = node.getElementsByTagName('*');
  for (let i = 0; i < all.length; i++) if (all[i].localName === name) out.push(all[i]);
  return out;
}
function ms(v) {
  if (v == null || v === 'indefinite') return 0;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}
/** Start delay of a cTn: <p:stCondLst><p:cond delay="…"/> (falls back to a delay attribute). */
function delayOf(cTn) {
  const cond = child(child(cTn, 'stCondLst'), 'cond');
  return ms(cond ? cond.getAttribute('delay') : cTn.getAttribute('delay'));
}
function slideDoc(renderer, i) {
  const data = renderer._files?.[renderer.slidePaths[i]];
  if (!data) return null;
  return new DOMParser().parseFromString(new TextDecoder().decode(data), 'application/xml');
}

// ── Animation timeline (PowerPoint presetClass / presetID) ───────────────────
const ENTR_KIND = {
  1: 'appear', 2: 'fly', 3: 'wipe', 4: 'zoom', 5: 'dissolve', 6: 'circle', 7: 'fly', 8: 'circle',
  9: 'dissolve', 10: 'fade', 12: 'fly', 14: 'dissolve', 16: 'split', 17: 'zoom', 18: 'wipe',
  21: 'circle', 22: 'wipe', 23: 'zoom', 26: 'bounce', 37: 'float', 42: 'float', 47: 'floatDown', 53: 'zoom',
};
const EMPH_KIND = { 8: 'spin' };
const SUBTYPE_DIR = { 1: 't', 2: 'r', 4: 'b', 8: 'l', 3: 'r', 6: 'r', 9: 'l', 12: 'l' };

/**
 * Parse the main animation sequence of a slide.
 * @returns {{ groups: Array<{click:boolean, effects:object[]}> }}
 */
export function parseSlideAnimations(renderer, slideIndex) {
  const doc = slideDoc(renderer, slideIndex);
  if (!doc) return { groups: [] };
  const timing = desc(doc, 'timing')[0];
  if (!timing) return { groups: [] };
  const main = desc(timing, 'cTn').find(c => c.getAttribute('nodeType') === 'mainSeq');
  const lst = child(main, 'childTnLst');
  if (!lst) return { groups: [] };

  const groups = [];
  for (const par of lst.children) {
    if (par.localName !== 'par') continue;
    const effects = [];
    walkPar(par, 0, effects);
    if (effects.length) groups.push({ click: effects[0].nodeType === 'clickEffect', effects });
  }
  return { groups };
}

function walkPar(par, acc, out) {
  const cTn = child(par, 'cTn');
  if (!cTn) return;
  const start = acc + delayOf(cTn);
  const presetClass = cTn.getAttribute('presetClass');
  if (presetClass) {
    // One effect: duration = latest end of its behaviours
    let end = 1;
    for (const b of desc(cTn, 'cTn')) {
      const dur = b.getAttribute('dur');
      if (dur && dur !== 'indefinite') end = Math.max(end, delayOf(b) + ms(dur));
    }
    const spTgt = desc(cTn, 'spTgt')[0];
    if (!spTgt) return;
    const id = parseInt(cTn.getAttribute('presetID') || '0', 10);
    const sub = parseInt(cTn.getAttribute('presetSubtype') || '0', 10);
    let kind = 'fade';
    if (presetClass === 'entr' || presetClass === 'exit') kind = ENTR_KIND[id] || 'fade';
    else if (presetClass === 'emph') kind = EMPH_KIND[id] || 'pulse';
    else return; // motion paths / media / verbs are not supported
    out.push({
      spid: spTgt.getAttribute('spid'),
      cls: presetClass, kind,
      dir: SUBTYPE_DIR[sub] || (kind === 'wipe' ? 'b' : 'b'),
      nodeType: cTn.getAttribute('nodeType') || '',
      start, dur: Math.max(1, end),
    });
    return;
  }
  const lst = child(cTn, 'childTnLst');
  if (!lst) return;
  for (const c of lst.children) if (c.localName === 'par') walkPar(c, start, out);
}

/** Flatten groups into absolute times (ms from slide start). */
function buildTimeline(groups, clickGapMs) {
  let t = 0;
  const effects = [];
  for (const g of groups) {
    if (g.click) t += clickGapMs;
    const gStart = t;
    for (const e of g.effects) {
      effects.push({ ...e, abs: gStart + e.start });
      t = Math.max(t, gStart + e.start + e.dur);
    }
  }
  return { effects, end: t };
}

// ── Easing ───────────────────────────────────────────────────────────────────
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
function easeBounce(t) {
  const n = 7.5625, d = 2.75;
  if (t < 1 / d) return n * t * t;
  if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
  if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
  return n * (t -= 2.625 / d) * t + 0.984375;
}

// ── Scenes (layered slide renders) ───────────────────────────────────────────
function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function alphaBBox(canvas) {
  const { width: w, height: h } = canvas;
  const data = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    for (let x = 0; x < w; x++) {
      if (data[row + x * 4 + 3] > 2) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/**
 * Render a slide into layers: static runs (in z-order) + one cropped layer per animated shape.
 * @param {object} opts { width, transparent, animate, clickGapMs }
 */
export async function buildScene(renderer, slideIndex, opts) {
  const { width, transparent = false, animate = true, clickGapMs = 500 } = opts;
  const doc = slideDoc(renderer, slideIndex);
  const spTree = doc ? desc(desc(doc, 'cSld')[0], 'spTree')[0] : null;

  // Top-level shapes and a map from any nested cNvPr id → top-level id
  const top = [];
  const idToTop = new Map();
  if (spTree) {
    for (const el of spTree.children) {
      if (!SHAPE_TAGS.has(el.localName)) continue;
      const id = desc(el, 'cNvPr')[0]?.getAttribute('id') ?? null;
      top.push({ el, id });
      for (const n of desc(el, 'cNvPr')) idToTop.set(n.getAttribute('id'), id);
    }
  }

  // Animation timeline, effects grouped by top-level shape
  let timeline = { effects: [], end: 0 };
  if (animate) timeline = buildTimeline(parseSlideAnimations(renderer, slideIndex).groups, clickGapMs);
  const effectsByShape = new Map();
  for (const e of timeline.effects) {
    const tid = idToTop.get(e.spid);
    if (tid == null) continue;
    if (!effectsByShape.has(tid)) effectsByShape.set(tid, []);
    effectsByShape.get(tid).push(e);
  }
  for (const list of effectsByShape.values()) list.sort((a, b) => a.abs - b.abs);

  const layers = [];
  let w = width, h = 0;

  if (!effectsByShape.size) {
    const c = makeCanvas(1, 1);
    await renderer.renderSlide(slideIndex, c, width, { background: !transparent });
    layers.push({ type: 'static', canvas: c });
    w = c.width; h = c.height;
  } else {
    // Split into z-ordered runs: [static ids] | animated id | [static ids] ...
    const runs = [{ type: 'static', ids: new Set(), base: true }];
    for (const s of top) {
      if (effectsByShape.has(s.id)) runs.push({ type: 'anim', id: s.id });
      else {
        let last = runs[runs.length - 1];
        if (last.type !== 'static') { last = { type: 'static', ids: new Set(), base: false }; runs.push(last); }
        last.ids.add(s.id);
      }
    }
    const tmp = makeCanvas(1, 1);
    tmp.getContext('2d', { willReadFrequently: true });   // we read it back to find each shape's bounds
    for (const r of runs) {
      if (r.type === 'static') {
        if (!r.base && !r.ids.size) continue;
        const c = makeCanvas(1, 1);
        await renderer.renderSlide(slideIndex, c, width, {
          background: r.base && !transparent,
          masterShapes: r.base,
          filter: (_el, id) => r.ids.has(id),
        });
        w = c.width; h = c.height;
        layers.push({ type: 'static', canvas: c });
      } else {
        await renderer.renderSlide(slideIndex, tmp, width, {
          background: false, masterShapes: false, filter: (_el, id) => id === r.id,
        });
        w = tmp.width; h = tmp.height;
        const bb = alphaBBox(tmp);
        if (!bb) continue;
        const c = makeCanvas(bb.w, bb.h);
        c.getContext('2d').drawImage(tmp, bb.x, bb.y, bb.w, bb.h, 0, 0, bb.w, bb.h);
        layers.push({ type: 'anim', canvas: c, ...bb, effects: effectsByShape.get(r.id) });
      }
    }
  }
  return { index: slideIndex, w, h, layers, animEnd: timeline.end, effectCount: timeline.effects.length };
}

function shapeState(effects, t) {
  let visible = effects[0]?.cls !== 'entr';
  let settled = visible;
  let fx = null;
  for (const e of effects) {
    if (t < e.abs) break;
    const p = Math.min(1, (t - e.abs) / e.dur);
    if (e.cls === 'entr') {
      if (settled) continue;              // already on screen (e.g. paragraph builds)
      visible = true;
      if (p < 1) fx = { e, p, mode: 'in' }; else { fx = null; settled = true; }
    } else if (e.cls === 'exit') {
      if (!visible) continue;
      if (p < 1) fx = { e, p, mode: 'out' }; else { visible = false; settled = false; fx = null; }
    } else {
      fx = visible && p < 1 ? { e, p, mode: 'emph' } : null;
    }
  }
  return { visible, fx };
}

function drawAnimLayer(ctx, L, t, W, H, deco = null) {
  const { visible, fx } = shapeState(L.effects, t);
  if (!visible) return;
  if (!fx) {
    if (deco && L.panels) drawPanels(ctx, L.panels, L.x, L.y, deco, 0, 0);
    ctx.drawImage(L.canvas, L.x, L.y);
    return;
  }

  const kind = fx.e.kind, dir = fx.e.dir;
  const p = fx.mode === 'out' ? 1 - fx.p : fx.p;   // amount "shown"
  const e = fx.mode === 'emph' ? fx.p : (fx.mode === 'in' ? easeOut(p) : easeInOut(p));
  let alpha = 1, dx = 0, dy = 0, sc = 1, rot = 0, clip = null;

  switch (kind) {
    case 'appear': if (fx.mode === 'out') alpha = 0; break;
    case 'fade': case 'dissolve': alpha = p; break;
    case 'fly':
      if (dir === 'l') dx = -(L.x + L.w) * (1 - e);
      else if (dir === 'r') dx = (W - L.x) * (1 - e);
      else if (dir === 't') dy = -(L.y + L.h) * (1 - e);
      else dy = (H - L.y) * (1 - e);
      break;
    case 'bounce': dy = -(L.y + L.h) * (1 - (fx.mode === 'in' ? easeBounce(p) : e)); break;
    case 'float': alpha = p; dy = H * 0.08 * (1 - e); break;
    case 'floatDown': alpha = p; dy = -H * 0.08 * (1 - e); break;
    case 'zoom': sc = Math.max(0.01, e); alpha = Math.min(1, p * 1.5); break;
    case 'wipe': {
      const k = e;
      if (dir === 'l') clip = [L.x, L.y, L.w * k, L.h];
      else if (dir === 'r') clip = [L.x + L.w * (1 - k), L.y, L.w * k, L.h];
      else if (dir === 't') clip = [L.x, L.y, L.w, L.h * k];
      else clip = [L.x, L.y + L.h * (1 - k), L.w, L.h * k];
      break;
    }
    case 'split': clip = [L.x + L.w * (1 - e) / 2, L.y, L.w * e, L.h]; break;
    case 'circle': clip = 'circle'; break;
    case 'spin': rot = Math.PI * 2 * easeInOut(fx.p); break;
    case 'pulse': sc = 1 + 0.1 * Math.sin(Math.PI * fx.p); break;
    default: alpha = p;
  }
  if (alpha <= 0) return;

  const cx = L.x + L.w / 2, cy = L.y + L.h / 2;
  ctx.save();
  ctx.globalAlpha = alpha;
  if (clip) {
    ctx.beginPath();
    if (clip === 'circle') ctx.arc(cx, cy, Math.hypot(L.w, L.h) / 2 * e, 0, Math.PI * 2);
    else ctx.rect(clip[0], clip[1], clip[2], clip[3]);
    ctx.clip();
  }
  ctx.translate(cx + dx, cy + dy);
  if (rot) ctx.rotate(rot);
  if (sc !== 1) ctx.scale(sc, sc);
  // panels follow the shape; their blurred backdrop is aligned for moves (approximate while scaling/rotating)
  if (deco && L.panels) drawPanels(ctx, L.panels, -L.w / 2, -L.h / 2, deco, cx + dx, cy + dy);
  ctx.drawImage(L.canvas, -L.w / 2, -L.h / 2);
  ctx.restore();
}

/** Draw a scene at time t (ms from slide start) onto ctx (cleared first). */
export function drawScene(ctx, scene, t, deco = null) {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  for (const L of scene.layers) {
    if (L.type === 'static') {
      const x = L.x || 0, y = L.y || 0;
      if (deco && L.panels) drawPanels(ctx, L.panels, x, y, deco, 0, 0);
      ctx.drawImage(L.canvas, x, y);
    } else drawAnimLayer(ctx, L, t, scene.w, scene.h, deco);
  }
}

// ── Text readability over video ──────────────────────────────────────────────
const FILTER_OK = (() => {
  try { const c = document.createElement('canvas').getContext('2d'); c.filter = 'blur(2px)'; return c.filter === 'blur(2px)'; }
  catch { return false; }
})();
const DARK_LUM = 140;   // pixels darker than this get a light halo, lighter ones a dark halo
const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/**
 * "Contrast silhouette": same alpha as the layer, colour white where the content is dark and
 * black where it is light. Halos drawn from it always contrast with the pixel they surround.
 */
function contrastSilhouette(src, pad) {
  const w = src.width, h = src.height;
  const sctx = src.getContext('2d', { willReadFrequently: true });
  const img = sctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    if (!d[i + 3]) continue;
    const c = lum(d[i], d[i + 1], d[i + 2]) < DARK_LUM ? 255 : 0;
    d[i] = d[i + 1] = d[i + 2] = c;
  }
  const sil = makeCanvas(w + pad * 2, h + pad * 2);
  sil.getContext('2d').putImageData(img, pad, pad);
  return sil;
}

/** Returns a new, padded canvas: halo (outline / shadow / glow) + the original on top. */
function haloLayer(src, mode, k, W) {
  const u = W / 1920;                                   // scale effects with output size
  const pad = Math.ceil(u * 14 * Math.max(k, 0.2)) + 2;
  const sil = contrastSilhouette(src, pad);
  const out = makeCanvas(sil.width, sil.height);
  const o = out.getContext('2d');
  const ring = (r, n, alpha = 1) => {
    o.globalAlpha = alpha;
    for (let a = 0; a < n; a++) {
      const ang = (a / n) * Math.PI * 2;
      o.drawImage(sil, Math.cos(ang) * r, Math.sin(ang) * r);
    }
    o.globalAlpha = 1;
  };
  const blurred = (b, times, dx = 0, dy = 0) => {
    if (FILTER_OK) {
      o.filter = `blur(${b}px)`;
      for (let i = 0; i < times; i++) o.drawImage(sil, dx, dy);
      o.filter = 'none';
    } else {                                             // fallback: soft multi-ring
      for (let r = b; r > 0; r -= Math.max(1, b / 3)) ring(r, 16, 0.25);
    }
  };
  if (mode === 'outline') {
    ring(Math.max(1, Math.round(u * 3 * k)), 16);
  } else if (mode === 'shadow') {
    blurred(Math.max(1, u * 7 * k), 2, u * 2.5 * k, u * 2.5 * k);
  } else {                                               // auto: soft glow + hairline edge
    blurred(Math.max(1, u * 6 * k), 2);
    ring(Math.max(1, Math.round(u * 1.2 * k)), 12, 0.9);
  }
  o.drawImage(src, pad, pad);
  return { canvas: out, pad };
}

/** Find blocks of content (text boxes etc.) in a layer → rounded panel rectangles. */
function contentPanels(src, W) {
  const cell = Math.max(4, Math.round(W / 240));
  const gw = Math.ceil(src.width / cell), gh = Math.ceil(src.height / cell);
  const small = makeCanvas(gw, gh);
  const sc = small.getContext('2d', { willReadFrequently: true });
  sc.drawImage(src, 0, 0, gw, gh);
  const d = sc.getImageData(0, 0, gw, gh).data;
  const occ = new Uint8Array(gw * gh);
  for (let i = 0; i < gw * gh; i++) if (d[i * 4 + 3] > 10) occ[i] = 1;
  // dilate so letters/lines of one text box join into a block
  const dil = new Uint8Array(gw * gh), R = 2;
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    if (!occ[y * gw + x]) continue;
    for (let yy = Math.max(0, y - R); yy <= Math.min(gh - 1, y + R); yy++)
      for (let xx = Math.max(0, x - R); xx <= Math.min(gw - 1, x + R); xx++) dil[yy * gw + xx] = 1;
  }
  const seen = new Uint8Array(gw * gh);
  let boxes = [];
  for (let i = 0; i < gw * gh; i++) {
    if (!dil[i] || seen[i]) continue;
    let x0 = gw, y0 = gh, x1 = 0, y1 = 0, lumSum = 0, lumN = 0;
    const stack = [i];
    seen[i] = 1;
    while (stack.length) {
      const j = stack.pop(), x = j % gw, y = (j / gw) | 0;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (occ[j]) { lumSum += lum(d[j * 4], d[j * 4 + 1], d[j * 4 + 2]); lumN++; }
      for (const n of [j - 1, j + 1, j - gw, j + gw]) {
        if (n < 0 || n >= gw * gh || seen[n] || !dil[n]) continue;
        if ((n === j - 1 && x === 0) || (n === j + 1 && x === gw - 1)) continue;
        seen[n] = 1; stack.push(n);
      }
    }
    if ((x1 - x0) < 2 && (y1 - y0) < 2) continue;
    boxes.push({ x: x0 * cell, y: y0 * cell, w: (x1 - x0 + 1) * cell, h: (y1 - y0 + 1) * cell,
      darkText: lumN ? lumSum / lumN < DARK_LUM : false });
  }
  // merge overlapping boxes
  for (let merged = true; merged;) {
    merged = false;
    outer: for (let a = 0; a < boxes.length; a++) for (let b = a + 1; b < boxes.length; b++) {
      const A = boxes[a], B = boxes[b];
      if (A.x < B.x + B.w && B.x < A.x + A.w && A.y < B.y + B.h && B.y < A.y + A.h) {
        const x = Math.min(A.x, B.x), y = Math.min(A.y, B.y);
        boxes[a] = { x, y, w: Math.max(A.x + A.w, B.x + B.w) - x, h: Math.max(A.y + A.h, B.y + B.h) - y, darkText: A.darkText && B.darkText };
        boxes.splice(b, 1); merged = true; break outer;
      }
    }
  }
  return boxes.map(b => ({ ...b, r: Math.round(cell * 1.5) }));
}

/**
 * Frosted-glass panels under content. ox/oy = layer origin in the current ctx;
 * wx/wy = where ctx's origin sits in frame space (0,0 when untransformed).
 */
function drawPanels(ctx, panels, ox, oy, deco, wx, wy) {
  for (const p of panels) {
    ctx.save();
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(ox + p.x, oy + p.y, p.w, p.h, p.r); else ctx.rect(ox + p.x, oy + p.y, p.w, p.h);
    ctx.clip();
    ctx.drawImage(deco.src, -wx, -wy, deco.W, deco.H);
    ctx.fillStyle = p.darkText ? `rgba(255,255,255,${deco.tint})` : `rgba(0,0,0,${deco.tint})`;
    ctx.fillRect(ox + p.x, oy + p.y, p.w, p.h);
    ctx.strokeStyle = p.darkText ? 'rgba(255,255,255,.35)' : 'rgba(255,255,255,.18)';
    ctx.lineWidth = Math.max(1, deco.W / 1600);
    ctx.stroke();
    ctx.restore();
  }
}

/** Apply readability to all layers of a scene (once per scene). */
export function decorateScene(scene, mode, k) {
  if (!mode || mode === 'off') return scene;
  for (const L of scene.layers) {
    if (mode === 'frosted') { L.panels = contentPanels(L.canvas, scene.w); continue; }
    const { canvas, pad } = haloLayer(L.canvas, mode, k, scene.w);
    L.canvas = canvas;
    if (L.type === 'static') { L.x = -pad; L.y = -pad; }
    else { L.x -= pad; L.y -= pad; L.w += pad * 2; L.h += pad * 2; }
  }
  return scene;
}

/** Play one slide's animations on a canvas (viewer preview). */
export async function previewSlide(renderer, slideIndex, canvas, { width = 1280, clickGapMs = 500, signal } = {}) {
  const scene = await buildScene(renderer, slideIndex, { width, animate: true, clickGapMs });
  canvas.width = scene.w; canvas.height = scene.h;
  const ctx = canvas.getContext('2d');
  const total = scene.animEnd + 300;
  await new Promise((resolve) => {
    let start = null;
    const tick = (now) => {
      if (signal?.aborted) return resolve();
      if (start === null) start = now;
      const t = now - start;
      drawScene(ctx, scene, Math.min(t, total));
      if (t >= total) return resolve();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  return scene;
}

// ── Background video helpers ─────────────────────────────────────────────────
function drawCover(ctx, src, sw, sh, W, H) {
  if (!sw || !sh) return;
  const s = Math.max(W / sw, H / sh);
  const w = sw * s, h = sh * s;
  ctx.drawImage(src, (W - w) / 2, (H - h) / 2, w, h);
}

/** Sequential frame reader for the fast exporter (Mediabunny CanvasSink). `file` = File/Blob or URL string. */
class BgReader {
  constructor(file, W, H, loop) { this.file = file; this.W = W; this.H = H; this.loop = loop; }
  async init() {
    const { Input, BlobSource, UrlSource, ALL_FORMATS, CanvasSink } = await loadMediabunny();
    // A URL string streams from the server with HTTP range requests (no full download first)
    const source = typeof this.file === 'string'
      ? new UrlSource(this.file, { maxCacheSize: 32 * 1024 * 1024, parallelism: 2 })
      : new BlobSource(this.file);
    this.input = new Input({ source, formats: ALL_FORMATS });
    const track = await this.input.getPrimaryVideoTrack();
    if (!track) throw new Error('The background file has no video track.');
    if (!(await track.canDecode())) throw new Error('This browser cannot decode the background video codec.');
    this.dur = await track.computeDuration();
    this.sink = new CanvasSink(track, { width: this.W, height: this.H, fit: 'cover', poolSize: 4 });
  }
  async _restart() {
    if (this.it) await this.it.return?.();
    this.it = this.sink.canvases(0);
    this.cur = (await this.it.next()).value || null;
    this.nxt = (await this.it.next()).value || null;
    this.last = 0;
  }
  async at(t) {
    if (!this.dur) return null;
    const tt = this.loop ? t % this.dur : Math.min(t, this.dur - 0.001);
    if (!this.it || tt < this.last) await this._restart();
    this.last = tt;
    while (this.nxt && this.nxt.timestamp <= tt) {
      this.cur = this.nxt;
      this.nxt = (await this.it.next()).value || null;
    }
    return this.cur?.canvas || null;
  }
  async close() { try { await this.it?.return?.(); } catch {} try { this.input?.dispose?.(); } catch {} }
}

// ── The composer ─────────────────────────────────────────────────────────────
/**
 * settings = {
 *   width, fps, holdMs, clickGapMs, animate,
 *   transition: { choice: 'file'|'fade'|..., ms },
 *   bg: { file: File|null, mode: 'none'|'transparent'|'inset'|'blend', scale: 0.8, opacity: 0.85, loop: true }
 * }
 */
export class PptxVideo {
  constructor(renderer, settings) {
    this.r = renderer;
    this.s = settings;
    const aspect = renderer.getInfo().aspectRatio;
    this.W = settings.width;
    this.slideH = Math.round(this.W / aspect);
    this.H = this.slideH + (this.slideH % 2);         // encoders want even sizes
    this.out = makeCanvas(this.W, this.H);
    this.frame = makeCanvas(this.W, this.slideH);     // composed slide (may be transparent)
    this.tA = makeCanvas(this.W, this.slideH);
    this.tB = makeCanvas(this.W, this.slideH);
    this.scenes = new Map();
    this.hasBg = !!(settings.bg?.file && settings.bg.mode !== 'none');
    this.transparent = this.hasBg && settings.bg.mode === 'transparent';
    // readability only matters when slide content sits directly on the video
    const rd = settings.readability || { mode: 'off', strength: 0.6 };
    this.readMode = this.transparent ? rd.mode : 'off';
    this.readK = Math.max(0, Math.min(1, rd.strength ?? 0.6));
    if (this.readMode === 'frosted') {
      this.blurSmall = makeCanvas(Math.max(2, Math.round(this.W / 4)), Math.max(2, Math.round(this.slideH / 4)));
      this.deco = { src: this.blurSmall, W: this.W, H: this.slideH, tint: 0.15 + 0.35 * this.readK };
    }
    this.segs = this._plan();
    this.totalMs = this.segs.reduce((s, x) => s + x.ms, 0);
  }

  _transition(i) {
    const { choice, ms: len } = this.s.transition;
    if (choice === 'file') {
      const t = this.r.getTransition(i);
      return t ? { ...t, duration: t.duration || len } : { type: 'fade', duration: len, dir: 'l' };
    }
    return { type: choice, duration: choice === 'cut' ? 0 : len, dir: 'l' };
  }

  _plan() {
    const segs = [];
    let t0 = 0;
    for (let i = 0; i < this.r.slideCount; i++) {
      if (i > 0) {
        const t = this._transition(i);
        if (t.duration > 0 && t.type !== 'cut') { segs.push({ kind: 'trans', from: i - 1, to: i, t, ms: t.duration, t0 }); t0 += t.duration; }
      }
      const animEnd = this.s.animate
        ? buildTimeline(parseSlideAnimations(this.r, i).groups, this.s.clickGapMs).end : 0;
      const len = animEnd + this.s.holdMs;
      segs.push({ kind: 'slide', i, ms: len, t0 });
      t0 += len;
    }
    return segs;
  }

  async _scene(i) {
    if (!this.scenes.has(i)) {
      this.scenes.set(i, buildScene(this.r, i, {
        width: this.W, transparent: this.transparent, animate: this.s.animate, clickGapMs: this.s.clickGapMs,
      }).then(sc => decorateScene(sc, this.readMode, this.readK)));
    }
    return this.scenes.get(i);
  }
  async _ensure(seg) {
    const need = seg.kind === 'slide' ? [seg.i] : [seg.from, seg.to];
    for (const k of [...this.scenes.keys()]) if (!need.includes(k)) this.scenes.delete(k);
    const got = [];
    for (const i of need) got.push(await this._scene(i));
    if (seg.kind === 'trans') {
      // static "from" (end state) and "to" (start state) for the transition
      drawScene(this.tA.getContext('2d'), got[0], Number.MAX_SAFE_INTEGER, this.deco);
      drawScene(this.tB.getContext('2d'), got[1], 0, this.deco);
    }
    seg.scene = got[got.length - 1];
  }

  /** Compose the output frame for a segment at local time t (ms); bgSrc = canvas/video or null. */
  _compose(seg, t, bgSrc, bgW, bgH) {
    // frosted panels: a small blurred copy of the current background frame
    if (this.deco && bgSrc) {
      const b = this.blurSmall.getContext('2d');
      if (FILTER_OK) b.filter = `blur(${Math.max(1, 2 + 4 * this.readK)}px)`;
      drawCover(b, bgSrc, bgW, bgH, this.blurSmall.width, this.blurSmall.height);
      b.filter = 'none';
    }
    const fctx = this.frame.getContext('2d');
    if (seg.kind === 'slide') drawScene(fctx, seg.scene, t, this.deco);
    else renderTransitionFrame(fctx, this.tA, this.tB, seg.t, Math.min(1, t / seg.ms));

    const ctx = this.out.getContext('2d');
    const { W, H } = this;
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    if (this.hasBg && bgSrc) drawCover(ctx, bgSrc, bgW, bgH, W, H);
    if (this.readMode === 'auto' && this.readK > 0) {      // gentle overall dim of the footage
      ctx.fillStyle = `rgba(0,0,0,${0.3 * this.readK})`;
      ctx.fillRect(0, 0, W, H);
    }

    const mode = this.hasBg ? this.s.bg.mode : 'none';
    if (mode === 'inset') {
      const k = this.s.bg.scale;
      const w = W * k, h = H * k, x = (W - w) / 2, y = (H - h) / 2;
      const r = Math.round(W * 0.012);
      ctx.shadowColor = 'rgba(0,0,0,.55)';
      ctx.shadowBlur = W * 0.02;
      ctx.shadowOffsetY = W * 0.006;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h);
      ctx.fillStyle = '#000';
      ctx.fill();
      ctx.shadowColor = 'transparent';
      ctx.clip();
      ctx.drawImage(this.frame, x, y, w, h);
    } else {
      if (mode === 'blend') ctx.globalAlpha = this.s.bg.opacity;
      ctx.drawImage(this.frame, 0, 0, W, H);
    }
    ctx.restore();
  }

  /**
   * Render one finished slide (all animations done) over a still background
   * (an <img>, canvas or paused <video>) into this.out. Used for instant previews.
   */
  async renderStill(slideIndex, bgSrc = null) {
    const seg = { kind: 'slide', i: slideIndex, ms: 1, t0: 0 };
    await this._ensure(seg);
    const w = bgSrc?.naturalWidth || bgSrc?.videoWidth || bgSrc?.width || 0;
    const h = bgSrc?.naturalHeight || bgSrc?.videoHeight || bgSrc?.height || 0;
    this._compose(seg, Number.MAX_SAFE_INTEGER, bgSrc, w, h);
    return this.out;
  }

  /**
   * Real-time playback onto this.out (preview or MediaRecorder recording).
   * hooks: { recorder?, bgVideo? (HTMLVideoElement, playing), signal?, onProgress?(ms,total,slide) }
   */
  async playRealtime({ recorder = null, bgVideo = null, signal = null, onProgress = null } = {}) {
    for (const seg of this.segs) {
      if (signal?.aborted) return false;
      // Rendering the next scene can take a moment: pause recording meanwhile
      if (recorder?.state === 'recording') recorder.pause();
      bgVideo?.pause();
      await this._ensure(seg);
      if (signal?.aborted) return false;
      this._compose(seg, 0, bgVideo, bgVideo?.videoWidth, bgVideo?.videoHeight);
      if (bgVideo) await bgVideo.play().catch(() => {});
      if (recorder?.state === 'paused') recorder.resume();

      await new Promise((resolve) => {
        let start = null;
        const tick = (now) => {
          if (signal?.aborted) return resolve();
          if (start === null) start = now;
          const t = Math.min(now - start, seg.ms);
          this._compose(seg, t, bgVideo, bgVideo?.videoWidth, bgVideo?.videoHeight);
          onProgress?.(seg.t0 + t, this.totalMs, seg.kind === 'slide' ? seg.i : seg.to);
          if (t >= seg.ms) return resolve();
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
    }
    return !signal?.aborted;
  }

  /**
   * Fast export with WebCodecs + Mediabunny. Returns a Blob, or null if cancelled.
   * opts: { container: 'mp4'|'webm', signal?, onProgress?(doneFrames,totalFrames,slide) }
   */
  async exportFast({ container = 'mp4', signal = null, onProgress = null } = {}) {
    const MB = await loadMediabunny();
    const { Output, BufferTarget, Mp4OutputFormat, WebMOutputFormat, CanvasSource, QUALITY_HIGH, getFirstEncodableVideoCodec } = MB;
    const candidates = container === 'mp4' ? ['avc', 'hevc', 'vp9', 'av1'] : ['vp9', 'vp8', 'av1'];
    const codec = await getFirstEncodableVideoCodec(candidates, { width: this.W, height: this.H });
    if (!codec) throw new Error(`No ${container.toUpperCase()} video encoder is available in this browser.`);

    const output = new Output({
      format: container === 'mp4' ? new Mp4OutputFormat({ fastStart: 'in-memory' }) : new WebMOutputFormat(),
      target: new BufferTarget(),
    });
    const source = new CanvasSource(this.out, { codec, quality: QUALITY_HIGH, keyFrameInterval: 2 });
    output.addVideoTrack(source, { frameRate: this.s.fps });
    await output.start();

    let bg = null;
    if (this.hasBg) { bg = new BgReader(this.s.bg.file, this.W, this.H, this.s.bg.loop); await bg.init(); }

    const fps = this.s.fps;
    const totalFrames = Math.max(1, Math.round(this.totalMs / 1000 * fps));
    let n = 0;
    try {
      for (const seg of this.segs) {
        await this._ensure(seg);
        const segEnd = seg.t0 + seg.ms;
        while (n < totalFrames && (n * 1000 / fps) < segEnd) {
          if (signal?.aborted) { await output.cancel(); return null; }
          const tGlobal = n * 1000 / fps;
          const bgCanvas = bg ? await bg.at(tGlobal / 1000) : null;
          this._compose(seg, tGlobal - seg.t0, bgCanvas, bgCanvas?.width, bgCanvas?.height);
          await source.add(n / fps, 1 / fps);
          n++;
          if (n % 5 === 0) onProgress?.(n, totalFrames, seg.kind === 'slide' ? seg.i : seg.to);
        }
      }
      source.close?.();
      await output.finalize();
    } finally {
      await bg?.close();
    }
    onProgress?.(totalFrames, totalFrames, this.r.slideCount - 1);
    return new Blob([output.target.buffer], { type: container === 'mp4' ? 'video/mp4' : 'video/webm' });
  }
}
