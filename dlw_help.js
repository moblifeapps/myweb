/* Desktop Live Wallpaper+ Help Center - the Up button, and the 4K picks on the two gallery pages. */
(function () {
  "use strict";

  // ---- Up button: shown once the page has been scrolled a little
  const up = document.querySelector(".hc-up");
  if (up) {
    const sync = () => up.classList.toggle("show", window.scrollY > 500);
    window.addEventListener("scroll", sync, { passive: true });
    sync();
    up.addEventListener("click", () => window.scrollTo({ top: 0 }));
  }

  // ---- keep the current tab visible in the (scrollable) tab bar on phones
  const cur = document.querySelector('.hc-tab[aria-current="page"]');
  if (cur && cur.parentElement.scrollWidth > cur.parentElement.clientWidth) cur.scrollIntoView({ block: "nearest", inline: "center" });

  // ---- 4K picks: one item per category from the gallery catalog, a different one each day
  const grid = document.getElementById("picks");
  if (!grid) return;
  const kind = grid.dataset.kind === "photos" ? "photos" : "videos";
  const CATS = ["backgrounds", "nature", "places", "travel", "animals", "science", "music", "transportation", "buildings", "people",
    "feelings", "religion", "health", "food", "sports", "fashion", "education", "computer", "industry", "business"];
  const NAMES = { backgrounds: "Backgrounds", nature: "Nature", places: "Places", travel: "Travel", animals: "Animals",
    science: "Science & Space", music: "Music", transportation: "Transport", buildings: "Buildings", people: "People",
    feelings: "Feelings", religion: "Religion", health: "Health", food: "Food & Drink", sports: "Sports", fashion: "Fashion",
    education: "Education", computer: "Computer & Tech", industry: "Industry", business: "Business" };
  const page = `desktop_live_gallery_${kind}.html`;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  grid.innerHTML = '<div class="picks-skel"></div>'.repeat(8);

  fetch(`pixabay_${kind}.json`, { cache: "no-cache" })
    .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then((d) => {
      const items = Array.isArray(d) ? d : d.items || [];
      const day = Math.floor(Date.now() / 864e5);
      const out = [];
      for (const c of CATS) {
        const all = items.filter((it) => it.c === c && it.th);
        if (!all.length) continue;
        const uhd = all.filter((it) => (it.w || 0) >= 3840);
        const pool = uhd.length ? uhd : all.slice().sort((a, b) => (b.w || 0) - (a.w || 0)).slice(0, 5);
        let h = 0; for (const ch of c) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
        out.push(pool[(day + h) % pool.length]);
      }
      grid.innerHTML = out.map((it) => {
        const q = (it.w || 0) >= 3840 ? "4K" : (it.w || 0) >= 2560 ? "2K" : "HD";
        return `<a class="pick" href="${page}?c=${encodeURIComponent(it.c)}" data-pv="${esc(it.pv || "")}">` +
          `<span class="pick-thumb"><img loading="lazy" decoding="async" alt="${esc(NAMES[it.c] || it.c)} ${kind === "videos" ? "video" : "photo"} wallpaper" src="${esc(it.th)}" onload="this.classList.add('ok')">` +
          `<span class="pick-q">${q}</span><span class="pick-cat">${esc(NAMES[it.c] || it.c)}</span></span>` +
          `<span class="pick-more">Explore more <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg></span></a>`;
      }).join("");
    })
    .catch(() => {
      grid.innerHTML = `<p>The picks could not be loaded right now – <a href="${page}">open the gallery</a> to browse everything.</p>`;
    });

  // videos: a small preview plays while the pointer rests on a card
  if (kind === "videos" && window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
    let t = 0, v = null;
    const stop = () => { if (v) { v.pause(); v.removeAttribute("src"); v.load(); v.remove(); v = null; } };
    grid.addEventListener("pointerover", (e) => {
      const a = e.target.closest(".pick");
      if (!a || a.contains(e.relatedTarget) || !a.dataset.pv) return;
      clearTimeout(t);
      t = setTimeout(() => {
        stop();
        v = document.createElement("video");
        v.muted = true; v.loop = true; v.playsInline = true; v.autoplay = true; v.setAttribute("muted", "");
        v.src = a.dataset.pv;
        v.addEventListener("playing", () => v && v.classList.add("on"), { once: true });
        a.querySelector(".pick-thumb").appendChild(v);
      }, 250);
    });
    grid.addEventListener("pointerout", (e) => {
      const a = e.target.closest(".pick");
      if (!a || a.contains(e.relatedTarget)) return;
      clearTimeout(t);
      if (v && a.contains(v)) stop();
    });
  }
})();
