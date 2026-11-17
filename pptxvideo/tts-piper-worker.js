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
const HERE = self.location.href.replace(/[^/]*$/, '');
const TTS_DIR = HERE + '../tts/';
importScripts(TTS_DIR + 'ort/ort.wasm.min.js', TTS_DIR + 'piper/piper_phonemize.js');

ort.env.wasm.wasmPaths = TTS_DIR + 'ort/';
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;

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

async function ensurePhonemizer() {
  if (phonemizeWasm) return;
  const [w, d] = await Promise.all([
    fetch(TTS_DIR + 'piper/piper_phonemize.wasm').then(r => r.arrayBuffer()),
    fetch(TTS_DIR + 'piper/piper_phonemize.data').then(r => r.arrayBuffer()),
  ]);
  phonemizeWasm = w; phonemizeData = d;
}

/** espeak-ng phonemes → Piper phoneme ids (one emscripten instance per call, like the reference app). */
async function phonemeIds(text, espeakVoice) {
  await ensurePhonemizer();
  return await new Promise((resolve, reject) => {
    let out = null;
    createPiperPhonemize({
      wasmBinary: phonemizeWasm,
      getPreloadedPackage: () => phonemizeData,
      print: (line) => { try { out = JSON.parse(line).phoneme_ids; } catch {} },
      printErr: () => {},
      locateFile: (u) => TTS_DIR + 'piper/' + u,
    }).then((m) => {
      try {
        m.callMain(['-l', espeakVoice, '--input', JSON.stringify([{ text }]), '--espeak_data', '/espeak-ng-data']);
        if (out) resolve(out); else reject(new Error('Phonemizer returned nothing'));
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
  session = await ort.InferenceSession.create(buf, { executionProviders: ['wasm'] });
  loadedKey = voice.key;
  await ensurePhonemizer();
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
  for (let k = 0; k < list.length; k++) {
    const ids = await phonemeIds(list[k], config.espeak.voice);
    const feeds = {
      input: new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
      input_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(ids.length)]), [1]),
      scales: new ort.Tensor('float32', scales, [3]),
    };
    if (multi) feeds.sid = new ort.Tensor('int64', BigInt64Array.from([BigInt(speaker || 0)]), [1]);
    const res = await session.run(feeds);
    chunks.push(res.output.data, gap);
    postMessage({ type: 'progress', id, loaded: k + 1, total: list.length, label: 'speaking' });
  }
  const len = chunks.reduce((s, c) => s + c.length, 0);
  const pcm = new Float32Array(len);
  let o = 0;
  for (const c of chunks) { pcm.set(c, o); o += c.length; }
  return { pcm, sampleRate: sr };
}

self.onmessage = async (e) => {
  const m = e.data;
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
