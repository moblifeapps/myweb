/* Rewarded paywall for mlapplications.com — v2 (video + display-only fallback)
 * Requires in <head>:
 *   <link rel="stylesheet" href="/css/paywall.css?v=2">
 *   <script async src="https://securepubads.g.doubleclick.net/tag/js/gpt.js"></script>
 *   <script defer src="/js/rewarded-paywall.js?v=2"></script>
 *
 * Flow:
 *   1. Load the PRIMARY rewarded unit (video allowed, higher CPM).
 *   2. If it comes back empty, gets stuck (e.g. black-screen video), or the user
 *      closes it without earning the reward -> destroy it and load the FALLBACK
 *      unit (Ad Manager protection blocks video there, so display ads only).
 *   3. If the fallback also fails -> give up cleanly (no loops, max 2 ad requests).
 */
(function () {
  window.googletag = window.googletag || { cmd: [] };

  // ---------- Settings ----------
  const AD_UNITS = [
    "/423204242/Offerwall_Live_Rewarded_code",   // primary: video allowed
    "/423204242/Offerwall_Rewarded_Fallback"     // fallback: video blocked by protection
  ];
  const UNLOCK_KEY = "paywall_unlock";
  const UNLOCK_PAGES = 4;                   // pages per ad (current page counts as 1)
  const UNLOCK_DURATION = 25 * 60 * 1000;   // 25 minutes
  const PAYWALL_DELAY = 8 * 1000;           // minimum delay before paywall appears
  // Safety net only: no reward and no close after this -> assume the ad is stuck.
  // Reward fires at the END of the video, so this must stay longer than real ads
  // (most rewarded videos are 15-30s). The fast path is the user pressing X,
  // which switches to the fallback immediately.
  const AD_WATCHDOG = 35 * 1000;
  const FALLBACK_READY_WAIT = 12 * 1000;    // max wait for the fallback ad to become ready
  const UNLOCK_ON_FAILURE = true;           // if the user tried but every ad failed, unlock anyway

  // ---------- Paywall HTML ----------
  const PAYWALL_HTML = `
    <div class="paywall-card">
      <img src="/uploads/logo-big_2.webp" alt="Logo" class="paywall-logo">
      <h2>Unlock more content</h2>
      <p>Take action to continue accessing the content on this site</p>
      <div class="paywall-action-box" id="paywall-action-trigger" role="button" tabindex="0">
        <div class="paywall-action-text">
          <h4>View a short ad</h4>
          <span>Unlock your next 4 pages</span>
        </div>
        <div class="paywall-icon-btn">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>
        </div>
      </div>
      <p class="paywall-hint">Ad not playing? Close it with ✕ to get another one.</p>
      <p class="paywall-status" id="paywall-status" role="status" aria-live="polite" hidden></p>
    </div>`;

  // ---------- State ----------
  let unitIndex = 0;          // 0 = primary, 1 = fallback
  let rewardedSlot = null;
  let rewardedEvent = null;
  let rewardEarned = false;
  let delayPassed = false;
  let adShowing = false;      // prevents double clicks from showing the ad twice
  let userTried = false;      // user clicked "View a short ad" at least once
  let finished = false;       // unlocked or gave up: ignore any late events
  let watchdogTimer = null;
  let fallbackTimer = null;
  let listenersAdded = false;

  // ---------- Logging (console + GA4 if present) ----------
  function track(name) {
    const unit = unitIndex === 0 ? "primary" : "fallback";
    console.log("[paywall]", name, "(" + unit + ")");
    if (typeof window.gtag === "function") {
      window.gtag("event", "paywall_" + name, { ad_unit: unit });
    }
  }

  // ---------- Unlock state: { until: timestamp, pagesLeft: number } ----------
  function readUnlock() {
    try { return JSON.parse(localStorage.getItem(UNLOCK_KEY)) || null; }
    catch (e) { return null; }
  }

  function writeUnlock(state) {
    try { localStorage.setItem(UNLOCK_KEY, JSON.stringify(state)); } catch (e) {}
  }

  function consumePageView() {
    const s = readUnlock();
    if (!s || Date.now() >= s.until || s.pagesLeft <= 0) {
      try { localStorage.removeItem(UNLOCK_KEY); } catch (e) {}
      return false;
    }
    s.pagesLeft -= 1;
    writeUnlock(s);
    return true;
  }

  let pageUnlocked = consumePageView();

  // ---------- Paywall show/hide ----------
  function getOverlay() {
    return document.getElementById("custom-paywall-overlay");
  }

  function createOverlay() {
    if (getOverlay()) return getOverlay(); // already on the page
    const overlay = document.createElement("div");
    overlay.id = "custom-paywall-overlay";
    overlay.innerHTML = PAYWALL_HTML;
    document.body.appendChild(overlay);
    return overlay;
  }

  function setStatus(text) {
    const el = document.getElementById("paywall-status");
    if (!el) return;
    el.textContent = text || "";
    el.hidden = !text;
  }

  function hidePaywall() {
    const overlay = getOverlay();
    if (overlay) overlay.classList.remove("active");
    if (document.body) document.body.style.overflow = "";
  }

  function maybeShowPaywall() {
    // Show only if: page locked, delay passed, and an ad is ready
    if (finished || pageUnlocked || !delayPassed || !rewardedEvent) return;
    const overlay = getOverlay();
    if (overlay) {
      overlay.classList.add("active");
      document.body.style.overflow = "hidden";
    }
  }

  function unlockPage() {
    writeUnlock({ until: Date.now() + UNLOCK_DURATION, pagesLeft: UNLOCK_PAGES - 1 });
    pageUnlocked = true;
    hidePaywall();
  }

  // ---------- Slot lifecycle ----------
  function teardownSlot() {
    clearTimeout(watchdogTimer);
    watchdogTimer = null;
    if (rewardedSlot && window.googletag && googletag.destroySlots) {
      googletag.destroySlots([rewardedSlot]);
    }
    rewardedSlot = null;
    rewardedEvent = null;
    adShowing = false;
  }

  // Both units failed (or rewarded isn't supported): stop, never loop.
  function giveUp(reason) {
    if (finished) return;
    track("gave_up_" + reason);
    teardownSlot();
    clearTimeout(fallbackTimer);
    fallbackTimer = null;
    finished = true;
    setStatus("");
    if (userTried && UNLOCK_ON_FAILURE) {
      unlockPage();
    } else {
      hidePaywall();
    }
  }

  // Switch from the primary unit to the display-only fallback (once).
  function tryFallback(reason) {
    if (finished) return;
    track("fallback_" + reason);
    teardownSlot();
    if (unitIndex >= AD_UNITS.length - 1) {
      giveUp(reason);
      return;
    }
    unitIndex++;
    rewardEarned = false;
    setStatus("Loading another ad…");
    clearTimeout(fallbackTimer);
    fallbackTimer = setTimeout(function () {
      fallbackTimer = null;
      giveUp("fallback_timeout");
    }, FALLBACK_READY_WAIT);
    loadSlot();
  }

  // Ad was made visible but neither granted a reward nor closed in time.
  function onAdStuck() {
    watchdogTimer = null;
    if (finished || rewardEarned) return; // reward earned, user just hasn't closed yet
    tryFallback("stuck");
  }

  function onActionClick() {
    if (adShowing || finished) return; // ad already opening/visible
    if (rewardedEvent) {
      adShowing = true;
      userTried = true;
      setStatus("");
      track("ad_shown");
      rewardedEvent.makeRewardedVisible();
      clearTimeout(watchdogTimer);
      watchdogTimer = setTimeout(onAdStuck, AD_WATCHDOG);
    } else if (fallbackTimer) {
      // Fallback ad still loading; the status line already says so
      return;
    } else {
      // Rare: ad expired or slot was destroyed after the paywall appeared
      unlockPage();
    }
  }

  // ---------- GPT rewarded setup (only when the page is locked) ----------
  // Waits for the other ad wrapper on the page to finish its own GPT setup
  // (enableServices), so this script never locks GPT settings before it.
  const WRAPPER_WAIT_MAX = 5000;  // max wait for the other wrapper (ms)
  const WRAPPER_POLL = 250;

  function whenGptReadyForUs(fn) {
    const start = Date.now();
    (function check() {
      const ready = window.googletag && googletag.apiReady && googletag.pubadsReady;
      if (ready || Date.now() - start >= WRAPPER_WAIT_MAX) {
        fn();
      } else {
        setTimeout(check, WRAPPER_POLL);
      }
    })();
  }

  function initialLoadDisabled() {
    try {
      if (typeof googletag.getConfig === "function") {
        return !!googletag.getConfig("disableInitialLoad");
      }
      return googletag.pubads().isInitialLoadDisabled();
    } catch (e) { return false; }
  }

  // Listeners are registered once and always compare against the CURRENT slot,
  // so events from a destroyed slot are ignored.
  function addListenersOnce() {
    if (listenersAdded) return;
    listenersAdded = true;
    const pubads = googletag.pubads();

    pubads.addEventListener("rewardedSlotReady", function (evt) {
      if (evt.slot !== rewardedSlot || finished) return;
      clearTimeout(fallbackTimer);
      fallbackTimer = null;
      rewardedEvent = evt;
      setStatus("");
      track("ad_ready");
      maybeShowPaywall();
    });

    pubads.addEventListener("rewardedSlotGranted", function (evt) {
      if (evt.slot !== rewardedSlot || finished) return;
      rewardEarned = true;
      clearTimeout(watchdogTimer);
      watchdogTimer = null;
      track("reward_granted");
    });

    pubads.addEventListener("rewardedSlotClosed", function (evt) {
      if (evt.slot !== rewardedSlot || finished) return;
      if (rewardEarned) {
        track("unlocked");
        teardownSlot();
        finished = true;
        unlockPage();
        return;
      }
      track("closed_early");
      if (unitIndex === 0) {
        // Could be a black-screen video the user had to close: offer the fallback
        tryFallback("closed_early");
      } else {
        // Closed the fallback early: let them read this page, no unlock
        teardownSlot();
        finished = true;
        hidePaywall();
      }
    });

    pubads.addEventListener("slotRenderEnded", function (evt) {
      if (evt.slot !== rewardedSlot || finished) return;
      console.log("[paywall] render ended, empty:", evt.isEmpty);
      if (evt.isEmpty) tryFallback("empty"); // on the fallback unit this gives up
    });
  }

  function loadSlot() {
    googletag.cmd.push(function () {
      if (finished) return;
      addListenersOnce();

      rewardedSlot = googletag.defineOutOfPageSlot(
        AD_UNITS[unitIndex],
        googletag.enums.OutOfPageFormat.REWARDED
      );

      if (!rewardedSlot) {
        console.warn("[paywall] Rewarded not supported on this page");
        giveUp("unsupported");
        return;
      }

      rewardedSlot.addService(googletag.pubads());

      // Don't call enableServices if the other wrapper (or our first load) already did
      if (!googletag.pubadsReady) googletag.enableServices();

      googletag.display(rewardedSlot);
      // If the other wrapper disabled initial load, display() won't fetch: refresh only our slot
      if (initialLoadDisabled()) googletag.pubads().refresh([rewardedSlot]);
    });
  }

  if (!pageUnlocked) {
    if (document.readyState === "complete") {
      whenGptReadyForUs(loadSlot);
    } else {
      window.addEventListener("load", function () {
        whenGptReadyForUs(loadSlot);
      });
    }
  }

  // ---------- Page ready ----------
  function onReady(fn) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", fn);
    } else {
      fn();
    }
  }

  onReady(function () {
    if (pageUnlocked) return; // nothing to show on unlocked pages

    createOverlay();

    const actionTrigger = document.getElementById("paywall-action-trigger");
    if (actionTrigger) {
      actionTrigger.addEventListener("click", onActionClick);
      actionTrigger.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onActionClick();
        }
      });
    }

    setTimeout(function () {
      delayPassed = true;
      maybeShowPaywall();
    }, PAYWALL_DELAY);
  });
})();
