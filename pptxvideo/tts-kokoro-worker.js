/* tts-kokoro-worker.js — MLApplications
 * Module worker: Kokoro-82M (English, US/UK voices) via kokoro-js (transformers.js + ONNX Runtime Web).
 * The model downloads once from Hugging Face and is cached by the browser.
 *
 * Messages in:
 *   { type:'load',  id, dtype:'q8'|'fp32'|..., device:'wasm'|'webgpu' } -> { type:'loaded', id, voices }
 *   { type:'speak', id, text, voice, speed }                           -> { type:'audio', id, pcm, sampleRate }
 * Progress out: { type:'progress', id, loaded, total, label }
 */
import { KokoroTTS } from '../tts/kokoro/kokoro.web.js';

const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
let tts = null, loadedKey = '';

async function load(id, dtype, device) {
  const key = dtype + '|' + device;
  if (tts && loadedKey === key) return;
  const files = new Map();
  tts = await KokoroTTS.from_pretrained(MODEL, {
    dtype, device,
    progress_callback: (p) => {
      if (p.status === 'progress' && p.file) {
        files.set(p.file, { loaded: p.loaded || 0, total: p.total || 0 });
        let loaded = 0, total = 0;
        for (const f of files.values()) { loaded += f.loaded; total += f.total; }
        postMessage({ type: 'progress', id, loaded, total, label: 'Kokoro model' });
      }
    },
  });
  loadedKey = key;
}

/** Sentence split (Kokoro is limited to ~510 tokens per call; sentences also give us progress). */
function sentences(text) {
  const parts = text.replace(/\s+/g, ' ').match(/[^.!?;:…]+[.!?;:…]*["')\]]*\s*/g) || [text];
  const out = [];
  for (let p of parts.map(x => x.trim()).filter(Boolean)) {
    while (p.length > 350) {                       // very long sentence: cut at a comma or space
      let cut = p.lastIndexOf(', ', 350); if (cut < 120) cut = p.lastIndexOf(' ', 350); if (cut < 60) cut = 350;
      out.push(p.slice(0, cut + 1).trim()); p = p.slice(cut + 1).trim();
    }
    if (p) out.push(p);
  }
  return out;
}

async function speak(id, text, voice, speed) {
  if (!tts) throw new Error('Kokoro is not loaded');
  const list = sentences(text);
  const chunks = [];
  let sr = 24000;
  for (let k = 0; k < list.length; k++) {
    postMessage({ type: 'progress', id, label: 'sentence', index: k + 1, total: list.length, text: list[k] });
    const t0 = performance.now();
    const a = await tts.generate(list[k], { voice, speed });
    sr = a.sampling_rate || sr;
    chunks.push(a.audio, new Float32Array(Math.round(sr * 0.12)));
    postMessage({ type: 'progress', id, label: 'sentence-done', index: k + 1, total: list.length,
      ms: performance.now() - t0, audioSec: a.audio.length / sr, chars: list[k].length });
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
      await load(m.id, m.dtype || 'q8', m.device || 'wasm');
      const voices = Object.entries(tts.voices).map(([key, v]) => ({ key, ...v }));
      postMessage({ type: 'loaded', id: m.id, voices });
    } else if (m.type === 'speak') {
      const { pcm, sampleRate } = await speak(m.id, m.text, m.voice, m.speed ?? 1);
      postMessage({ type: 'audio', id: m.id, pcm, sampleRate }, [pcm.buffer]);
    }
  } catch (err) {
    postMessage({ type: 'error', id: m.id, message: String(err?.message || err) });
  }
};
