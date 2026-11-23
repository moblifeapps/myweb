/**
 * DeckPersona script v1 – the plain-text format any AI assistant writes (ChatGPT, Claude, Gemini, DeepSeek, Copilot …).
 *
 *   DECKPERSONA SCRIPT 1
 *   title: …            language: el      voice: female     presenter: on
 *   presenter_style: friendly             presenter_position: right
 *   theme: light        accent: #B45309
 *
 *   --- scene ---
 *   layout: bullets     heading: …        - bullet lines
 *   background: english keywords | none
 *   say:
 *   narration … (up to the next scene)
 *
 * The reader is forgiving: chat text and code fences around it, **bold** field names, "## Scene 3", indented lines,
 * • · * 1. bullets, "none" / "-" / "n/a" for empty, field names in any case. Problems are warnings, never errors.
 */

export const LAYOUTS = ['title', 'bullets', 'statement', 'numbers', 'quote', 'compare', 'steps', 'closing'];

const HEADER_KEYS = ['title', 'language', 'voice', 'presenter', 'presenter_style', 'presenter_position', 'theme', 'accent'];
const SCENE_KEYS = ['layout', 'heading', 'subheading', 'background', 'presenter', 'presenter_style', 'presenter_position',
  'quote', 'author', 'contact', 'left_title', 'right_title', 'say'];
const ALIASES = { narration: 'say', voiceover: 'say', voice_over: 'say', text: 'say', script: 'say', title_text: 'heading',
  subtitle: 'subheading', bg: 'background', video: 'background', position: 'presenter_position', style: 'presenter_style',
  left: 'left_title', right: 'right_title', cta: 'subheading', website: 'contact' };

/** Speaking rate (words a minute) – languages with long words are read with fewer words a minute. */
export const WORDS_PER_MINUTE = { el: 115, de: 120, fi: 105, hu: 110, ru: 120, pl: 120, nl: 130, default: 140 };
export const wpm = (lang) => WORDS_PER_MINUTE[(lang || '').slice(0, 2).toLowerCase()] || WORDS_PER_MINUTE.default;

const EMPTY = /^(none|no|-|–|n\/a|na|null|\(none\)|—)$/i;
const TAGS = /\[(smile|happy|serious|surprised|neutral)\]/gi;
const words = (s) => (s || '').replace(TAGS, ' ').split(/\s+/).filter(w => /[\p{L}\p{N}]/u.test(w)).length;

const SCENE_LINE = /^\s*(?:#{1,4}\s*)?(?:[-=_*]{2,}\s*)?scene\b(?:\s*#?\d+)?\s*(?:[-=_*]{2,})?\s*(?:[:.–-].*)?$/i;
const FIELD_LINE = /^\s*(?:[-*]\s+)?\**\s*([A-Za-z][A-Za-z _]{0,24}?)\s*\**\s*:\s*\**\s*(.*?)\s*$/;
const BULLET_LINE = /^\s*(?:[-*•·▪‣◦]|\d{1,2}[.)])\s+(.*\S)\s*$/;

function keyOf(raw) {
  const k = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return ALIASES[k] || k;
}
const clean = (v) => {
  const t = (v || '').replace(/\*\*/g, '').replace(/^["“]|["”]$/g, '').trim();
  return EMPTY.test(t) ? '' : t;
};

/** Parse a script. Returns { ok, header, scenes, warnings, words, seconds }. */
export function parseScript(text) {
  const warnings = [];
  let lines = (text || '').replace(/\r\n?/g, '\n').split('\n')
    .filter(l => !/^\s*```/.test(l));                                     // code fences
  const start = lines.findIndex(l => /DECKPERSONA\s+SCRIPT/i.test(l));
  if (start >= 0) lines = lines.slice(start + 1);

  const header = {};
  const scenes = [];
  let sc = null;            // current scene
  let field = null;         // the field that continuation lines extend
  let list = null;          // where "- " lines go: 'bullets' | 'left' | 'right'
  const unknown = new Set();

  const newScene = () => {
    sc = { layout: '', heading: '', subheading: '', bullets: [], left: [], right: [], left_title: '', right_title: '',
      quote: '', author: '', contact: '', background: '', presenter: '', presenter_style: '', presenter_position: '', say: '' };
    scenes.push(sc);
    field = null; list = 'bullets';
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\t/g, '  ');
    if (SCENE_LINE.test(line)) { newScene(); continue; }

    const f = FIELD_LINE.exec(line);
    const key = f ? keyOf(f[1]) : null;
    const known = key && (sc ? SCENE_KEYS.includes(key) || HEADER_KEYS.includes(key) : HEADER_KEYS.includes(key) || SCENE_KEYS.includes(key));

    // inside the narration everything is narration, except a scene line or another scene field
    if (sc && field === 'say' && !(known && key !== 'say' && SCENE_KEYS.includes(key))) {
      const t = line.trim();
      if (t) sc.say += (sc.say ? ' ' : '') + t.replace(/\*\*/g, '');
      continue;
    }

    if (known) {
      const value = clean(f[2]);
      if (!sc && HEADER_KEYS.includes(key)) { header[key] = value; field = null; continue; }
      if (!sc) newScene();                                                 // a scene without its "--- scene ---" line
      if (key === 'say') { sc.say = value; field = 'say'; continue; }
      if (key === 'left_title') { sc.left_title = value; list = 'left'; field = 'left_title'; continue; }
      if (key === 'right_title') { sc.right_title = value; list = 'right'; field = 'right_title'; continue; }
      if (key === 'title' && sc) { sc.heading ||= value; field = 'heading'; continue; }
      if (key in sc) { sc[key] = value; field = key; }
      continue;
    }
    if (f && !BULLET_LINE.test(line) && /^[a-z_ ]+$/i.test(f[1]) && f[1].length <= 20 && !/\s{2,}/.test(f[1])) {
      unknown.add(f[1].trim());                                            // "music: upbeat" – ignored
      field = null;
      continue;
    }

    const b = BULLET_LINE.exec(line);
    if (b && sc) {
      const item = b[1].replace(/\*\*/g, '').trim();
      (list === 'left' ? sc.left : list === 'right' ? sc.right : sc.bullets).push(item);
      field = null;
      continue;
    }

    const t = line.trim();
    if (!t) { if (field !== 'say') field = null; continue; }
    if (sc && field && field !== 'say' && typeof sc[field] === 'string') sc[field] += ' ' + t.replace(/\*\*/g, '');
    else if (!sc && /^(title)$/.test(field || '')) header.title += ' ' + t;
  }

  // ---- tidy each scene, choose missing layouts, collect warnings
  const lang = (header.language || '').slice(0, 2).toLowerCase();
  const out = [];
  scenes.forEach((s, idx) => {
    const n = idx + 1;
    for (const k of Object.keys(s)) if (typeof s[k] === 'string') s[k] = clean(s[k]);
    s.say = s.say.replace(/\s+/g, ' ').trim();
    if (!s.heading && !s.say && !s.bullets.length && !s.quote) return;    // empty (e.g. stray separator)
    let layout = (s.layout || '').toLowerCase();
    if (!LAYOUTS.includes(layout)) {
      if (layout) warnings.push(`Scene ${n}: layout "${s.layout}" is unknown – using ${s.bullets.length ? 'bullets' : 'statement'}.`);
      layout = s.left.length || s.right.length ? 'compare' : s.quote ? 'quote' : s.bullets.length ? 'bullets' : idx === 0 ? 'title' : 'statement';
    }
    s.layout = layout;
    if (layout === 'numbers') {
      s.numbers = s.bullets.map(x => {
        const m = /^(.*?)\s*(?:\||–|—|:|-)\s+(.*)$/.exec(x);
        return m ? { value: m[1].trim(), label: m[2].trim() } : { value: x.split(/\s+/)[0], label: x.split(/\s+/).slice(1).join(' ') };
      }).slice(0, 4);
    }
    const max = { bullets: 5, steps: 5, numbers: 4 }[layout];
    if (max && s.bullets.length > max) warnings.push(`Scene ${n}: ${s.bullets.length} lines – the ${layout} slide shows ${max}.`);
    if (['bullets', 'steps'].includes(layout) && !s.bullets.length) warnings.push(`Scene ${n}: a ${layout} slide without "- " lines.`);
    const long = s.bullets.find(x => words(x) > 9);
    if (long) warnings.push(`Scene ${n}: a long line on the slide (${words(long)} words) – it may wrap.`);
    if (words(s.heading) > 12) warnings.push(`Scene ${n}: the heading is ${words(s.heading)} words – long for a slide.`);
    if (words(s.subheading) > 14) warnings.push(`Scene ${n}: the subheading is ${words(s.subheading)} words – long for a slide.`);
    const w = words(s.say);
    s.words = w;
    s.seconds = Math.round(w / wpm(lang) * 60);
    if (!w) warnings.push(`Scene ${n}: no narration (say:) – the slide is shown for a fixed time.`);
    else if (s.seconds > 45) warnings.push(`Scene ${n}: about ${s.seconds} s of narration – consider splitting it.`);
    const bangs = (s.say.match(/!/g) || []).length;
    if (bangs > 2) warnings.push(`Scene ${n}: ${bangs} exclamation marks – the presenter will look very excited.`);
    out.push(s);
  });

  if (unknown.size) warnings.push(`Ignored: ${[...unknown].slice(0, 5).map(k => `"${k}"`).join(', ')}.`);
  if (start < 0 && out.length) warnings.push('The first line "DECKPERSONA SCRIPT 1" is missing – read anyway.');

  const h = {
    title: clean(header.title) || out[0]?.heading || 'My video',
    language: lang || guessLanguage(out.map(s => s.say).join(' ')),
    voice: /^m/i.test(header.voice || '') ? 'male' : 'female',
    presenter: !/^(off|no|false|0)$/i.test(header.presenter || ''),
    presenter_style: normStyle(header.presenter_style),
    presenter_position: normPlace(header.presenter_position),
    theme: /dark/i.test(header.theme || '') ? 'dark' : 'light',
    accent: /^#?[0-9a-f]{6}$/i.test((header.accent || '').trim()) ? '#' + header.accent.trim().replace('#', '').toUpperCase() : '',
  };
  for (const s of out) {
    s.presenterOn = s.presenter ? !/^(off|no|false|0)$/i.test(s.presenter) : h.presenter;
    s.place = s.presenter_position ? normPlace(s.presenter_position) : h.presenter_position;
    s.style = s.presenter_style ? normStyle(s.presenter_style) : '';
  }
  const totalWords = out.reduce((a, s) => a + s.words, 0);
  if (!out.length) warnings.unshift('No scenes found. Paste the whole answer, starting at "DECKPERSONA SCRIPT 1".');
  return { ok: out.length > 0, header: h, scenes: out, warnings, words: totalWords,
    seconds: out.reduce((a, s) => a + Math.max(s.seconds, 4) + 1, 0) };
}

const normStyle = (v) => /enthus|energ/i.test(v || '') ? 'enthusiastic' : /calm|neutral/i.test(v || '') ? 'neutral' : /serious/i.test(v || '') ? 'serious' : 'friendly';
const normPlace = (v) => /left/i.test(v || '') ? 'left' : /cent/i.test(v || '') ? 'center' : 'right';

/** A guess from the alphabet when the script has no language line. */
function guessLanguage(t) {
  if (/[Ͱ-Ͽ]/.test(t)) return 'el';
  if (/[Ѐ-ӿ]/.test(t)) return 'ru';
  if (/[äöüß]/i.test(t)) return 'de';
  if (/[àâçéèêëîïôûùüÿœ]/i.test(t)) return 'fr';
  if (/[áéíóúñ¿¡]/i.test(t)) return 'es';
  return 'en';
}

/** The prompt the user pastes into any assistant. opts: { request, length, language, style, presenter, place } */
export function buildPrompt(opts = {}) {
  const req = [];
  if (opts.request?.trim()) req.push(opts.request.trim());
  const extra = [];
  if (opts.length) extra.push(`Length: ${opts.length}.`);
  if (opts.language) extra.push(`Language of the video: ${opts.language}.`);
  if (opts.presenter === false) extra.push('No presenter (presenter: off).');
  else if (opts.style || opts.place) extra.push(`Presenter: ${opts.style || 'friendly'}, on the ${opts.place || 'right'}.`);
  if (extra.length) req.push(extra.join(' '));
  const request = req.join('\n') || '<describe your video here: what it is about, who it is for, how long>';
  return `You are a scriptwriter for DeckPersona, a free Windows app that turns a script into a narrated presentation video with slides, background videos and an optional AI presenter (a 3D avatar who reads the narration).

Write a video script for my request at the end of this message.

Before you write: if my request does not make clear who the video is for, how long it should be, or which language it is in, ask me up to 3 short questions and wait. Otherwise write the script at once. Defaults if I do not say: 1 to 2 minutes, the language of my request, a friendly presenter on the right.

OUTPUT RULES
- Reply with the script only, inside ONE code block, with no text before or after it.
- The first line is exactly: DECKPERSONA SCRIPT 1
- Keep every field name in English exactly as shown below, even when the video is in another language. Write the content in the video's language.
- Plain text only inside fields: no markdown, no emojis, no links in the narration.

THE FORMAT
DECKPERSONA SCRIPT 1
title: <video title>
language: <language code, e.g. en, el, de, fr, es, it>
voice: <female or male>
presenter: <on or off>
presenter_style: <friendly, enthusiastic, calm or serious>
presenter_position: <right, left or center>
theme: <light or dark>
accent: <a brand colour as #RRGGBB, or none>

--- scene ---
layout: <title, bullets, statement, numbers, quote, compare, steps or closing>
heading: <short heading>
(the fields for that layout, see below)
background: <2 to 4 English keywords for a stock video behind the slide, or none>
say:
<what the presenter says on this slide>

LAYOUTS AND THEIR FIELDS
- title: heading, subheading. The opening slide.
- bullets: heading, then lines starting with "- " (2 to 5 bullets, at most 8 words each).
- statement: heading = one strong sentence of at most 12 words; subheading optional.
- numbers: heading, then 2 to 4 lines like "- 35% | fewer returns" (value | label).
- quote: quote, author.
- compare: heading, left_title, then "- " lines, right_title, then "- " lines.
- steps: heading, then 2 to 5 lines starting with "- ", in order.
- closing: heading, subheading (the call to action), contact (only a website or e-mail I gave you; never invent one, leave the field out instead). The last slide.

WRITING RULES
- 4 to 10 scenes. Each scene's narration is 40 to 70 words (about 15 to 30 seconds). Total narration is about 140 words per minute of video in English; for Greek, German and other languages with long words, about 115.
- Slides carry few words; the narration explains them in full sentences and never just reads the bullets aloud.
- Start with a hook that says why the viewer should care. End with one clear next step for the viewer.
- Write for the ear: short sentences, everyday words, no abbreviations the voice would stumble on.
- Use only facts I gave you. Do not invent numbers, prices, times, ingredients, awards or claims; where a detail would help, keep it general.
- Use exclamation marks rarely: at most one in the whole narration of a scene, and not in every scene.
- background keywords are always in English, concrete and calm enough to sit behind text (for example: office desk morning light, ocean waves aerial, bakery bread oven). Use none when the slide should stay plain.
- The presenter's face reacts by itself (smiles in pauses, raises the brows on questions). You may add at most one of these tags in a scene's narration where it truly helps: [smile] [serious] [surprised]. They are not spoken.
- To switch the presenter off or move it for one slide, add presenter: off or presenter_position: left inside that scene.

If I ask for changes later, reply with the complete updated script in the same format.

MY REQUEST:
${request}`;
}

/** Where to send the user – the prompt is on the clipboard, they paste it there. */
export const ASSISTANTS = [
  { id: 'claude', name: 'Claude', url: 'https://claude.ai/new' },
  { id: 'chatgpt', name: 'ChatGPT', url: 'https://chatgpt.com/' },
  { id: 'gemini', name: 'Gemini', url: 'https://gemini.google.com/app' },
  { id: 'deepseek', name: 'DeepSeek', url: 'https://chat.deepseek.com/' },
  { id: 'copilot', name: 'Copilot', url: 'https://copilot.microsoft.com/' },
];
