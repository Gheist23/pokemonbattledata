// "Tell me when the meta moves against this team" -- the site's only way to
// reach somebody who has not bought anything.
//
// WHERE IT IS AND WHY.  In the team library, under the saved teams, and ONLY
// once there is a team with something in it.  Asking for an address on arrival
// is asking before anything has been given, and it is the reason most of these
// boxes are ignored; asking next to six Pokemon the visitor has just chosen is
// asking at the one moment the answer is obviously worth something to them.  A
// visitor with no team never sees it at all.
//
// WHAT IT SENDS: the address, the format, and the TITLES AND SPECIES NAMES of
// the teams.  Not sets, not spreads, not items -- the digest does not use them,
// and what is never sent cannot leak (functions/api/watch/_lib.js).
//
// It is a confirmed opt-in: the POST only creates a pending record and a
// confirmation mail, so this box cannot sign anybody up, including by accident
// and including the owner's own address typed to see what happens.

import { h, toast } from "./ui.js";
import { trackSite } from "./campaign-track.js";

const KEY = "cbd.watch.v1";
const MAX_TEAMS = 12;

function read() {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) || "null");
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

function write(value) {
  try {
    localStorage.setItem(KEY, JSON.stringify(value));
  } catch {
    // Private mode: the box reappears next visit, which is the harmless way
    // round. Nothing here is load-bearing.
  }
}

/** The teams worth watching, in the shape the endpoint stores.
 *
 *  `pristine` is the placeholder team store.js creates for a first visit and
 *  sync.js refuses to sync; a team with no species in it is one the visitor
 *  made and abandoned. Neither is something to promise to watch. */
export function watchPayload(state) {
  return (state?.teams || [])
    .filter((team) => !team.pristine && (team.team || []).some((entry) => entry && entry[0]))
    .slice(0, MAX_TEAMS)
    .map((team) => ({
      title: String(team.title || "Team"),
      members: (team.team || []).map((entry) => (entry && entry[0]) || "").filter(Boolean),
    }));
}

/**
 * Null when there is nothing to watch, so the caller can simply append it.
 *
 * `regulation` is the ruleset a creator campaign's teams were built for, out of
 * that campaign's own file -- "M-D", or "" for an ordinary visit. It changes only
 * the sentence, and it is here because of what the October 2026 collaboration
 * cost: 771 arrivals, and not one reachable afterwards, because this box did not
 * exist yet. The next regulation is the single best moment to ask -- somebody who
 * has just been handed five teams for a ruleset nobody has solved yet has an
 * obvious reason to want to hear how it moves, and a generic "the meta moves
 * every week" does not say that back to them.
 */
export function watchBlock(state, { onChange, regulation = "" } = {}) {
  const teams = watchPayload(state);
  if (!teams.length) return null;
  const reg = String(regulation || "").trim().replace(/[^A-Za-z0-9-]/g, "").slice(0, 12);

  const saved = read();
  const format = state?.format === "Singles" ? "Singles" : "Doubles";
  const host = h("div", { class: "bd-watch" });

  if (saved.email) {
    host.append(
      h("p", { class: "bd-watch-done" }, saved.confirmed
        ? `Watching ${teams.length === 1 ? "this team" : `these ${teams.length} teams`} in ${format}.`
        : "Check your inbox — there is a link to confirm the watch."),
      h("button", {
        type: "button", class: "bd-watch-reset",
        onclick: () => { write({}); onChange?.(); },
      }, "Use a different address"));
    return host;
  }

  const input = h("input", {
    type: "email", class: "bd-watch-input", placeholder: "you@example.com",
    autocomplete: "email", "aria-label": "Email address for meta alerts",
  });
  const button = h("button", { type: "button", class: "primary-button compact" }, "Watch the meta");

  const submit = async () => {
    const email = input.value.trim();
    if (!email || !email.includes("@")) {
      input.focus();
      return toast("Enter an email address.");
    }
    button.disabled = true;
    const previous = button.textContent;
    button.textContent = "Sending…";
    try {
      const response = await fetch("/api/watch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, format, teams: watchPayload(state) }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        toast(payload.error || "That did not work. Try again in a moment.", "warn");
        button.disabled = false;
        button.textContent = previous;
        return;
      }
      // Remembered so the box does not keep asking, but NOT as confirmed: only
      // the link in the mail can do that, and the copy above says so.
      write({ email, confirmed: false, at: Date.now() });
      trackSite("watch");
      toast(payload.message || "Check your inbox to confirm.");
      onChange?.();
    } catch {
      toast("That did not work. Try again in a moment.", "warn");
      button.disabled = false;
      button.textContent = previous;
    }
  };

  button.addEventListener("click", submit);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); submit(); }
  });

  host.append(
    h("p", { class: "bd-watch-pitch" },
      ...(reg
        // A new ruleset has no settled meta yet, which is the whole reason to ask
        // to be told: the first week of ladder data is the answer nobody has.
        ? [`Regulation ${reg} is new — nobody knows what wins yet. The ladder will, within a week. `,
          "Get a note when it moves against ",
          h("strong", {}, teams.length === 1 ? "this team" : `these ${teams.length} teams`), "."]
        : ["The meta moves every week. Get a note when it moves against ",
          h("strong", {}, teams.length === 1 ? "this team" : `your ${teams.length} teams`), "."])),
    h("div", { class: "bd-watch-row" }, input, button),
    h("p", { class: "bd-watch-small" },
      "One mail a week at most, only when something actually moved. We keep your address and the ",
      "species names in these teams — nothing else — and every mail has a one-click unsubscribe ",
      "that deletes the lot. You will get a confirmation link first; nothing is sent until you open it."));
  return host;
}
