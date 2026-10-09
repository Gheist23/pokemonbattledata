// Counting a creator collaboration, first-party and in the open.
//
// The whole client half of it is here. It sends ONE thing to ONE endpoint on
// this site: which step of the funnel was reached, and a 16-character id the
// browser invented for itself. No third-party script, no cookie, no consent
// banner, nothing that identifies a person, and nothing that can be joined up
// with anything else -- the id exists only so that reloading a page is not
// counted as a second person. functions/api/campaign/[code].js says what the
// server does with it, which is: overwrite one empty object.
//
// Every failure is silent on purpose. A counter that can show the visitor an
// error, block a click or delay a page is worse than no counter.

const ID_KEY = "cbd.visitor";

/** The browser's own id for itself. Random, kept locally, never sent anywhere
 *  but to this site's own endpoint. Falls back to a per-page id when storage is
 *  refused, which costs a little accuracy and nothing else. */
export function visitorId() {
  const make = () => {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  };
  try {
    const stored = localStorage.getItem(ID_KEY);
    if (stored && /^[0-9a-f]{16}$/.test(stored)) return stored;
    const made = make();
    localStorage.setItem(ID_KEY, made);
    return made;
  } catch {
    return make();
  }
}

/**
 * Record one step of one campaign.
 *
 * `keepalive` matters: the step that is worth the most -- the click that leaves
 * this page for the Team Builder -- happens while the page is being torn down,
 * and a plain fetch is cancelled with it.
 */
export function trackCampaign(code, step) {
  const clean = String(code || "").toLowerCase().replace(/[^a-z0-9-]/g, "");
  if (!clean) return;
  try {
    fetch(`/api/campaign/${clean}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ step, visitor: visitorId() }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    // No fetch, no network, a blocker: nothing here is worth a broken page.
  }
}
