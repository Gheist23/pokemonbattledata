// "There is a game now."
//
// One strip at the bottom of the page, offering a battle against the Solver. It is the only
// thing on the site that interrupts anybody, so it is held to three rules:
//
//   * once a visit, not once a page. Moving between the Team Builder and the Explorer is one
//     visit and must not be three banners.
//   * dismissed is dismissed, for good. The answer is kept in localStorage, not in the session,
//     so "no" survives closing the tab.
//   * it never appears on the page it is advertising, and never on top of a game in progress.
//
// Nothing here throws into a page's boot: a visitor whose storage is switched off gets the
// banner every visit, which is the right way round, and a visitor whose page has no footer gets
// no banner at all rather than a broken one.

const KEY = "cbd.play.banner.v1";
const SESSION = "cbd.play.banner.session";

function dismissed() {
  try {
    return localStorage.getItem(KEY) === "no";
  } catch {
    return false;
  }
}

function shownThisVisit() {
  try {
    return sessionStorage.getItem(SESSION) === "1";
  } catch {
    return false;
  }
}

function markShown() {
  try { sessionStorage.setItem(SESSION, "1"); } catch { /* nothing to do */ }
}

function markDismissed() {
  try { localStorage.setItem(KEY, "no"); } catch { /* nothing to do */ }
}

/**
 * Offer the game, once.
 *
 * Call it from any page's boot. It decides for itself whether this is a moment to ask.
 */
export function offerPlay({ delayMs = 1200 } = {}) {
  try {
    if (location.pathname.startsWith("/play")) return;
    if (dismissed() || shownThisVisit()) return;
  } catch {
    return;
  }
  setTimeout(() => {
    if (document.querySelector(".bd-play-banner")) return;
    markShown();
    const strip = document.createElement("div");
    strip.className = "bd-play-banner";
    strip.setAttribute("role", "region");
    strip.setAttribute("aria-label", "Play against the Solver");
    strip.innerHTML = '<p><strong>Play against the AI now.</strong>'
      + "A real game: it brings a tournament team, looks ten turns ahead, and cannot see your sets."
      + '</p><span class="bd-play-banner-actions">'
      + '<a class="primary-button" href="/play/">Play</a>'
      + '<button type="button" class="ghost-button" data-close>Not now</button>'
      + "</span>";
    strip.querySelector("[data-close]").addEventListener("click", () => {
      markDismissed();
      strip.remove();
    });
    document.body.appendChild(strip);
  }, Math.max(0, delayMs));
}
