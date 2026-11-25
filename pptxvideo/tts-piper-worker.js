/* tts-piper-worker.js — MLApplications
 * Classic worker: Piper TTS (VITS ONNX voices) with ONNX Runtime Web + espeak-ng phonemizer (WASM).
 * Our own runner (instead of @mintplex-labs/piper-tts-web) so that we get: voice switching,
 * speaking speed (length_scale), and speaker selection for multi-speaker voices.
 *
 * Messages in:
 *   { type:'load',  id, voice: {key, files}, base }     -> { type:'loaded', id }
 *   { type:'speak', id, text, speed, speaker }           -> { type:'audio', id, pcm(Float32Array), sampleRate }
 * Progress out: { type:'progress', id, loaded, total, label }
 */
/* global ort, createPiperPhonemize */
const HERE = (self.WORKER_URL || self.location.href).replace(/[^/]*$/, '');   // started from an in-page script: its real address
const TTS_DIR = HERE + '../tts/';
importScripts(TTS_DIR + 'ort/ort.wasm.min.js', TTS_DIR + 'piper/piper_phonemize.js');

ort.env.wasm.wasmPaths = TTS_DIR + 'ort/';
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 2) - 1)) : 1;

const HF_BASE = 'https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/';
const CACHE = 'mla-piper-voices-v1';

let session = null, config = null, loadedKey = null;
let phonemizeWasm = null, phonemizeData = null;

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

/** With several threads ONNX Runtime starts extra workers from its .mjs file. A cross-origin-isolated page blocks
 *  worker files served without a Cross-Origin-Embedder-Policy header (GitHub Pages can't send one), and the
 *  runtime then waits forever. Handing it the same script as in-page code (a blob) works on any server. */
let threadScriptDone = false;
async function threadScript() {
  if (threadScriptDone || ort.env.wasm.numThreads <= 1) return;
  threadScriptDone = true;
  try {
    const r = await fetch(TTS_DIR + 'ort/ort-wasm-simd-threaded.mjs');
    if (!r.ok) throw new Error(r.status);
    const mjs = URL.createObjectURL(new Blob([await r.text()], { type: 'text/javascript' }));
    ort.env.wasm.wasmPaths = { mjs, wasm: TTS_DIR + 'ort/ort-wasm-simd-threaded.wasm' };
  } catch (e) { ort.env.wasm.numThreads = 1; }       // no thread script: one thread still works
}

async function ensurePhonemizer() {
  if (phonemizeWasm) return;
  const [w, d] = await Promise.all([
    fetch(TTS_DIR + 'piper/piper_phonemize.wasm').then(r => r.arrayBuffer()),
    fetch(TTS_DIR + 'piper/piper_phonemize.data').then(r => r.arrayBuffer()),
  ]);
  phonemizeWasm = w; phonemizeData = d;
}

/** espeak-ng phonemes for several sentences in ONE phonemizer run → [{ phonemes:[…], phoneme_ids:[…] }]. */
async function phonemeIdsMany(texts, espeakVoice) {
  await ensurePhonemizer();
  return await new Promise((resolve, reject) => {
    const out = [];
    createPiperPhonemize({
      wasmBinary: phonemizeWasm,
      getPreloadedPackage: () => phonemizeData,
      print: (line) => { try { out.push(JSON.parse(line)); } catch {} },
      printErr: () => {},
      locateFile: (u) => TTS_DIR + 'piper/' + u,
    }).then((m) => {
      try {
        m.callMain(['-l', espeakVoice, '--input', JSON.stringify(texts.map(text => ({ text }))), '--espeak_data', '/espeak-ng-data']);
        if (out.length === texts.length) resolve(out); else reject(new Error('Phonemizer returned ' + out.length + '/' + texts.length));
      } catch (e) { reject(e); }
    }, reject);
  });
}

async function load(id, voice, base) {
  if (loadedKey === voice.key && session) return;
  const files = Object.keys(voice.files || {});
  const model = files.find(f => f.endsWith('.onnx'));
  const cfg = files.find(f => f.endsWith('.onnx.json'));
  if (!model || !cfg) throw new Error('Voice has no model files: ' + voice.key);
  const root = base || HF_BASE;
  config = JSON.parse(new TextDecoder().decode(await cachedFetch(root + cfg)));
  const size = voice.files[model]?.size_bytes || 0;
  const buf = await cachedFetch(root + model, (got, total) =>
    postMessage({ type: 'progress', id, loaded: got, total: total || size, label: voice.key }));
  await threadScript();
  session = await ort.InferenceSession.create(buf, { executionProviders: ['wasm'] });
  loadedKey = voice.key;
  await ensurePhonemizer();
}

/**
 * Phonemes → ids with the VOICE's own table (config.phoneme_id_map), exactly like Piper:
 * "^", then id + "_" for every phoneme, then "$". Phonemes the voice does not know are skipped
 * (e.g. the combining cedilla of Greek "ç" for voices with the older 130-symbol table).
 * Without a table, the phonemizer's ids are used, minus any beyond the model's symbol count.
 */
function voiceIds(ph) {
  const map = config.phoneme_id_map;
  if (!map) {
    const n = config.num_symbols || 256;
    return ph.phoneme_ids.filter(i => i < n);
  }
  const pad = map['_'] || [0];
  const ids = [...(map['^'] || [1])];
  for (const p of ph.phonemes || []) if (map[p]) ids.push(...map[p], ...pad);
  ids.push(...(map['$'] || [2]));
  return ids;
}

/** Split long notes into sentences so each inference stays small. */
function sentences(text) {
  const parts = text.replace(/\s+/g, ' ').match(/[^.!?;:…。]+[.!?;:…。]*\s*/g) || [text];
  return parts.map(s => s.trim()).filter(Boolean);
}

async function speak(id, text, speed = 1, speaker = 0) {
  if (!session || !config) throw new Error('No Piper voice loaded');
  const sr = config.audio.sample_rate;
  const inf = config.inference || {};
  const scales = new Float32Array([inf.noise_scale ?? 0.667, (inf.length_scale ?? 1) / Math.max(0.3, speed), inf.noise_w ?? 0.8]);
  const multi = Object.keys(config.speaker_id_map || {}).length > 0;
  const gap = new Float32Array(Math.round(sr * 0.18));     // short pause between sentences
  const chunks = [];
  const list = sentences(text);
  let offset = 0;
  const allIds = await phonemeIdsMany(list, config.espeak.voice);
  for (let k = 0; k < list.length; k++) {
    if (cancelled.has(id)) { cancelled.delete(id); throw new Error('Cancelled'); }
    postMessage({ type: 'progress', id, label: 'sentence', index: k + 1, total: list.length, text: list[k] });
    const t0 = performance.now();
    const ids = voiceIds(allIds[k]);
    const feeds = {
      input: new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
      input_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(ids.length)]), [1]),
      scales: new ort.Tensor('float32', scales, [3]),
    };
    if (multi) feeds.sid = new ort.Tensor('int64', BigInt64Array.from([BigInt(speaker || 0)]), [1]);
    const res = await session.run(feeds);
    const start = offset / sr;
    chunks.push(res.output.data, gap);
    offset += res.output.data.length + gap.length;
    postMessage({ type: 'progress', id, label: 'sentence-done', index: k + 1, total: list.length, text: list[k],
      ms: performance.now() - t0, start, audioSec: res.output.data.length / sr, chars: list[k].length });
  }
  const len = chunks.reduce((s, c) => s + c.length, 0);
  const pcm = new Float32Array(len);
  let o = 0;
  for (const c of chunks) { pcm.set(c, o); o += c.length; }
  return { pcm, sampleRate: sr };
}

const cancelled = new Set();
self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'cancel') { cancelled.add(m.target); return; }
  try {
    if (m.type === 'load') {
      await load(m.id, m.voice, m.base);
      postMessage({ type: 'loaded', id: m.id });
    } else if (m.type === 'speak') {
      const { pcm, sampleRate } = await speak(m.id, m.text, m.speed, m.speaker);
      postMessage({ type: 'audio', id: m.id, pcm, sampleRate }, [pcm.buffer]);
    }
  } catch (err) {
    postMessage({ type: 'error', id: m.id, message: String(err?.message || err) });
  }
};
