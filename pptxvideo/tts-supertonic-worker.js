/* tts-supertonic-worker.js — MLApplications
 * Classic worker: Supertonic 3 (Supertone, 31 languages incl. Greek, 10 voices) with ONNX Runtime Web.
 * Pipeline follows the official browser example (MIT): duration predictor → text encoder →
 * flow-matching vector estimator (N denoising steps) → vocoder, 44.1 kHz.
 * Model weights: BigScience OpenRAIL-M (Supertone Inc.). Loaded from ../tts/supertonic/ when you host
 * a copy, otherwise from the archived Hugging Face snapshot.
 *
 * Messages in:
 *   { type:'load',  id, device:'wasm'|'webgpu' }                 -> { type:'loaded', id, device }
 *   { type:'speak', id, text, voice:'M1'..'F5', lang, speed, steps } -> { type:'audio', id, pcm, sampleRate }
 *   { type:'cancel', target }
 * Progress out: { type:'progress', id, loaded, total, label } and per-sentence progress like the other engines.
 */
/* global ort */
const HERE = self.location.href.replace(/[^/]*$/, '');
const TTS_DIR = HERE + '../tts/';
const LOCAL_BASE = TTS_DIR + 'supertonic/';
const HF_BASE = 'https://huggingface.co/supertone-oss-archive/supertonic-3/resolve/aafc6e32416a594460b32413efc49d7fe4ce6d46/';
const CACHE = 'mla-supertonic3-v1';
const LANGS = ['en', 'ko', 'ja', 'ar', 'bg', 'cs', 'da', 'de', 'el', 'es', 'et', 'fi', 'fr', 'hi', 'hr', 'hu', 'id', 'it',
  'lt', 'lv', 'nl', 'pl', 'pt', 'ro', 'ru', 'sk', 'sl', 'sv', 'tr', 'uk', 'vi', 'na'];
const FILES = [
  ['onnx/duration_predictor.onnx', 'duration predictor'],
  ['onnx/text_encoder.onnx', 'text encoder'],
  ['onnx/vector_estimator.onnx', 'vector estimator'],
  ['onnx/vocoder.onnx', 'vocoder'],
];

let ortDevice = null;           // which ORT bundle was imported ('wasm' | 'webgpu')
let base = null, cfg = null, indexer = null, sess = null, device = null;
const styles = new Map();
const cancelled = new Set();

function importOrt(dev) {
  if (ortDevice) return;
  importScripts(TTS_DIR + 'ort/' + (dev === 'webgpu' ? 'ort.webgpu.min.js' : 'ort.wasm.min.js'));
  ort.env.wasm.wasmPaths = TTS_DIR + 'ort/';
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 2) - 1)) : 1;
  ortDevice = dev;
}

async function cachedFetch(url, onProgress) {
  let cache = null;
  try { cache = await caches.open(CACHE); const hit = await cache.match(url); if (hit) return await hit.arrayBuffer(); } catch {}
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Download failed (${r.status}): ${url}`);
  const total = +r.headers.get('content-length') || 0;
  const reader = r.body.getReader();
  const parts = []; let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value); got += value.length;
    onProgress?.(got, total);
  }
  const blob = new Blob(parts);
  try { await cache?.put(url, new Response(blob)); } catch {}
  return await blob.arrayBuffer();
}
const json = async (url) => JSON.parse(new TextDecoder().decode(await cachedFetch(url)));

async function pickBase() {
  if (base) return base;
  try { const r = await fetch(LOCAL_BASE + 'onnx/tts.json', { method: 'HEAD' }); if (r.ok) return (base = LOCAL_BASE); } catch {}
  return (base = HF_BASE);
}

async function load(id, dev) {
  if (sess && device === dev) return device;
  importOrt(dev);
  if (dev === 'webgpu' && ortDevice !== 'webgpu') throw new Error('Restart needed to switch to the GPU.');
  const root = await pickBase();
  cfg = await json(root + 'onnx/tts.json');
  indexer = await json(root + 'onnx/unicode_indexer.json');
  const opts = { executionProviders: dev === 'webgpu' ? ['webgpu', 'wasm'] : ['wasm'], graphOptimizationLevel: 'all' };
  const out = [];
  for (const [file, label] of FILES) {
    const buf = await cachedFetch(root + file, (got, total) =>
      postMessage({ type: 'progress', id, loaded: got, total, label: 'Supertonic ' + label }));
    out.push(await ort.InferenceSession.create(buf, opts));
  }
  if (sess) for (const s of Object.values(sess)) { try { await s.release(); } catch {} }
  sess = { dp: out[0], enc: out[1], est: out[2], voc: out[3] };
  device = dev;
  return device;
}

async function style(name) {
  if (styles.has(name)) return styles.get(name);
  const s = await json((await pickBase()) + `voice_styles/${name}.json`);
  const t = (o) => new ort.Tensor('float32', Float32Array.from(o.data.flat(Infinity)), o.dims);
  const st = { ttl: t(s.style_ttl), dp: t(s.style_dp) };
  styles.set(name, st);
  return st;
}

/** Same text normalisation as the official example. */
function preprocess(text, lang) {
  text = text.normalize('NFKD');
  text = text.replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]+/gu, '');
  const rep = { '–': '-', '‑': '-', '—': '-', '_': ' ', '“': '"', '”': '"', '‘': "'", '’': "'", '´': "'", '`': "'",
    '[': ' ', ']': ' ', '|': ' ', '/': ' ', '#': ' ', '→': ' ', '←': ' ' };
  for (const [k, v] of Object.entries(rep)) text = text.replaceAll(k, v);
  text = text.replace(/[♥☆♡©\\]/g, '');
  for (const [k, v] of Object.entries({ '@': ' at ', 'e.g.,': 'for example, ', 'i.e.,': 'that is, ' })) text = text.replaceAll(k, v);
  text = text.replace(/ ([,.!?;:'])/g, '$1');
  while (text.includes('""')) text = text.replace('""', '"');
  while (text.includes("''")) text = text.replace("''", "'");
  text = text.replace(/\s+/g, ' ').trim();
  if (!/[.!?;:,'"')\]}…。」』】〉》›»]$/.test(text)) text += '.';
  if (!LANGS.includes(lang)) lang = 'na';
  return `<${lang}>${text}</${lang}>`;
}

function gauss() {
  const u1 = Math.max(0.0001, Math.random()), u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** One chunk of text → Float32Array samples. */
async function infer(text, lang, st, steps, speed) {
  const t = preprocess(text, lang);
  const n = t.length;
  const ids = new BigInt64Array(n);
  for (let j = 0; j < n; j++) { const cp = t.codePointAt(j); ids[j] = BigInt(cp < indexer.length ? indexer[cp] : -1); }
  const textIds = new ort.Tensor('int64', ids, [1, n]);
  const textMask = new ort.Tensor('float32', new Float32Array(n).fill(1), [1, 1, n]);

  const dp = await sess.dp.run({ text_ids: textIds, style_dp: st.dp, text_mask: textMask });
  const dur = dp.duration.data[0] / speed;
  const enc = await sess.enc.run({ text_ids: textIds, style_ttl: st.ttl, text_mask: textMask });

  const sr = cfg.ae.sample_rate;
  const wavLen = Math.floor(dur * sr);
  const chunk = cfg.ae.base_chunk_size * cfg.ttl.chunk_compress_factor;
  const L = Math.max(1, Math.ceil(wavLen / chunk));
  const D = cfg.ttl.latent_dim * cfg.ttl.chunk_compress_factor;
  let xt = new Float32Array(D * L);
  for (let k = 0; k < xt.length; k++) xt[k] = gauss();
  const latentMask = new ort.Tensor('float32', new Float32Array(L).fill(1), [1, 1, L]);
  const total = new ort.Tensor('float32', new Float32Array([steps]), [1]);
  for (let s = 0; s < steps; s++) {
    const out = await sess.est.run({
      noisy_latent: new ort.Tensor('float32', xt, [1, D, L]), text_emb: enc.text_emb, style_ttl: st.ttl,
      latent_mask: latentMask, text_mask: textMask,
      current_step: new ort.Tensor('float32', new Float32Array([s]), [1]), total_step: total,
    });
    xt = new Float32Array(out.denoised_latent.data);
  }
  const voc = await sess.voc.run({ latent: new ort.Tensor('float32', xt, [1, D, L]) });
  const wav = voc.wav_tts.data;
  return wav.slice(0, Math.min(wav.length, wavLen));
}

/** Sentences of at most 300 characters (120 for Korean/Japanese). */
function sentences(text, max) {
  const parts = text.replace(/\s+/g, ' ').match(/[^.!?;:…。]+[.!?;:…。]*["')\]»]*\s*/g) || [text];
  const out = [];
  for (let p of parts.map(x => x.trim()).filter(Boolean)) {
    while (p.length > max) {
      let cut = p.lastIndexOf(', ', max); if (cut < max * 0.4) cut = p.lastIndexOf(' ', max); if (cut < max * 0.2) cut = max;
      out.push(p.slice(0, cut + 1).trim()); p = p.slice(cut + 1).trim();
    }
    if (p) out.push(p);
  }
  return out;
}

async function speak(id, text, voice = 'F1', lang = 'en', speed = 1, steps = 8) {
  if (!sess) throw new Error('Supertonic is not loaded');
  const st = await style(voice);
  const sr = cfg.ae.sample_rate;
  const sp = 1.05 * Math.max(0.5, speed);           // 1.05 = the model's own default pace
  const list = sentences(text, lang === 'ko' || lang === 'ja' ? 120 : 300);
  const gap = new Float32Array(Math.round(sr * 0.22));
  const chunks = [];
  let offset = 0;
  for (let k = 0; k < list.length; k++) {
    if (cancelled.has(id)) { cancelled.delete(id); throw new Error('Cancelled'); }
    postMessage({ type: 'progress', id, label: 'sentence', index: k + 1, total: list.length, text: list[k] });
    const t0 = performance.now();
    const wav = await infer(list[k], lang, st, steps, sp);
    const start = offset / sr;
    chunks.push(wav, gap);
    offset += wav.length + gap.length;
    postMessage({ type: 'progress', id, label: 'sentence-done', index: k + 1, total: list.length, text: list[k],
      ms: performance.now() - t0, start, audioSec: wav.length / sr, chars: list[k].length });
  }
  const pcm = new Float32Array(offset);
  let o = 0;
  for (const c of chunks) { pcm.set(c, o); o += c.length; }
  return { pcm, sampleRate: sr };
}

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'cancel') { cancelled.add(m.target); return; }
  try {
    if (m.type === 'load') {
      const dev = await load(m.id, m.device || 'wasm');
      postMessage({ type: 'loaded', id: m.id, device: dev });
    } else if (m.type === 'speak') {
      const { pcm, sampleRate } = await speak(m.id, m.text, m.voice, m.lang, m.speed, m.steps);
      postMessage({ type: 'audio', id: m.id, pcm, sampleRate }, [pcm.buffer]);
    }
  } catch (err) {
    postMessage({ type: 'error', id: m.id, message: String(err?.message || err) });
  }
};
