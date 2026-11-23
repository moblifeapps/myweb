/**
 * Script (dp-script.js) -> a real PowerPoint file, with PptxGenJS (MIT, ../pptxgen/pptxgen.bundle.js, loaded on first use).
 * The file then opens in DeckPersona like any other deck – and in PowerPoint, to polish it by hand.
 *
 * Every slide: the theme colour as its own background (shown when the slide has no background video), and a soft
 * rounded panel that carries the words, so they stay readable over a video. The panel keeps clear of the presenter:
 * presenter on the right -> panel on the left, and so on. The narration goes into the speaker notes.
 */

const W = 13.333, H = 7.5;                       // 16:9 "wide" slide, inches
const FONT = 'Segoe UI';

const THEMES = {
  light: { bg: 'F4F1EC', panel: 'FFFFFF', panelT: 10, text: '1F2937', sub: '4B5563', accent: '2563EB', onAccent: 'FFFFFF', card: 'F3F4F6' },
  dark: { bg: '111827', panel: '0F172A', panelT: 12, text: 'F9FAFB', sub: 'CBD5E1', accent: '60A5FA', onAccent: '0B1220', card: '1E293B' },
};

let loading = null;
async function lib() {
  if (globalThis.PptxGenJS) return globalThis.PptxGenJS;
  loading ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = new URL('../pptxgen/pptxgen.bundle.js', import.meta.url).href;
    s.onload = () => resolve(globalThis.PptxGenJS);
    s.onerror = () => { loading = null; reject(new Error('The PowerPoint writer could not be loaded.')); };
    document.head.appendChild(s);
  });
  return loading;
}

/** Where the words go, so the presenter (bottom left / centre / right, about 40 % of the height) never covers them. */
function areaFor(scene) {
  if (!scene.presenterOn) return { x: 0.9, y: 0.6, w: W - 1.8, h: H - 1.2 };
  if (scene.place === 'left') return { x: W - 0.55 - 8.7, y: 0.6, w: 8.7, h: H - 1.2 };
  if (scene.place === 'center') return { x: 0.8, y: 0.4, w: W - 1.6, h: 3.95 };
  return { x: 0.55, y: 0.6, w: 8.7, h: H - 1.2 };
}

/** Build the deck. Returns { blob, name }. */
export async function buildDeck(script, { fileName } = {}) {
  const PptxGenJS = await lib();
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.title = script.header.title;
  pptx.author = 'DeckPersona';
  pptx.company = 'Made with DeckPersona – mlapplications.com';

  const t = { ...THEMES[script.header.theme] || THEMES.light };
  if (script.header.accent) t.accent = script.header.accent.replace('#', '');
  const txt = (o) => ({ fontFace: FONT, color: t.text, margin: 0, ...o });

  const builds = [];                     // per slide: click groups, each a list of shape names that enter together
  script.scenes.forEach((sc, idx) => {
    const slide = pptx.addSlide();
    const groups = [];
    builds.push(groups);
    let nameN = 0;
    /** a shape that enters on its own click (k = the group: shapes with the same k enter together) */
    const anim = (k, o) => { const objectName = `dp-in-${idx}-${nameN++}`; (groups[k] ||= []).push(objectName); return { ...o, objectName }; };
    slide.background = { color: t.bg };
    const a = areaFor(sc);
    const center = sc.presenterOn && sc.place === 'center';
    // the panel and its accent edge
    slide.addShape(pptx.ShapeType.roundRect, { x: a.x, y: a.y, w: a.w, h: a.h, rectRadius: 0.18,
      fill: { color: t.panel, transparency: t.panelT }, line: { color: t.panel, transparency: 100 } });
    const ix = a.x + 0.7, iw = a.w - 1.1, iy = a.y + 0.38;            // inner box
    // a heading at the top of the panel, with the accent bar beside it
    const heading = (size, h = 1.0, y = iy) => {
      if (!sc.heading) return;
      slide.addShape(pptx.ShapeType.rect, { x: a.x + 0.38, y: y + 0.06, w: 0.08, h: size / 72 * 1.2, fill: { color: t.accent }, line: { color: t.accent } });
      slide.addText(sc.heading, txt({ x: ix, y, w: iw, h, fontSize: size, bold: true, valign: 'top', fit: 'shrink' }));
    };

    switch (sc.layout) {
      case 'title': {
        const hy = center ? a.y + 0.55 : a.y + a.h * 0.28;
        slide.addText(sc.heading || script.header.title, txt({ x: ix, y: hy, w: iw, h: center ? 1.6 : 2.0, fontSize: center ? 38 : 42, bold: true, valign: 'bottom', fit: 'shrink' }));
        slide.addShape(pptx.ShapeType.rect, { x: ix, y: hy + (center ? 1.75 : 2.2), w: 1.4, h: 0.07, fill: { color: t.accent }, line: { color: t.accent } });
        if (sc.subheading) slide.addText(sc.subheading, txt({ x: ix, y: hy + (center ? 1.95 : 2.45), w: iw, h: 1.2, fontSize: 22, color: t.sub, valign: 'top' }));
        break;
      }
      case 'statement': {
        slide.addText(sc.heading, txt({ x: ix, y: a.y + 0.5, w: iw, h: a.h * (sc.subheading ? 0.62 : 0.8), fontSize: center ? 32 : 36, bold: true, valign: 'middle', fit: 'shrink' }));
        if (sc.subheading) slide.addText(sc.subheading, txt({ x: ix, y: a.y + 0.5 + a.h * 0.62, w: iw, h: a.h * 0.28, fontSize: 20, color: t.sub, valign: 'top' }));
        break;
      }
      case 'numbers': {
        heading(28);
        const items = (sc.numbers || []).slice(0, 4);
        const n = Math.max(1, items.length), gap = 0.3;
        const cw = (iw - gap * (n - 1)) / n, cy = iy + (center ? 1.05 : 1.6), ch = center ? 2.2 : 2.9;
        items.forEach((it, k) => {
          const cx = ix + k * (cw + gap);
          slide.addShape(pptx.ShapeType.roundRect, anim(k, { x: cx, y: cy, w: cw, h: ch, rectRadius: 0.12, fill: { color: t.card }, line: { color: t.card } }));
          slide.addText(it.value, anim(k, txt({ x: cx + 0.2, y: cy + 0.25, w: cw - 0.4, h: ch * 0.45, fontSize: n > 3 ? 34 : 42, bold: true, color: t.accent, align: 'center', valign: 'middle', fit: 'shrink' })));
          slide.addText(it.label, anim(k, txt({ x: cx + 0.2, y: cy + 0.25 + ch * 0.45, w: cw - 0.4, h: ch * 0.45, fontSize: 17, color: t.sub, align: 'center', valign: 'top' })));
        });
        break;
      }
      case 'quote': {
        slide.addText('“', txt({ x: ix - 0.1, y: a.y + 0.2, w: 1.2, h: 1.4, fontSize: 110, bold: true, color: t.accent, fontFace: 'Georgia' }));
        slide.addText(sc.quote || sc.heading, txt({ x: ix, y: a.y + 1.3, w: iw, h: a.h - 2.6, fontSize: center ? 24 : 28, italic: true, valign: 'middle', fit: 'shrink' }));
        if (sc.author) slide.addText('— ' + sc.author, txt({ x: ix, y: a.y + a.h - 1.2, w: iw, h: 0.6, fontSize: 18, color: t.sub }));
        break;
      }
      case 'compare': {
        heading(28);
        const cw = (iw - 0.5) / 2, cy = iy + (center ? 0.95 : 1.4);
        let g = 0;
        [[sc.left_title, sc.left], [sc.right_title, sc.right]].forEach(([title, items], k) => {
          const cx = ix + k * (cw + 0.5);
          if (title) slide.addText(title, anim(g, txt({ x: cx, y: cy, w: cw, h: 0.55, fontSize: 20, bold: true, color: t.accent })));
          const list = (items || []).slice(0, 5), lh = Math.min(0.62, (a.h - (cy - a.y) - 1.0) / Math.max(1, list.length));
          list.forEach((b, j) => slide.addText([{ text: b, options: { bullet: { code: '25CF', indent: 26 } } }],
            anim(g + j, txt({ x: cx, y: cy + 0.65 + j * lh, w: cw, h: lh, fontSize: 18, valign: 'top' }))));
          g += Math.max(1, list.length);           // the title comes in with the first item
        });
        break;
      }
      case 'steps': {
        heading(center ? 26 : 30);
        const items = sc.bullets.slice(0, 5);
        const top = iy + (center ? 0.95 : 1.45), room = a.h - (top - a.y) - 0.45;
        const step = Math.min(0.95, room / Math.max(1, items.length));
        items.forEach((s, k) => {
          const y = top + k * step, d = Math.min(0.55, step - 0.15);
          slide.addShape(pptx.ShapeType.ellipse, anim(k, { x: ix, y, w: d, h: d, fill: { color: t.accent }, line: { color: t.accent } }));
          slide.addText(String(k + 1), anim(k, txt({ x: ix, y, w: d, h: d, fontSize: 16, bold: true, color: t.onAccent, align: 'center', valign: 'middle' })));
          slide.addText(s, anim(k, txt({ x: ix + d + 0.25, y, w: iw - d - 0.25, h: d, fontSize: center ? 20 : 22, valign: 'middle' })));
        });
        break;
      }
      case 'closing': {
        const hy = center ? a.y + 0.5 : a.y + a.h * 0.26;
        slide.addText(sc.heading, txt({ x: ix, y: hy, w: iw, h: 1.6, fontSize: center ? 34 : 38, bold: true, valign: 'bottom', fit: 'shrink' }));
        if (sc.subheading) slide.addText(sc.subheading, txt({ x: ix, y: hy + 1.75, w: iw, h: 1.1, fontSize: 21, color: t.sub, valign: 'top' }));
        if (sc.contact) slide.addText(sc.contact, txt({ x: ix, y: hy + (sc.subheading ? 2.95 : 1.85), w: iw, h: 0.6, fontSize: 20, bold: true, color: t.accent }));
        break;
      }
      default: {   // bullets
        heading(center ? 26 : 30);
        // one text box per bullet, so each can come in when the narration reaches it
        const items = sc.bullets.slice(0, 5);
        const top = iy + (center ? 0.95 : 1.4), room = a.h - (top - a.y) - 0.4;
        const lh = Math.min(center ? 0.62 : 0.9, room / Math.max(1, items.length));
        items.forEach((b, k) => slide.addText([{ text: b, options: { bullet: { code: '25CF', indent: 30 } } }],
          anim(k, txt({ x: ix, y: top + k * lh, w: iw, h: lh, fontSize: center ? 21 : 24, valign: 'top', fit: 'shrink' }))));
      }
    }
    if (sc.say) slide.addNotes(sc.say);
  });

  let blob = await pptx.write({ outputType: 'blob' });
  if (builds.some(g => g.length)) blob = await addEntrances(blob, builds);
  const name = (fileName || script.header.title || 'My video').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) + '.pptx';
  return { blob, name };
}

/**
 * PptxGenJS writes no animations, so they are added to the finished file: every group of named shapes gets an
 * "on click" Float In (fade + rise, 0.6 s). In DeckPersona the clicks are then timed to the narration – each
 * bullet comes in when the presenter gets to it; in PowerPoint they come in on click as usual.
 */
async function addEntrances(blob, builds) {
  const JSZip = globalThis.JSZip;                      // part of the PptxGenJS bundle
  if (!JSZip) return blob;
  const zip = await JSZip.loadAsync(blob);
  for (let i = 0; i < builds.length; i++) {
    const groups = builds[i].filter(g => g?.length);
    if (!groups.length) continue;
    const path = `ppt/slides/slide${i + 1}.xml`;
    let xml = await zip.file(path)?.async('string');
    if (!xml) continue;
    const idOf = {};
    for (const m of xml.matchAll(/<p:cNvPr id="(\d+)" name="(dp-in-[^"]+)"/g)) idOf[m[2]] = m[1];
    let n = 3;
    const ids = [];
    const effect = (spid, first) => {
      const e = n++, b = () => n++;
      ids.push(spid);
      return `<p:par><p:cTn id="${e}" presetID="42" presetClass="entr" presetSubtype="0" fill="hold" grpId="0" nodeType="${first ? 'clickEffect' : 'withEffect'}">` +
        `<p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst>` +
        `<p:set><p:cBhvr><p:cTn id="${b()}" dur="1" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst></p:cTn><p:tgtEl><p:spTgt spid="${spid}"/></p:tgtEl><p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst></p:cBhvr><p:to><p:strVal val="visible"/></p:to></p:set>` +
        `<p:animEffect transition="in" filter="fade"><p:cBhvr><p:cTn id="${b()}" dur="600"/><p:tgtEl><p:spTgt spid="${spid}"/></p:tgtEl></p:cBhvr></p:animEffect>` +
        `<p:anim calcmode="lin" valueType="num"><p:cBhvr><p:cTn id="${b()}" dur="600" fill="hold"/><p:tgtEl><p:spTgt spid="${spid}"/></p:tgtEl><p:attrNameLst><p:attrName>ppt_x</p:attrName></p:attrNameLst></p:cBhvr><p:tavLst><p:tav tm="0"><p:val><p:strVal val="#ppt_x"/></p:val></p:tav><p:tav tm="100000"><p:val><p:strVal val="#ppt_x"/></p:val></p:tav></p:tavLst></p:anim>` +
        `<p:anim calcmode="lin" valueType="num"><p:cBhvr><p:cTn id="${b()}" dur="600" fill="hold"/><p:tgtEl><p:spTgt spid="${spid}"/></p:tgtEl><p:attrNameLst><p:attrName>ppt_y</p:attrName></p:attrNameLst></p:cBhvr><p:tavLst><p:tav tm="0"><p:val><p:strVal val="#ppt_y+.06"/></p:val></p:tav><p:tav tm="100000"><p:val><p:strVal val="#ppt_y"/></p:val></p:tav></p:tavLst></p:anim>` +
        `</p:childTnLst></p:cTn></p:par>`;
    };
    let clicks = '';
    for (const g of groups) {
      const spids = g.map(name => idOf[name]).filter(Boolean);
      if (!spids.length) continue;
      const outer = n++, inner = n++;
      clicks += `<p:par><p:cTn id="${outer}" fill="hold"><p:stCondLst><p:cond delay="indefinite"/></p:stCondLst><p:childTnLst>` +
        `<p:par><p:cTn id="${inner}" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst>` +
        spids.map((s, k) => effect(s, k === 0)).join('') + `</p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par>`;
    }
    if (!clicks) continue;
    const timing = `<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst>` +
      `<p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst>${clicks}</p:childTnLst></p:cTn>` +
      `<p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst>` +
      `<p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst></p:seq>` +
      `</p:childTnLst></p:cTn></p:par></p:tnLst><p:bldLst>${[...new Set(ids)].map(s => `<p:bldP spid="${s}" grpId="0" animBg="1"/>`).join('')}</p:bldLst></p:timing>`;
    xml = xml.replace(/<\/p:sld>\s*$/, timing + '</p:sld>');
    zip.file(path, xml);
  }
  return zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' });
}
