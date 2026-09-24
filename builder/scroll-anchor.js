// Keeps what the player is looking at in the same place across a re-render.
//
// The Team Builder and the Damage Calculator redraw by emptying a container and
// building it again.  That throws away the browser's own scroll anchor: the browser
// can only hold a reading position steady while the element it anchored to is still
// there, so after a wholesale rebuild the page keeps its scroll offset while the
// content slides up or down by however much the parts above the screen changed.
// Removing a Pokemon, picking a move or flipping a field toggle then reads as the
// page jumping.
//
// keepPlace() does what scroll anchoring would have done:
//
//   const keepPosition = keepPlace("calc");   // where is everything on screen now?
//   ...redraw...
//   keepPosition();                           // put it back where it was
//
// It measures where everything on screen sits, and afterwards moves the page by the
// median of how far those things moved - the median, not one chosen anchor, because
// these pages lay their panels out in columns: when one column grows, holding a
// single element still can drag two untouched columns along with it, and the median
// is simply "did most of what I can see move, and by how much".
//
// Both halves run in the same task, before the frame is painted, so there is no
// visible two-step.  It does nothing on a view's first draw, nothing at the top of
// the page, and nothing when too little of what it measured can be found again -
// so it never invents a scroll of its own, and it cannot fight the player's
// scrolling, because it only ever runs inside a redraw the player asked for, and
// what it puts back is a difference and never a remembered scroll position.
//
// What it cannot do: on a wide screen the Team Builder is three columns side by side,
// and when one of them changes height - removing a Pokemon takes 128px out of the team
// column and leaves the other two alone - one scroll offset cannot hold all three
// still.  Scrolling by the median holds whichever part of the screen has most of the
// content on it, and the rest moves by the difference.  Narrower, where the columns
// stack, the whole page moves together and it holds everything.
//
// Position only: it does not read or change anything a view shows.

/** Views that have drawn once already. A first draw has no position to keep. */
const drawn = new Set();
/**
 * One keep at a time: a redraw nested inside another must not re-anchor.
 *
 * A token rather than a flag, cleared again by a microtask as well as by the
 * returned function: the two halves always run in one task, so the microtask is
 * late either way - but if a redraw throws between them the flag would otherwise
 * stay on and every later keep would quietly do nothing, which is exactly the kind
 * of failure nobody notices until the page starts jumping again.
 */
let armed = null;
const NOTHING = () => {};

/** Ignore slivers: a 1px rule is not something the player is reading. */
const MIN_SIZE = 6;
/** How deep to look. Deeper samples more of the text and less of the scaffolding. */
const MAX_DEPTH = 14;
/** Enough of the screen to take a median of. */
const MIN_MARKS = 3;
/** Plenty for a median; keeps the cost flat on a long page. */
const MAX_MARKS = 260;
/** Never move the page by more than this, whatever the measurement says. */
const MAX_ADJUST = 4000;

/** What an element looks like structurally: enough to tell "the same thing" from
 *  "something else now sits here". The first class is the structural one in these
 *  files ("bd-slot", "bd-result-row"); later ones are states like "on"/"selected". */
function shape(el) {
  const cls = el.getAttribute("class");
  const first = cls ? cls.trim().split(/\s+/)[0] : "";
  return `${el.tagName}|${first}|${el.childElementCount}`;
}

/** The element's own words - not its children's, which would cost a string as long
 *  as the page. Enough to recognise a row that only moved up by one. */
function ownText(el) {
  let text = "";
  for (let node = el.firstChild; node && text.length < 60; node = node.nextSibling) {
    if (node.nodeType === 3) text += node.data;
  }
  return text.replace(/\s+/g, " ").trim().slice(0, 48);
}

function identity(el) {
  return `${shape(el)}|${ownText(el)}`;
}

/** Child indexes from `stop` down to `el`, or null when `el` is not inside it. */
function pathTo(el, stop) {
  const path = [];
  let node = el;
  while (node && node !== stop) {
    const parent = node.parentElement;
    if (!parent) return null;
    let index = 0;
    for (const sibling of parent.children) {
      if (sibling === node) break;
      index += 1;
    }
    path.push(index);
    node = parent;
  }
  return node === stop ? path.reverse() : null;
}

function atPath(stop, path, drop = 0) {
  let node = stop;
  for (let i = 0; i < path.length - drop; i += 1) {
    node = node.children[path[i]];
    if (!node) return null;
  }
  return node;
}

/** A sticky or fixed element holds still against the viewport by design, so where it
 *  sits says nothing about where the page's content went. Skip it and its contents. */
function isPinned(el) {
  const position = getComputedStyle(el).position;
  return position === "fixed" || position === "sticky";
}

/** Everything on screen, with where it sits and how to find it again. */
function sample(scope) {
  const height = window.innerHeight || document.documentElement.clientHeight;
  const found = [];
  const walk = (el, depth) => {
    for (const child of el.children) {
      const tag = child.tagName;
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "LINK" || tag === "TEMPLATE" || tag === "DIALOG") continue;
      const rect = child.getBoundingClientRect();
      if (rect.height < MIN_SIZE || rect.width < MIN_SIZE) continue;
      if (rect.bottom <= 0) continue;                      // done with, above the screen
      if (rect.top > height) continue;                     // not reached yet, below it
      // Only what could be a mark, plus the page-level wrappers a pinned bar lives
      // in, is worth the cost of reading a computed style.
      if ((rect.top >= 0 || depth < 3) && isPinned(child)) continue;
      if (rect.top >= 0) found.push([child, rect.top]);
      if (depth < MAX_DEPTH) walk(child, depth + 1);
    }
  };
  walk(scope, 0);
  // Thin an over-full screen out evenly rather than keeping only its top.
  const step = found.length > MAX_MARKS ? Math.ceil(found.length / MAX_MARKS) : 1;
  const marks = [];
  for (let i = 0; i < found.length; i += step) {
    const [el, top] = found[i];
    const path = pathTo(el, scope);
    if (path) marks.push({ path, top, shape: shape(el), identity: identity(el) });
  }
  return marks;
}

/** The same element after the redraw: at its old place, or moved among its siblings
 *  (one above it was removed), or - as a last resort - whatever holds its place with
 *  the same shape, which covers an element whose text simply changed. */
function find(scope, mark) {
  const here = atPath(scope, mark.path);
  if (here && identity(here) === mark.identity) return here;
  if (mark.identity !== `${mark.shape}|`) {
    const parent = atPath(scope, mark.path, 1);
    if (parent) {
      const was = mark.path[mark.path.length - 1];
      for (let step = 1; step <= 3; step += 1) {
        for (const index of [was - step, was + step]) {
          const near = parent.children[index];
          if (near && identity(near) === mark.identity) return near;
        }
      }
    }
  }
  return here && shape(here) === mark.shape ? here : null;
}

/** Scroll without the smooth animation styles.css asks for site-wide. */
function jumpTo(top) {
  const html = document.documentElement;
  const had = html.style.scrollBehavior;
  html.style.scrollBehavior = "auto";
  try {
    window.scrollTo({ top, left: window.scrollX, behavior: "instant" });
  } catch {
    window.scrollTo(window.scrollX, top);
  }
  if (had) html.style.scrollBehavior = had;
  else html.style.removeProperty("scroll-behavior");
}

/**
 * Note where everything on screen sits; the returned function puts it back.
 *
 * @param {string} name  which view is redrawing, so its first draw is left alone
 * @returns {() => void} call once the new content is in the document
 */
export function keepPlace(name) {
  const first = !drawn.has(name);
  drawn.add(name);
  if (first || armed) return NOTHING;
  if (!window.scrollY) return NOTHING;                 // nothing above the screen to hold
  const scope = document.body;
  let marks;
  try {
    marks = sample(scope);
  } catch {
    return NOTHING;
  }
  if (marks.length < MIN_MARKS) return NOTHING;
  const token = {};
  armed = token;
  queueMicrotask(() => { if (armed === token) armed = null; });
  return () => {
    if (armed === token) armed = null;
    try {
      const moved = [];
      for (const mark of marks) {
        const el = find(scope, mark);
        if (el) moved.push(el.getBoundingClientRect().top - mark.top);
      }
      if (moved.length < MIN_MARKS) return;             // too little recognised to trust
      moved.sort((a, b) => a - b);
      const delta = moved[moved.length >> 1];
      if (Math.abs(delta) < 0.5 || Math.abs(delta) > MAX_ADJUST) return;
      jumpTo(Math.max(0, window.scrollY + delta));      // a page that really got shorter
    } catch {                                           // is clamped by the browser
      // a measurement is never worth breaking a redraw over
    }
  };
}
