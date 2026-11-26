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
// WHICH TEAMS, AND WHY IT IS A CHOICE.  This used to watch every saved team
// there was, up to twelve.  A team library is not twelve teams somebody plays:
// it is one or two they play and ten they were trying something in -- a test
// team, a half-built idea, a copy with one slot swapped.  A weekly mail saying
// the meta moved against an experiment nobody is going to bring is worth
// nothing, and the mail that matters gets lost among them.  So the watch is on
// the teams the visitor TICKS, it defaults to the one they are working on, and
// the list can be changed afterwards from the same place without touching the
// address.
//
// WHAT IT SENDS: the address, the format, and the TITLES AND SPECIES NAMES of
// the chosen teams.  Not sets, not spreads, not items -- the digest does not use
// them, and what is never sent cannot leak (functions/api/watch/_lib.js).
//
// It is a confirmed opt-in: the POST only creates a pending record and a
// confirmation mail, so this box cannot sign anybody up, including by accident
// and including the owner's own address typed to see what happens.  A later
// POST from the same address does not mail again -- it refreshes the watched
// teams, which is exactly what changing the selection needs.

import { h, toast } from "./ui.js";
import { trackSite } from "./campaign-track.js";

const KEY = "cbd.watch.v1";
const MAX_TEAMS = 12;

/** Whether the picker is open. Module scope, because `onChange` re-renders the
 *  whole library and the block is rebuilt from scratch when it does. */
let editing = false;

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

/** The teams that CAN be watched.
 *
 *  `pristine` is the placeholder team store.js creates for a first visit and
 *  sync.js refuses to sync; a team with no species in it is one the visitor
 *  made and abandoned. Neither is something to promise to watch. */
export function watchable(state) {
  return (state?.teams || [])
    .filter((team) => !team.pristine && (team.team || []).some((entry) => entry && entry[0]))
    .slice(0, MAX_TEAMS);
}

/**
 * Which of them are ticked, as a Set of team ids.
 *
 * Stored ids are filtered against the live library, so a team that has since
 * been deleted or emptied drops out rather than being watched for ever.
 *
 * Three cases, and the middle one is the one worth being careful about:
 *
 *   * a stored list is the answer, EMPTY INCLUDED -- somebody who has unticked
 *     everything has said something, and defaulting over it would put teams
 *     back that they took off;
 *   * an address with NO stored list is somebody who signed up before there was
 *     a choice, and the server holds every team they had, because that is what
 *     this box used to send. The receipt has to say that rather than invent a
 *     narrower list the server does not have;
 *   * and a first visit defaults to the ONE team being worked on. Not all of
 *     them, which is the behaviour this picker exists to replace; and not none,
 *     because a box whose button refuses until something is ticked asks the
 *     visitor to do two things instead of one.
 */
function pickedIds(state, saved) {
  const teams = watchable(state);
  const ids = new Set(teams.map((team) => team.id));
  if (Array.isArray(saved.picked)) return new Set(saved.picked.filter((id) => ids.has(id)));
  if (saved.email) return ids;
  const current = teams.find((team) => team.id === state?.selectedTeamId);
  return new Set([(current || teams[0])?.id].filter(Boolean));
}

/** The chosen teams, in the shape the endpoint stores. */
export function watchPayload(state, picked) {
  const chosen = picked || pickedIds(state, read());
  return watchable(state)
    .filter((team) => chosen.has(team.id))
    .map((team) => ({
      title: String(team.title || "Team"),
      members: (team.team || []).map((entry) => (entry && entry[0]) || "").filter(Boolean),
    }));
}

/** "this team" / "these 3 teams" -- the phrase the pitch and the receipt share. */
const countPhrase = (n, near = true) => {
  if (n === 1) return near ? "this team" : "1 team";
  if (n === 0) return "no teams";
  return `${near ? "these " : ""}${n} teams`;
};

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
  const teams = watchable(state);
  if (!teams.length) return null;
  const reg = String(regulation || "").trim().replace(/[^A-Za-z0-9-]/g, "").slice(0, 12);

  const saved = read();
  const format = state?.format === "Singles" ? "Singles" : "Doubles";
  const host = h("div", { class: "bd-watch" });
  // The working copy of the selection. Nothing is written until the visitor
  // does something with it, so opening the picker and closing it again changes
  // nothing at all.
  const picked = pickedIds(state, saved);

  /**
   * One row per team, with a tick. The sprites are deliberately not here: the
   * title is what the visitor named it and is how they tell their own teams
   * apart, and six sprites a row over twelve rows is a wall.
   */
  const chooser = (onToggle) => h("div", { class: "bd-watch-teams" }, teams.map((team) => {
    const box = h("input", {
      type: "checkbox",
      class: "bd-watch-tick",
      checked: picked.has(team.id) ? "checked" : undefined,
    });
    box.addEventListener("change", () => {
      if (box.checked) picked.add(team.id);
      else picked.delete(team.id);
      onToggle?.();
    });
    const members = (team.team || []).map((entry) => (entry && entry[0]) || "").filter(Boolean);
    return h("label", { class: "bd-watch-team" }, box,
      h("span", { class: "bd-watch-team-title" }, String(team.title || "Team")),
      h("span", { class: "bd-watch-team-mons" }, members.join(", ") || "Empty"));
  }));

  /** Send the selection. Used by both the first sign-up and every change after. */
  const send = async (email, { changing = false } = {}) => {
    const chosen = watchPayload(state, picked);
    let response;
    let payload = {};
    try {
      response = await fetch("/api/watch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, format, teams: chosen }),
      });
      payload = await response.json().catch(() => ({}));
    } catch {
      response = null;
    }
    if (!response || !response.ok) {
      // A CHANGE says its own thing, because the selection IS saved in the
      // browser either way and the next successful POST carries it.
      if (!changing) toast(payload.error || "That did not work. Try again in a moment.", "warn");
      return false;
    }
    // A CHANGE IS NOT A SIGN-UP, and the endpoint cannot tell us apart: it
    // answers "check your inbox" to every POST on purpose, so that nobody can
    // ask it whether an address is on the list. For somebody already on it
    // that sentence is wrong, so the receipt for a change is written here.
    toast(changing
      ? `Watching ${countPhrase(chosen.length, false)} in ${format}.`
      : payload.message || "Check your inbox to confirm.");
    return true;
  };

  // --- already asked: the receipt, and the way to change the list -----------

  if (saved.email && !editing) {
    const watched = watchPayload(state, picked);
    host.append(
      h("p", { class: "bd-watch-done" }, !saved.confirmed
        ? "Check your inbox — there is a link to confirm the watch."
        // Nothing ticked is a real state -- somebody can untick everything, and the next
        // sentence says what that means -- so it must not come out as "these 0 teams".
        : watched.length
          ? `Watching ${countPhrase(watched.length)} in ${format}:`
          : `Nothing is being watched in ${format}.`),
      // NAMED, not counted. "Watching 3 teams" is the sentence that makes
      // somebody wonder which three, and the answer is the whole point of the
      // picker -- so the titles are here whether or not the watch is confirmed.
      h("p", { class: "bd-watch-small" }, watched.length
        ? watched.map((team) => team.title).join(" · ")
        : "No teams chosen yet, so no mail will be sent."),
      h("div", { class: "bd-watch-row-actions" },
        h("button", {
          type: "button", class: "bd-watch-reset",
          onclick: () => { editing = true; onChange?.(); },
        }, "Change teams"),
        h("button", {
          type: "button", class: "bd-watch-reset",
          onclick: () => { write({}); editing = false; onChange?.(); },
        }, "Use a different address")));
    return host;
  }

  if (saved.email && editing) {
    const note = h("p", { class: "bd-watch-pitch" }, `Watching ${countPhrase(picked.size, false)} in ${format}.`);
    const save = h("button", { type: "button", class: "primary-button compact" }, "Save");
    save.addEventListener("click", async () => {
      save.disabled = true;
      save.textContent = "Saving…";
      const stored = read();
      write({ ...stored, picked: [...picked] });
      const sent = await send(saved.email, { changing: true });
      editing = false;
      if (!sent) toast("Saved here, but the server did not take it. It will go up next time.", "warn");
      onChange?.();
    });
    host.append(
      note,
      chooser(() => { note.textContent = `Watching ${countPhrase(picked.size, false)} in ${format}.`; }),
      h("div", { class: "bd-watch-row-actions" },
        save,
        h("button", {
          type: "button", class: "bd-watch-reset",
          onclick: () => { editing = false; onChange?.(); },
        }, "Cancel")));
    return host;
  }

  // --- not asked yet: the pitch, the picker and the address ------------------

  const input = h("input", {
    type: "email", class: "bd-watch-input", placeholder: "you@example.com",
    autocomplete: "email", "aria-label": "Email address for meta alerts",
  });
  const button = h("button", { type: "button", class: "primary-button compact" }, "Watch the meta");
  const subject = h("strong", {}, countPhrase(picked.size));

  const submit = async () => {
    const email = input.value.trim();
    if (!email || !email.includes("@")) {
      input.focus();
      return toast("Enter an email address.");
    }
    // A watch on nothing would be a weekly mail about nothing. Said plainly,
    // because the visitor can fix it and is looking at the list right now.
    if (!picked.size) return toast("Tick at least one team to watch.");
    button.disabled = true;
    const previous = button.textContent;
    button.textContent = "Sending…";
    // Remembered so the box does not keep asking, but NOT as confirmed: only
    // the link in the mail can do that, and the copy below says so. The picks
    // are stored with it, so they survive the visit that made them.
    const ok = await send(email);
    if (!ok) {
      button.disabled = false;
      button.textContent = previous;
      return;
    }
    write({ email, confirmed: false, at: Date.now(), picked: [...picked] });
    trackSite("watch");
    onChange?.();
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
          "Get a note when it moves against ", subject, "."]
        : ["The meta moves every week. Get a note when it moves against ", subject, "."])),
    // THE PICKER, above the address. A library is mostly experiments, and a
    // mail about one of those is worse than no mail at all -- so which teams
    // this is for is asked before the address, not after it.
    teams.length > 1
      ? chooser(() => {
        subject.textContent = countPhrase(picked.size);
        // Stored as it is ticked, with no address and nothing sent anywhere:
        // the library re-renders for its own reasons (a team edited, a sync
        // arriving) and a selection held only in this closure would be thrown
        // away by one of them.
        write({ ...read(), picked: [...picked] });
      })
      : null,
    h("div", { class: "bd-watch-row" }, input, button),
    h("p", { class: "bd-watch-small" },
      "One mail a week at most, only when something actually moved. We keep your address and the ",
      "species names in the teams you tick — nothing else — and every mail has a one-click ",
      "unsubscribe that deletes the lot. You will get a confirmation link first; ",
      "nothing is sent until you open it. You can change which teams at any time from here."));
  return host;
}
