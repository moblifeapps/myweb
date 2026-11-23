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
        for (const [id, p] of this.pending) { if (p.engine !== engine) continue; p.reject(new Error(e.message || 'TTS worker failed')); this.pending.delete(id); }
        this.reset(engine);
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
   * Throw an engine's worker away (its WebAssembly memory goes with it). The next call starts a fresh one,
   * which reads the model from the browser cache – no new download.
   */
  reset(engine) {
    const w = this.workers[engine];
    if (!w) return;
    for (const [id, p] of this.pending) if (p.engine === engine) { this.pending.delete(id); p.reject(new Error('Cancelled')); }
    try { w.terminate(); } catch {}
    delete this.workers[engine];
    if (engine === 'kokoro') this.kokoroVoices = null;
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
    .replace(/\[(smile|happy|serious|surprised|neutral)\]/gi, ' ')   // AI-avatar expression tags are not spoken
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

/**
 * Text written ON slide i, in natural reading order (top → bottom, left → right),
 * ready to use as narration. Boxes side by side (overlapping vertically) are read left to right;
 * tables row by row; slide number, date and footer placeholders are skipped.
 */
export async function slideText(renderer, i) {
  const files = renderer._files, path = renderer.slidePaths[i];
  if (!files || !path) return '';
  const dec = (p) => files[p] ? new DOMParser().parseFromString(new TextDecoder().decode(files[p]), 'application/xml') : null;
  const kids = (n, name) => n ? [...n.children].filter(e => e.localName === name) : [];
  const kid = (n, name) => kids(n, name)[0] || null;
  const all = (n, name) => n ? [...n.getElementsByTagName('*')].filter(e => e.localName === name) : [];
  const num = (e, a) => +(e?.getAttribute(a) || 0);

  const slide = dec(path);
  if (!slide) return '';
  // placeholder positions inherited from the layout and the master
  const rels = await getRels(files, path);
  const layoutRel = Object.values(rels).find(r => r.type?.includes('slideLayout'));
  const layout = layoutRel && dec(layoutRel.fullPath);
  let master = null;
  if (layoutRel) {
    const lr = await getRels(files, layoutRel.fullPath);
    const mr = Object.values(lr).find(r => r.type?.includes('slideMaster'));
    master = mr && dec(mr.fullPath);
  }
  const phInfo = (sp) => { const ph = all(kid(sp, 'nvSpPr') || sp, 'ph')[0]; return ph ? { type: ph.getAttribute('type') || 'body', idx: ph.getAttribute('idx') } : null; };
  const findPh = (doc, ph) => {
    if (!doc) return null;
    const list = all(doc, 'sp').map(sp => ({ sp, p: phInfo(sp) })).filter(x => x.p);
    return (ph.idx != null && list.find(x => x.p.idx === ph.idx)) || list.find(x => x.p.type === ph.type)
      || (/^(ctrTitle|title)$/.test(ph.type) && list.find(x => /title/i.test(x.p.type))) || null;
  };
  const xfrmOf = (sp) => all(kid(sp, 'spPr') || kid(sp, 'grpSpPr') || sp, 'xfrm')[0] || kid(sp, 'xfrm');
  const boxOf = (sp) => {
    let x = xfrmOf(sp);
    if (!x || !kid(x, 'off')) {
      const ph = phInfo(sp);
      if (ph) for (const d of [layout, master]) { const m = findPh(d, ph); x = m && xfrmOf(m.sp); if (x && kid(x, 'off')) break; }
    }
    if (!x || !kid(x, 'off')) return null;
    const off = kid(x, 'off'), ext = kid(x, 'ext');
    return { x: num(off, 'x'), y: num(off, 'y'), w: num(ext, 'cx'), h: num(ext, 'cy') };
  };
  const paraText = (p) => all(p, 't').map(t => t.textContent).join('').replace(/\s+/g, ' ').trim();
  const finish = (t) => /[.!?;:…»"”)]$/.test(t) ? t : t + '.';     // a pause after every title / bullet

  const items = [];
  const walk = (tree, map) => {
    for (const el of tree.children) {
      const n = el.localName;
      if (n === 'grpSp') {
        const x = xfrmOf(el);
        const off = kid(x, 'off'), ext = kid(x, 'ext'), co = kid(x, 'chOff'), ce = kid(x, 'chExt');
        const sx = num(ce, 'cx') ? num(ext, 'cx') / num(ce, 'cx') : 1, sy = num(ce, 'cy') ? num(ext, 'cy') / num(ce, 'cy') : 1;
        walk(el, (b) => map({ x: num(off, 'x') + (b.x - num(co, 'x')) * sx, y: num(off, 'y') + (b.y - num(co, 'y')) * sy, w: b.w * sx, h: b.h * sy }));
      } else if (n === 'sp') {
        const ph = phInfo(el);
        if (ph && /^(sldNum|dt|ftr|hdr)$/.test(ph.type)) continue;
        const body = kid(el, 'txBody');
        const lines = kids(body, 'p').map(paraText).filter(Boolean);
        if (!lines.length) continue;
        const b = boxOf(el);
        items.push({ ...(b ? map(b) : { x: 0, y: 1e12, w: 0, h: 0 }), text: lines.map(finish).join('\n') });
      } else if (n === 'graphicFrame') {
        const tbl = all(el, 'tbl')[0];
        if (!tbl) continue;
        const rows = all(tbl, 'tr').map(tr => all(tr, 'tc').map(tc => kids(kid(tc, 'txBody'), 'p').map(paraText).filter(Boolean).join(' ')).filter(Boolean).join(', '))
          .filter(Boolean).map(finish);
        if (!rows.length) continue;
        const x = kid(el, 'xfrm'), off = kid(x, 'off'), ext = kid(x, 'ext');
        items.push({ ...map({ x: num(off, 'x'), y: num(off, 'y'), w: num(ext, 'cx'), h: num(ext, 'cy') }), text: rows.join('\n') });
      }
    }
  };
  const tree = all(slide, 'spTree')[0];
  if (!tree) return '';
  walk(tree, b => b);

  // reading order: group boxes into "lines" whose vertical extents overlap, read each line left to right
  items.sort((a, b) => a.y - b.y || a.x - b.x);
  const rowsOut = [];
  for (const it of items) {
    const row = rowsOut[rowsOut.length - 1];
    const overlap = row ? Math.min(row.bottom, it.y + it.h) - Math.max(row.top, it.y) : -1;
    if (row && overlap > 0.4 * Math.min(it.h || 1, row.bottom - row.top || 1)) {
      row.items.push(it); row.bottom = Math.max(row.bottom, it.y + it.h);
    } else rowsOut.push({ top: it.y, bottom: it.y + it.h, items: [it] });
  }
  return rowsOut.flatMap(r => r.items.sort((a, b) => a.x - b.x)).map(it => it.text).join('\n');
}

