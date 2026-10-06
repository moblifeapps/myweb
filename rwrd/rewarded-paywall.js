/* Rewarded paywall for mlapplications.com
 * Requires in <head>:
 *   <link rel="stylesheet" href="/css/paywall.css?v=1">
 *   <script async src="https://securepubads.g.doubleclick.net/tag/js/gpt.js"></script>
 *   <script defer src="/js/rewarded-paywall.js?v=1"></script>
 */
(function () {
  window.googletag = window.googletag || { cmd: [] };

  // ---------- Settings ----------
  const AD_UNIT_PATH = "/423204242/Offerwall_Live_Rewarded_code";
  const UNLOCK_KEY = "paywall_unlock";
  const UNLOCK_PAGES = 4;                  // pages per ad (current page counts as 1)
  const UNLOCK_DURATION = 25 * 60 * 1000;  // 25 minutes
  const PAYWALL_DELAY = 8 * 1000;          // minimum delay before paywall appears

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
    </div>`;

  let rewardedSlot = null;
  let rewardedEvent = null;
  let rewardEarned = false;
  let delayPassed = false;
  let adShowing = false;   // prevents double clicks from showing the ad twice

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

  function hidePaywall() {
    const overlay = getOverlay();
    if (overlay) overlay.classList.remove("active");
    if (document.body) document.body.style.overflow = "";
  }

  function maybeShowPaywall() {
    // Show only if: page locked, delay passed, and an ad is ready
    if (pageUnlocked || !delayPassed || !rewardedEvent) return;
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

  function onActionClick() {
    if (adShowing) return; // ad already opening/visible
    if (rewardedEvent) {
      adShowing = true;
      rewardedEvent.makeRewardedVisible();
    } else {
      // Rare: ad expired or slot was destroyed after the paywall appeared
      unlockPage();
    }
  }

  // ---------- GPT rewarded setup (only when the page is locked) ----------
  if (!pageUnlocked) {
    googletag.cmd.push(function () {
      rewardedSlot = googletag.defineOutOfPageSlot(
        AD_UNIT_PATH,
        googletag.enums.OutOfPageFormat.REWARDED
      );

      if (!rewardedSlot) {
        console.warn("Rewarded not supported on this page");
        return;
      }

      rewardedSlot.addService(googletag.pubads());

      googletag.pubads().addEventListener("rewardedSlotReady", function (evt) {
        if (evt.slot === rewardedSlot) {
          console.log("Rewarded ad ready");
          rewardedEvent = evt;
          maybeShowPaywall();
        }
      });

      googletag.pubads().addEventListener("rewardedSlotGranted", function (evt) {
        if (evt.slot === rewardedSlot) {
          console.log("Reward granted", evt.payload);
          rewardEarned = true;
        }
      });

      googletag.pubads().addEventListener("rewardedSlotClosed", function (evt) {
        if (evt.slot === rewardedSlot) {
          googletag.destroySlots([rewardedSlot]);
          rewardedEvent = null;
          adShowing = false;
          if (rewardEarned) {
            unlockPage();
          } else {
            hidePaywall(); // closed early: let them read this page, no unlock
          }
        }
      });

      googletag.pubads().addEventListener("slotRenderEnded", function (evt) {
        if (evt.slot === rewardedSlot) {
          console.log("Rewarded render ended, empty:", evt.isEmpty);
        }
      });

      googletag.enableServices();
      googletag.display(rewardedSlot);
    });
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
