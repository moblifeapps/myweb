/* Desktop Live Wallpaper+ gallery - shared by desktop_live_gallery_videos.html and _photos.html.
 *
 * Data: pixabay_videos.json / pixabay_photos.json, written once a day by the GitHub Action
 * (scripts/update_pixabay_wallpapers.py). Links only - the files stay on Pixabay.
 *
 * Memory: the page never holds more than it needs.
 *  - Cards are added in batches of 48 as you scroll (only the first batch exists at the start).
 *  - A card's picture is requested only when the card comes within ~1 screen of the window
 *    (it is loaded a little before you see it), and released again when it is far away.
 *  - Videos: one small preview plays only while the pointer rests on a card, and is removed after.
 */
(function () {
  "use strict";

  const KIND = document.body.dataset.kind === "photos" ? "photos" : "videos";
  const IS_VIDEO = KIND === "videos";
  const DATA_URL = IS_VIDEO ? "pixabay_videos.json" : "pixabay_photos.json";
  const STORE_URL = "https://apps.microsoft.com/detail/9P8TWLC0GZD4";
  const HOWTO_IMG = "images/dlw_rightclick_add.jpg";
  const BATCH = 48;
  const NOUN = IS_VIDEO ? "videos" : "photos";

  const CATEGORY_NAMES = {
    backgrounds: "Backgrounds", nature: "Nature", places: "Places", travel: "Travel", animals: "Animals",
    science: "Science & Space", music: "Music", transportation: "Transport", buildings: "Buildings",
    people: "People", feelings: "Feelings", religion: "Religion", health: "Health", food: "Food & Drink",
    sports: "Sports", fashion: "Fashion", education: "Education", computer: "Computer & Tech",
    industry: "Industry", business: "Business",
  };

  // ---------------------------------------------------------------- icons
  const ICON = {
    download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/></svg>',
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    prev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m15 5-7 7 7 7"/></svg>',
    next: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m9 5 7 7-7 7"/></svg>',
    external: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
    store: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 5.5 10.5 4.4v7.1H3zm0 13 7.5 1.1v-7H3zm8.5 1.25L21 21v-8.5h-9.5zm0-15.5v7.25H21V3z"/></svg>',
  };

  // ---------------------------------------------------------------- helpers
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtNum = (n) => n.toLocaleString("en-US");
  const fmtTime = (s) => { s = Math.max(0, Math.round(s || 0)); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };
  const fmtSize = (b) => !b ? "" : b >= 1e9 ? (b / 1e9).toFixed(2) + " GB" : b >= 1e6 ? (b / 1e6).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1e3)) + " KB";
  const quality = (w) => !w ? "" : w >= 3840 ? "4K" : w >= 2560 ? "2K" : w >= 1920 ? "Full HD" : "HD";
  const catName = (c) => CATEGORY_NAMES[c] || (c ? c[0].toUpperCase() + c.slice(1) : "");
  const title = (it) => (it.t || "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 3).join(", ") || catName(it.c);
  const authorUrl = (it) => it.u ? `https://pixabay.com/users/${encodeURIComponent(it.a)}-${it.u}/` : "https://pixabay.com/";
  const fileName = (it) => {
    const ext = ((it.f || "").split("?")[0].match(/\.(mp4|webm|mov|jpe?g|png|webp)$/i) || [])[1] || (IS_VIDEO ? "mp4" : "jpg");
    const slug = (it.t || catName(it.c)).toLowerCase().split(",")[0].trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || KIND;
    return `${slug}-${it.i}-pixabay.${ext.toLowerCase()}`;
  };

  // ---------------------------------------------------------------- state
  let ALL = [];            // every item of the catalog
  let CATS = [];           // categories in the catalog, in order
  let list = [];           // current results (category + search)
  let shown = 0;           // cards in the grid so far
  let cat = "";            // "" = all
  let query = "";
  let generated = "";

  const grid = $("#grid");
  const sentinel = $("#sentinel");
  const searchBox = $(".search");
  const input = $("#q");

  // keep the sticky category bar right under the top bar, whatever its height (it wraps on phones)
  const topbar = $(".topbar");
  const setBarHeight = () => document.documentElement.style.setProperty("--topbar-h", topbar.offsetHeight + "px");
  new ResizeObserver(setBarHeight).observe(topbar);

  // ---------------------------------------------------------------- lazy pictures
  // near: give the card its picture when it is within 1000 px (about one screen) of the window
  const near = new IntersectionObserver((entries) => {
    for (const e of entries) {
      e.target.dataset.near = e.isIntersecting ? "1" : "0";
      if (!e.isIntersecting) continue;
      const img = e.target.querySelector("img[data-src]");
      if (img && !img.getAttribute("src")) img.src = img.dataset.src;
    }
  }, { rootMargin: "1000px 0px" });

  // far: take the picture away again when the card is more than ~4 screens away - the browser can then
  // free the decoded image; scrolling back brings it in again through "near"
  const far = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) continue;
      const img = e.target.querySelector("img[data-src]");
      if (img && img.getAttribute("src")) { img.removeAttribute("src"); img.classList.remove("ok"); }
    }
  }, { rootMargin: "4000px 0px" });

  // more: add the next batch of cards when the end of the grid comes within 1600 px
  const more = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) appendBatch();
  }, { rootMargin: "1600px 0px" });

  function imgLoaded(img) { img.classList.add("ok"); }

  // ---------------------------------------------------------------- cards
  function card(it, index) {
    const el = document.createElement("article");
    el.className = "card";
    el.tabIndex = 0;
    el.dataset.index = index;
    el.setAttribute("aria-label", `${title(it)} - by ${it.a}`);
    const q = quality(it.w);
    el.innerHTML =
      `<div class="thumb">` +
        `<img data-src="${esc(it.th)}" alt="${esc(title(it))}" decoding="async" draggable="false">` +
        (q ? `<span class="badge q">${q}</span>` : "") +
        (IS_VIDEO ? `<span class="badge">${fmtTime(it.d)}</span><div class="play-hint"><span>${ICON.play}</span></div>` : "") +
      `</div>` +
      `<div class="meta">` +
        `<div class="who"><div class="tags">${esc(title(it))}</div><div class="by">by ${esc(it.a)} · Pixabay</div></div>` +
        `<button class="dl" type="button" title="Download" aria-label="Download">${ICON.download}</button>` +
      `</div>`;
    const img = el.querySelector("img");
    img.addEventListener("load", () => imgLoaded(img));
    img.addEventListener("error", () => {
      // a network hiccup: try once more a moment later (only if it is still wanted on screen)
      img.removeAttribute("src");
      if (img.dataset.retried) return;
      img.dataset.retried = "1";
      setTimeout(() => { if (el.isConnected && el.dataset.near === "1" && !img.getAttribute("src")) img.src = img.dataset.src; }, 1500);
    });
    return el;
  }

  function appendBatch() {
    if (shown >= list.length) return;
    const frag = document.createDocumentFragment();
    const end = Math.min(list.length, shown + BATCH);
    for (let i = shown; i < end; i++) {
      const el = card(list[i], i);
      frag.appendChild(el);
      near.observe(el);
      far.observe(el);
    }
    grid.appendChild(frag);
    shown = end;
    $("#more-note").hidden = shown >= list.length;
  }

  function render() {
    stopHoverPreview();
    near.disconnect(); far.disconnect();
    grid.textContent = "";
    shown = 0;

    const q = query.toLowerCase().split(/\s+/).filter(Boolean);
    list = ALL.filter((it) => (!cat || it.c === cat) && q.every((w) => it._s.includes(w)));

    // heading + count
    const h = query ? `Results for “${query}”` + (cat ? ` in ${catName(cat)}` : "")
                    : cat ? `${catName(cat)} ${NOUN}` : `All ${NOUN}`;
    $("#title").textContent = h;
    $("#count").textContent = list.length ? `${fmtNum(list.length)} ${NOUN}` : "";
    const pixabaySearch = `https://pixabay.com/${IS_VIDEO ? "videos" : "photos"}/search/${encodeURIComponent(query || catName(cat) || "")}/`;
    $("#more").innerHTML = query || cat ? `Want more? <a href="${pixabaySearch}" target="_blank" rel="noopener">Search Pixabay for “${esc(query || catName(cat))}”</a>` : "";

    const empty = $("#empty");
    empty.hidden = list.length > 0;
    if (!list.length) {
      empty.innerHTML = `<h2>Nothing found${query ? ` for “${esc(query)}”` : ""}</h2>` +
        `<p>Try another word, choose <a href="#" data-all>all categories</a>, or <a href="${pixabaySearch}" target="_blank" rel="noopener">search on Pixabay</a>.</p>`;
    }

    appendBatch();
    more.disconnect(); more.observe(sentinel);
    syncChips();
    syncUrl();
  }

  // ---------------------------------------------------------------- hover preview (videos)
  let hoverTimer = 0, hoverCard = null, hoverVideo = null;
  const canHover = window.matchMedia("(hover: hover) and (pointer: fine)").matches;

  function startHoverPreview(el) {
    const it = list[+el.dataset.index];
    if (!it || !it.pv) return;
    stopHoverPreview();
    hoverCard = el;
    const v = document.createElement("video");
    v.muted = true; v.loop = true; v.playsInline = true; v.autoplay = true; v.preload = "auto";
    v.setAttribute("muted", "");
    v.src = it.pv;
    v.addEventListener("playing", () => v.classList.add("on"), { once: true });
    el.querySelector(".thumb").appendChild(v);
    el.classList.add("previewing");
    hoverVideo = v;
  }

  function stopHoverPreview() {
    clearTimeout(hoverTimer);
    if (hoverVideo) {
      hoverVideo.pause();
      hoverVideo.removeAttribute("src");
      hoverVideo.load();            // releases the decoder and its buffers
      hoverVideo.remove();
      hoverVideo = null;
    }
    if (hoverCard) hoverCard.classList.remove("previewing");
    hoverCard = null;
  }

  if (IS_VIDEO && canHover) {
    grid.addEventListener("pointerover", (e) => {
      const el = e.target.closest(".card");
      if (!el || el === hoverCard || el.contains(e.relatedTarget)) return;
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(() => startHoverPreview(el), 280);
    });
    grid.addEventListener("pointerout", (e) => {
      const el = e.target.closest(".card");
      if (!el || el.contains(e.relatedTarget)) return;
      clearTimeout(hoverTimer);
      if (el === hoverCard) stopHoverPreview();
    });
  }

  // ---------------------------------------------------------------- clicks on cards
  grid.addEventListener("click", (e) => {
    const el = e.target.closest(".card");
    if (!el) return;
    const it = list[+el.dataset.index];
    if (e.target.closest(".dl")) { e.stopPropagation(); startDownload(it); return; }
    openViewer(+el.dataset.index);
  });
  grid.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const el = e.target.closest(".card");
    if (!el || e.target.closest(".dl")) return;
    e.preventDefault();
    openViewer(+el.dataset.index);
  });
  $("#empty").addEventListener("click", (e) => {
    if (e.target.closest("[data-all]")) { e.preventDefault(); cat = ""; query = ""; input.value = ""; searchBox.classList.remove("has-text"); render(); }
  });

  // ---------------------------------------------------------------- search
  let searchTimer = 0;
  input.addEventListener("input", () => {
    searchBox.classList.toggle("has-text", !!input.value);
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { query = input.value.trim(); render(); window.scrollTo({ top: 0 }); }, 200);
  });
  input.addEventListener("keydown", (e) => { if (e.key === "Escape") { input.value = ""; input.dispatchEvent(new Event("input")); } });
  $(".search .clear").addEventListener("click", () => { input.value = ""; input.dispatchEvent(new Event("input")); input.focus(); });

  // ---------------------------------------------------------------- categories (chips + sheet)
  const counts = {};
  function buildChips() {
    const chips = $("#chips");
    const all = `<button class="chip" type="button" data-cat="" aria-pressed="false">All<span class="n">${fmtNum(ALL.length)}</span></button>`;
    chips.innerHTML = all + CATS.map((c) =>
      `<button class="chip" type="button" data-cat="${esc(c)}" aria-pressed="false">${esc(catName(c))}<span class="n">${fmtNum(counts[c] || 0)}</span></button>`).join("");
    chips.addEventListener("click", (e) => {
      const b = e.target.closest(".chip");
      if (b) setCategory(b.dataset.cat);
    });
  }
  function syncChips() {
    document.querySelectorAll(".chip").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.cat === cat)));
    document.querySelectorAll(".cat-tile").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.cat === cat)));
    const on = $(`.chip[aria-pressed="true"]`);
    if (on) on.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  function setCategory(c) {
    cat = c || "";
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  const sheet = $("#cats");
  function openCategories() {
    const tiles = $("#cat-grid");
    if (!tiles.childElementCount) {
      const firstOf = {};
      for (const it of ALL) if (!firstOf[it.c]) firstOf[it.c] = it;
      tiles.innerHTML =
        `<button class="cat-tile" type="button" data-cat=""><img data-src="${esc((ALL[0] || {}).th || "")}" alt=""><span>All ${NOUN}<small>${fmtNum(ALL.length)}</small></span></button>` +
        CATS.map((c) => `<button class="cat-tile" type="button" data-cat="${esc(c)}"><img data-src="${esc((firstOf[c] || {}).th || "")}" alt=""><span>${esc(catName(c))}<small>${fmtNum(counts[c] || 0)} ${NOUN}</small></span></button>`).join("");
      tiles.addEventListener("click", (e) => {
        const b = e.target.closest(".cat-tile");
        if (!b) return;
        closeOverlay(sheet);
        setCategory(b.dataset.cat);
      });
    }
    // the tiles' pictures load only while the sheet is open
    tiles.querySelectorAll("img[data-src]").forEach((img) => {
      img.onload = () => img.classList.add("ok");
      if (!img.getAttribute("src")) img.src = img.dataset.src;
    });
    syncChips();
    openOverlay(sheet);
  }
  $(".cat-open").addEventListener("click", openCategories);

  // ---------------------------------------------------------------- overlays
  let lastFocus = null;
  function openOverlay(o) {
    lastFocus = document.activeElement;
    o.classList.add("open");
    o.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
    setTimeout(() => { const f = o.querySelector("[data-autofocus]") || o.querySelector(".x"); f && f.focus(); }, 30);
  }
  function closeOverlay(o) {
    o.classList.remove("open");
    o.setAttribute("aria-hidden", "true");
    if (!document.querySelector(".overlay.open")) document.body.style.overflow = "";
    if (o === viewer) clearStage();
    if (o === sheet) $("#cat-grid").querySelectorAll("img").forEach((img) => { img.removeAttribute("src"); img.classList.remove("ok"); });
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  document.querySelectorAll(".overlay").forEach((o) => {
    o.addEventListener("click", (e) => { if (e.target === o || e.target.closest(".x")) closeOverlay(o); });
  });
  document.addEventListener("keydown", (e) => {
    const top = [...document.querySelectorAll(".overlay.open")].pop();
    if (!top) {
      if (e.key === "/" && document.activeElement !== input) { e.preventDefault(); input.focus(); }
      return;
    }
    if (e.key === "Escape") { closeOverlay(top); return; }
    if (top === viewer && !e.target.closest("input, textarea")) {
      if (e.key === "ArrowLeft") { e.preventDefault(); step(-1); }
      if (e.key === "ArrowRight") { e.preventDefault(); step(1); }
    }
  });

  // ---------------------------------------------------------------- preview window
  const viewer = $("#viewer");
  const stage = $("#stage");
  let viewIndex = -1;

  function clearStage() {
    const v = stage.querySelector("video");
    if (v) { v.pause(); v.removeAttribute("src"); v.load(); }
    stage.querySelectorAll("video, img").forEach((n) => n.remove());
  }

  function openViewer(index) {
    stopHoverPreview();
    viewIndex = index;
    const it = list[index];
    if (!it) return;
    clearStage();
    if (IS_VIDEO) {
      const v = document.createElement("video");
      v.controls = true; v.autoplay = true; v.muted = true; v.loop = true; v.playsInline = true;
      v.setAttribute("muted", "");
      v.poster = it.th;
      v.src = it.m || it.pv;
      stage.prepend(v);
    } else {
      const img = document.createElement("img");
      img.alt = title(it);
      img.src = it.pw || it.th;
      stage.prepend(img);
    }
    $("#v-title").textContent = title(it);
    $("#v-facts").innerHTML =
      `<dt>Author</dt><dd><a href="${authorUrl(it)}" target="_blank" rel="noopener">${esc(it.a)}</a></dd>` +
      `<dt>Category</dt><dd>${esc(catName(it.c))}</dd>` +
      (it.w ? `<dt>Size</dt><dd>${it.w} × ${it.h}${quality(it.w) ? " · " + quality(it.w) : ""}</dd>` : "") +
      (IS_VIDEO ? `<dt>Length</dt><dd>${fmtTime(it.d)}</dd>` : "") +
      (it.s ? `<dt>File</dt><dd>${fmtSize(it.s)}</dd>` : "") +
      `<dt>License</dt><dd><a href="https://pixabay.com/service/license-summary/" target="_blank" rel="noopener">Pixabay Content License</a></dd>`;
    $("#v-pixabay").href = it.p || "https://pixabay.com/";
    $(".stage .prev").hidden = index <= 0;
    $(".stage .next").hidden = index >= list.length - 1;
    if (!viewer.classList.contains("open")) openOverlay(viewer);
  }
  function step(d) {
    const n = viewIndex + d;
    if (n < 0 || n >= list.length) return;
    while (n >= shown && shown < list.length) appendBatch();   // keep the grid in step for later
    openViewer(n);
  }
  $(".stage .prev").addEventListener("click", () => step(-1));
  $(".stage .next").addEventListener("click", () => step(1));
  $("#v-download").addEventListener("click", () => startDownload(list[viewIndex]));

  // ---------------------------------------------------------------- download + pop-up
  const pop = $("#dlpop");
  const popPanel = $(".dl-panel");
  let abort = null;

  function setPop(state, it, extra) {
    popPanel.dataset.state = state;
    const name = fileName(it);
    const what = IS_VIDEO ? "video" : "photo";
    const head = { start: `Your ${what} is downloading…`, done: "Download complete!", fallback: `Your ${what} opened in a new tab` }[state];
    $("#dl-title").textContent = head;
    $("#dl-icon").innerHTML = state === "done" ? ICON.check : ICON.download;
    $("#dl-sub").innerHTML = state === "fallback"
      ? `Your browser didn't let us save it directly. In the new tab, right-click the ${what} and choose <b>Save ${what} as…</b> — keep the <b>Downloads</b> folder.`
      : `<b>${esc(name)}</b>${it.s ? " · " + fmtSize(it.s) : ""}`;
    $("#dl-credit").innerHTML = `${IS_VIDEO ? "Video" : "Photo"} by <a href="${authorUrl(it)}" target="_blank" rel="noopener">${esc(it.a)}</a> on <a href="${esc(it.p)}" target="_blank" rel="noopener">Pixabay</a>`;
    $("#dl-cancel").hidden = state !== "start";
    if (extra != null) $("#dl-progress-text").textContent = extra;
  }

  function setProgress(got, total) {
    const bar = $("#dl-bar");
    if (total > 0) {
      bar.classList.remove("indet");
      bar.firstElementChild.style.width = Math.min(100, (got / total) * 100).toFixed(1) + "%";
      $("#dl-progress-text").textContent = `${fmtSize(got) || "0 KB"} of ${fmtSize(total)}`;
    } else {
      bar.classList.add("indet");
      $("#dl-progress-text").textContent = got ? `${fmtSize(got)} downloaded` : "Starting…";
    }
  }

  async function startDownload(it) {
    if (!it) return;
    if (abort) abort.abort();
    abort = new AbortController();
    const mine = abort;
    const howto = $("#dl-howto");
    if (!howto.getAttribute("src")) howto.src = HOWTO_IMG;     // loaded the first time the pop-up opens
    setPop("start", it, "Starting…");
    setProgress(0, it.s || 0);
    openOverlay(pop);

    const name = fileName(it);
    try {
      const res = await fetch(it.f, { mode: "cors", signal: mine.signal, referrerPolicy: "no-referrer" });
      if (!res.ok || !res.body) throw new Error("HTTP " + res.status);
      const total = +res.headers.get("content-length") || it.s || 0;
      const reader = res.body.getReader();
      const parts = [];
      let got = 0, last = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        got += value.length;
        const now = performance.now();
        if (now - last > 120) { setProgress(got, total); last = now; }
      }
      setProgress(got, got);
      const blob = new Blob(parts, { type: res.headers.get("content-type") || (IS_VIDEO ? "video/mp4" : "image/jpeg") });
      parts.length = 0;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = name; a.rel = "noopener";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      if (abort === mine) { abort = null; setPop("done", it, "Saved in your Downloads folder."); }
    } catch (err) {
      if (mine.signal.aborted) return;
      // The file server didn't allow a direct save from this page (or the network failed):
      // let the browser open it in a tab instead, where it can be saved with one right-click.
      abort = null;
      const a = document.createElement("a");
      a.href = it.f; a.target = "_blank"; a.rel = "noopener noreferrer"; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setPop("fallback", it, "");
    }
  }
  $("#dl-cancel").addEventListener("click", () => { if (abort) abort.abort(); abort = null; closeOverlay(pop); });
  $("#dl-close").addEventListener("click", () => closeOverlay(pop));
  pop.addEventListener("click", (e) => { if ((e.target === pop || e.target.closest(".x")) && abort) { abort.abort(); abort = null; } });

  // ---------------------------------------------------------------- address bar (?c=nature&q=ocean)
  function syncUrl() {
    const p = new URLSearchParams();
    if (cat) p.set("c", cat);
    if (query) p.set("q", query);
    const s = p.toString();
    history.replaceState(null, "", location.pathname + (s ? "?" + s : ""));
  }

  // ---------------------------------------------------------------- start
  async function start() {
    try {
      const res = await fetch(DATA_URL, { cache: "no-cache" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      const items = Array.isArray(data) ? data : data.items || [];
      generated = data.generated || "";
      ALL = items.filter((it) => it && it.f && it.th);
      for (const it of ALL) {
        it._s = ((it.t || "") + " " + (it.a || "") + " " + it.c + " " + catName(it.c)).toLowerCase();
        counts[it.c] = (counts[it.c] || 0) + 1;
      }
      CATS = (data.categories || Object.keys(counts)).filter((c) => counts[c]);
    } catch (e) {
      $("#title").textContent = "The gallery could not be loaded";
      $("#empty").hidden = false;
      $("#empty").innerHTML = `<h2>Please try again in a moment</h2><p>(${esc(e.message)})</p>`;
      return;
    }

    const p = new URLSearchParams(location.search);
    cat = CATS.includes(p.get("c")) ? p.get("c") : "";
    query = (p.get("q") || "").trim();
    input.value = query;
    searchBox.classList.toggle("has-text", !!query);

    if (generated) {
      const d = new Date(generated);
      if (!isNaN(d)) $("#updated").textContent = ` Updated ${d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}.`;
    }
    buildChips();
    render();
  }

  $("#dl-store").href = STORE_URL;

  start();
})();
