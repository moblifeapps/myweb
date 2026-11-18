/**
 * tts.js — MLApplications
 * Main-thread client for the two TTS workers + helpers for slide notes and audio clips.
 *
 *   const tts = new TtsClient();
 *   const voices = await tts.voices('piper');                  // or 'kokoro' (loads the model)
 *   await tts.load('piper', voice, onProgress);
 *   const buf = await tts.speak('piper', { text, speed, speaker }, audioCtx);   // -> AudioBuffer
 */
import { getRels } from '../pptxpackage/pptxsrc/render.js';

// Known Piper voice genders (the voice list has no gender field). Unknown → ''.
const PIPER_GENDER = {
  'en_US-amy': 'F', 'en_US-lessac': 'F', 'en_US-kristin': 'F', 'en_US-kathleen': 'F', 'en_US-ljspeech': 'F',
  'en_US-hfc_female': 'F', 'en_US-ryan': 'M', 'en_US-joe': 'M', 'en_US-danny': 'M', 'en_US-hfc_male': 'M',
  'en_US-kusal': 'M', 'en_US-john': 'M', 'en_US-norman': 'M', 'en_GB-alan': 'M', 'en_GB-alba': 'F', 'en_GB-cori': 'F',
  'en_GB-jenny_dioco': 'F', 'en_GB-northern_english_male': 'M', 'en_GB-southern_english_female': 'F',
  'el_GR-rapunzelina': 'F', 'de_DE-thorsten': 'M', 'de_DE-thorsten_emotional': 'M', 'de_DE-eva_k': 'F',
  'de_DE-kerstin': 'F', 'de_DE-ramona': 'F', 'de_DE-karlsson': 'M', 'de_DE-pavoque': 'M', 'fr_FR-siwis': 'F',
  'fr_FR-gilles': 'M', 'fr_FR-tom': 'M', 'es_ES-davefx': 'M', 'es_ES-carlfm': 'M', 'es_MX-ald': 'M',
  'es_MX-claude': 'M', 'it_IT-riccardo': 'M', 'it_IT-paola': 'F', 'pt_BR-faber': 'M', 'pt_BR-edresson': 'M',
  'ru_RU-irina': 'F', 'ru_RU-denis': 'M', 'ru_RU-dmitri': 'M', 'ru_RU-ruslan': 'M', 'nl_NL-mls': '',
  'pl_PL-gosia': 'F', 'pl_PL-darkman': 'M', 'tr_TR-fettah': 'M', 'tr_TR-fahrettin': 'M', 'uk_UA-lada': 'F',
  'ro_RO-mihai': 'M', 'hu_HU-anna': 'F', 'hu_HU-berta': 'F', 'hu_HU-imre': 'M', 'sv_SE-nst': 'M',
  'fi_FI-harri': 'M', 'cs_CZ-jirka': 'M', 'zh_CN-huayan': 'F',
};

export class TtsClient {
  constructor() {
    this.workers = {};
    this.pending = new Map();
    this.seq = 0;
    this.kokoroVoices = null;
    this.piperList = null;
  }

  _worker(engine) {
    if (!this.workers[engine]) {
      const w = engine === 'kokoro'
        ? new Worker(new URL('./tts-kokoro-worker.js', import.meta.url), { type: 'module' })
        : new Worker(new URL('./tts-piper-worker.js', import.meta.url));
      w.onmessage = (e) => {
        const m = e.data, p = this.pending.get(m.id);
        if (!p) return;
        if (m.type === 'progress') { p.onProgress?.(m); return; }
        this.pending.delete(m.id);
        if (m.type === 'error') {
          const net = /failed to fetch|networkerror|load failed|download failed/i.test(m.message);
          p.reject(new Error(net
            ? 'Could not download the voice model from Hugging Face – check the internet connection and try again.'
            : m.message));
        } else p.resolve(m);
      };
      w.onerror = (e) => {
        for (const [id, p] of this.pending) { p.reject(new Error(e.message || 'TTS worker failed')); this.pending.delete(id); }
      };
      this.workers[engine] = w;
    }
    return this.workers[engine];
  }

  _call(engine, msg, onProgress, transfer) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress, engine });
      this._worker(engine).postMessage({ ...msg, id }, transfer || []);
    });
  }

  /** Piper voice list: live from Hugging Face, falling back to the copy next to the page. */
  async piperVoices() {
    if (this.piperList) return this.piperList;
    let list = null;
    try {
      const r = await fetch('https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/voices.json');
      if (r.ok) list = Object.values(await r.json());
    } catch {}
    if (!list) list = await (await fetch(new URL('../tts/piper/voices.json', import.meta.url))).json();
    this.piperList = list.map(v => {
      const base = v.key.replace(/-(x_low|low|medium|high)$/, '');
      return { ...v, gender: PIPER_GENDER[base] || '' };
    }).sort((a, b) => a.key.localeCompare(b.key));
    return this.piperList;
  }

  /** Load a model. Kokoro: opts = {dtype, device}; Piper: opts = voice object from piperVoices(). */
  async load(engine, opts, onProgress) {
    if (engine === 'kokoro') {
      const m = await this._call('kokoro', { type: 'load', dtype: opts.dtype, device: opts.device }, onProgress);
      this.kokoroVoices = m.voices;
      return m.voices;
    }
    await this._call('piper', { type: 'load', voice: { key: opts.key, files: opts.files } }, onProgress);
    return null;
  }

  /** Synthesize text → AudioBuffer (mono). */
  async speak(engine, { text, voice, speed = 1, speaker = 0 }, audioCtx, onProgress) {
    const m = await this._call(engine, { type: 'speak', text, voice, speed, speaker }, onProgress);
    return pcmToBuffer(m.pcm, m.sampleRate, audioCtx);
  }

  /**
   * Cancel what an engine is generating: the promise rejects at once with "Cancelled",
   * and the worker stops before its next sentence.
   */
  cancel(engine) {
    const w = this.workers[engine];
    if (!w) return;
    for (const [id, p] of this.pending) {
      if (p.engine !== engine) continue;
      w.postMessage({ type: 'cancel', target: id });
      this.pending.delete(id);
      p.reject(new Error('Cancelled'));
    }
  }
}

export function pcmToBuffer(pcm, sampleRate, audioCtx) {
  const buf = (audioCtx && audioCtx.createBuffer)
    ? audioCtx.createBuffer(1, Math.max(1, pcm.length), sampleRate)
    : new AudioBuffer({ length: Math.max(1, pcm.length), sampleRate, numberOfChannels: 1 });
  buf.copyToChannel(pcm, 0);
  return buf;
}

/** Make notes friendlier for TTS: drop URLs/bullets/odd symbols, keep sentences. */
export function cleanForSpeech(text) {
  return (text || '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/^[\s•▪▸►‣◦\-–—*]+/gm, '')
    .replace(/[“”«»]/g, '"')
    .replace(/\s*\n+\s*/g, '. ')
    .replace(/\.{2,}/g, '.')
    .replace(/\.\s*\./g, '.')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Speaker notes of a slide with paragraph breaks kept (the package's getSlideNotes() glues
 * paragraphs together without spaces).
 */
export async function slideNotes(renderer, i) {
  const files = renderer._files, path = renderer.slidePaths[i];
  if (!files || !path) return '';
  const rels = await getRels(files, path);
  const rel = Object.values(rels).find(r => r.type?.includes('notesSlide'));
  const data = rel && files[rel.fullPath];
  if (!data) return '';
  const doc = new DOMParser().parseFromString(new TextDecoder().decode(data), 'application/xml');
  const all = (n, name) => [...n.getElementsByTagName('*')].filter(e => e.localName === name);
  const paras = [];
  for (const sp of all(doc, 'sp')) {
    const ph = all(sp, 'ph')[0];
    const type = ph?.getAttribute('type');
    if (type && type !== 'body') continue;          // skip slide image, slide number, header/footer
    for (const p of all(sp, 'p')) {
      const t = all(p, 't').map(x => x.textContent).join('');
      if (t.trim()) paras.push(t.trim());
    }
  }
  return paras.join('\n');
}
