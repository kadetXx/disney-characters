import gsap from "gsap";
import { modelProgress, onModelProgress } from "./three/viewer.js";

/* ------------------------------------------------------------------ */
/* The loading gate                                                    */
/* ------------------------------------------------------------------ */

// A white sheet over the whole page, carrying the Disney mark, which fills with
// ink as the characters arrive -- and then, rather than fading off, flies up
// into the nav's own logo slot and becomes the logo. The page is only brought
// in once it has landed, so the loader and the content are never on screen
// together and there is nothing for the eye to catch between the two.
//
// The markup is in index.html rather than built here, because everything in
// this module sits behind three.js: anything built by the bundle can only
// appear after the bundle has loaded, which is exactly the stretch the sheet
// exists to cover. By the time this runs it is already on screen.

const sheet = document.getElementById("loading");
const mark = document.getElementById("loadingMark");

// What the fill is split between. The bytes are only half of the wait: these
// models are 15-27MB of meshopt geometry and the decode plus GPU upload costs
// about as much again -- measured on this project, every file had arrived by
// 4.3s and nothing was on screen until 12.8s. A bar driven by bytes alone
// would therefore sit full for seconds at the end, which reads as a hang. So
// each character owns an equal slice of the fill, and pays it out half for
// arriving and half for actually being drawn.
const DOWNLOAD_SHARE = 0.5;

// What the mark shows before any character has reported anything. Matches the
// value the stylesheet starts it at, so the bundle taking over is not a jump.
const FILL_FLOOR = 0.06;

// Long enough that a warm cache does not flash the sheet up and rip it away
// again -- under about this, a reveal reads as a glitch rather than an entrance.
const MINIMUM_MS = 600;

// Nothing may hold the page shut forever. Well past the 12.8s worst case
// measured above, so it only ever fires for a load that has genuinely failed
// (a model 404, an exhausted GPU) rather than one that is merely slow.
const GIVE_UP_MS = 25000;

// How fast the fill chases the truth. The paint half arrives in steps -- one
// per character, a quarter of that half each on a four-card desktop -- and a
// step applied outright is a jump; eased over this it reads as the fill
// running on rather than being nudged.
const CHASE_SECONDS = 0.45;

// The reveal, in order. The fill runs out to full, holds long enough to be
// seen finishing, flies into the nav, then the page comes in under it.
const FILL_OUT_SECONDS = 0.3;
const HOLD_SECONDS = 0.22;
const TRAVEL_SECONDS = 0.62;
// How long BEFORE the mark lands the page starts arriving. The two overlap
// rather than queue: power3.inOut spends its last stretch barely moving, so by
// this point the mark is up in the nav and all but home, and the row can start
// dealing itself in underneath without the two ever being in the same part of
// the screen. Waiting for the landing outright left a beat of finished white
// page between the loader and the content.
//
// This is the lever for how connected the two read. It cannot go much past
// half the flight: the row can only start once the sheet's white has gone, so
// buying the cards an earlier start spends it by uncovering the page under a
// mark that is still large and mid-screen. What makes the current value safe
// is that the page arrives over PAGE_FADE_SECONDS rather than at once -- by
// the time there is enough of it to see, the mark is small and nearly home.
const PAGE_IN_LEAD = 0.3;
const PAGE_FADE_SECONDS = 0.44;

let gated = null; // the model urls this load is waiting on
const painted = new Set();
let settled = false;
// settled means the reveal has STARTED; finished means it is off the screen.
// Work that would block the main thread has to wait for the second of those --
// see afterEntrance.
let finished = false;
const heldBack = [];
let startedAt = performance.now();
let stopWatching = null;
let giveUpTimer = null;

// the fill's own value, eased toward the truth and never allowed back down: a
// bar that retreats is worse than one that stalls
const fill = { value: FILL_FLOOR };

function paintFill() {
  sheet?.style.setProperty("--progress", fill.value.toFixed(4));
}

// Where the load actually is, as a share of the whole. Each gated character
// contributes an equal slice; a character whose transfer never reported a
// length contributes nothing until it draws, rather than a made-up number.
function trueProgress() {
  if (!gated?.length) return 1;
  let total = 0;
  for (const url of gated) {
    if (painted.has(url)) {
      total += 1;
      continue;
    }
    const bytes = modelProgress(url);
    if (bytes) total += Math.min(1, bytes.loaded / bytes.total) * DOWNLOAD_SHARE;
  }
  return total / gated.length;
}

// the last value the chase was aimed at, so a transfer reporting forty times a
// second does not rebuild the tween forty times for a target that has barely
// moved -- and so the chase can never be re-aimed backwards
let chasingTo = FILL_FLOOR;

function sync() {
  if (settled) return;
  const target = trueProgress();
  if (target > chasingTo + 0.002) {
    chasingTo = target;
    gsap.to(fill, {
      value: target,
      duration: CHASE_SECONDS,
      ease: "power2.out",
      overwrite: true,
      onUpdate: paintFill,
    });
  }
  if (painted.size >= gated.length) reveal();
}

// The two boxes the flight runs between: where the mark is sitting, and the nav
// logo's own slot.
//
// Flown as a BOX -- left/top/width/height -- and deliberately not as a
// transform, which is the cheaper and more obvious way to do it. The mark is
// drawn by masking disney.svg, and a mask is rasterised once at the element's
// layout size: scale that down by 4.8 and the compositor is shrinking a 340px
// raster rather than drawing a 70px one, which lands on the nav noticeably
// chunkier and heavier than the <img> of the same file sitting underneath it.
// Measured over the logo's slot, 10% of the pixels differed, some of them
// almost fully. Animating the box re-rasterises the mask at each step, so the
// mark arrives drawn exactly as the logo it is replacing -- which is the whole
// point of flying it there.
//
// Both boxes carry the mark's own aspect ratio, so interpolating width and
// height independently still holds that ratio the whole way across.
//
// Measured at the top of the reveal rather than when the flight starts:
// nothing relayouts in between (the fonts are long since in, and the logo's box
// is a fixed height at the nav's own padding, so it does not move when the
// wordmark beside it resolves).
function flightToLogo(logo) {
  const from = mark.getBoundingClientRect();
  const to = logo.getBoundingClientRect();
  if (!from.width || !to.width) return null;
  const box = (r) => ({ left: r.left, top: r.top, width: r.width, height: r.height });
  return { from: box(from), to: box(to) };
}

function release() {
  if (finished) return;
  finished = true;
  while (heldBack.length) heldBack.shift()();
}

// Registered to run at the moment the page starts coming in from behind the
// sheet -- after the mark has landed in the nav, not after the whole entrance
// is over. This is the seam the grid deals its cards in on, so they arrive WITH
// the page rather than after a beat of it sitting there complete.
const pageInJobs = [];
let pageArriving = !sheet;

// A job may report how long its own arrival takes, in seconds. The heavy work
// held by afterEntrance is let go once the LONGEST of them has landed, not when
// the sheet's own timeline runs out: the row deals itself in over most of a
// second, well past the end of the reveal, and a decode started underneath it
// freezes the last cards halfway exactly as it used to freeze the flight.
function pageIn() {
  pageArriving = true;
  let longest = PAGE_FADE_SECONDS;
  while (pageInJobs.length) {
    const spent = pageInJobs.shift()();
    if (typeof spent === "number" && spent > longest) longest = spent;
  }
  gsap.delayedCall(longest, release);
}

export function onPageIn(job) {
  if (pageArriving) job();
  else pageInJobs.push(job);
}

// Runs `job` once the entrance is off the screen, or straight away if it
// already is. For work that takes the main thread away for long enough to be
// seen: every frame of the reveal is animated from that same thread, so a
// multi-megabyte decode started underneath it does not slow the entrance down,
// it stops it dead halfway and then finishes it in one jump.
export function afterEntrance(job) {
  if (finished) job();
  else heldBack.push(job);
}

function reveal() {
  if (settled) return;
  settled = true;
  clearTimeout(giveUpTimer);
  stopWatching?.();
  if (!sheet) {
    release();
    return;
  }

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const page = document.querySelector(".page");
  const logo = document.querySelector(".logo-mark");
  // no logo to fly into (a view without the nav) means no flight: the sheet
  // simply stops covering the page, which the same order still handles
  const landing = logo && mark ? flightToLogo(logo) : null;

  const done = () => {
    // One frame, one swap: the nav's own mark becomes visible and the flown one
    // is taken off the page in the same breath. They are identical and exactly
    // on top of each other, so there is nothing to see -- but leave a gap
    // either way and it is a blink.
    document.documentElement.classList.remove("is-loading");
    page?.style.removeProperty("opacity");
    sheet.remove();
  };

  // held past the minimum so a cached load still gets an entrance rather than
  // a flicker of white
  const tl = gsap.timeline({
    delay: Math.max(0, MINIMUM_MS - (performance.now() - startedAt)) / 1000,
    onComplete: done,
  });

  tl.to(fill, {
    value: 1,
    duration: reduced ? 0 : FILL_OUT_SECONDS,
    ease: "power2.out",
    overwrite: true,
    onUpdate: paintFill,
  });

  if (landing) {
    // pinned to where it already is, so leaving the sheet's centring behind
    // does not move it, and the tween has somewhere to start from.
    //
    // autoRound off throughout: gsap rounds px values on ordinary CSS
    // properties by default, which landed the mark half a pixel narrow of the
    // logo -- and half a pixel is the difference between the swap being
    // invisible and the mark twitching as it hands over.
    tl.set(
      mark,
      { position: "fixed", margin: 0, ...landing.from, autoRound: false },
      `+=${reduced ? 0 : HOLD_SECONDS}`
    );
    tl.to(mark, {
      ...landing.to,
      autoRound: false,
      duration: reduced ? 0 : TRAVEL_SECONDS,
      ease: "power3.inOut",
    });
  }

  // The sheet's white goes the instant the mark is home. Invisible in itself --
  // the page behind is the same white and still hidden -- but it is what makes
  // the next step a reveal of the content rather than a crossfade of two
  // full-screen layers.
  // All three on the same frame -- "<" is the start of the one before, so the
  // lead is applied once and the rest follow it rather than queueing after the
  // flight the way an appended tween would.
  tl.set(
    sheet,
    { background: "transparent", pointerEvents: "none" },
    reduced ? "+=0" : `-=${PAGE_IN_LEAD}`
  );
  tl.add(pageIn, "<");
  if (page) {
    gsap.set(page, { opacity: 0 });
    tl.to(
      page,
      { opacity: 1, duration: reduced ? 0.2 : PAGE_FADE_SECONDS, ease: "power1.out" },
      "<"
    );
  }
}

// The characters this load is waiting on: whichever cards the grid mounted
// straight away, which is four across a desktop and one on a phone. Deliberately
// NOT the first card alone -- on a desktop that would lift the sheet on a row
// with three holes still in it.
//
// First call wins. The grid re-checks which cards are near enough to mount on
// every scroll, and a card mounted because the user paged across is not
// something the entrance should ever have been waiting for.
export function gateOn(urls) {
  if (gated || settled) return;
  gated = [...new Set(urls)];
  startedAt = performance.now();
  if (!gated.length) {
    reveal();
    return;
  }
  stopWatching = onModelProgress((url) => {
    if (gated.includes(url)) sync();
  });
  giveUpTimer = setTimeout(reveal, GIVE_UP_MS);
  sync();
}

// A gated character is on screen. Called for a failed load too: a card that
// cannot be drawn is still a card the entrance must stop waiting for, and the
// page behind is perfectly usable with one canvas blank.
export function modelSettled(url) {
  if (!gated?.includes(url) || settled) return;
  painted.add(url);
  sync();
}

// Nothing to wait for: the sheet only belongs in front of a cold first paint.
// A build that ships without it finds it already gone.
if (!sheet) {
  settled = true;
  finished = true;
} else {
  document.documentElement.classList.add("is-loading");
}

// dev-only: runs the entrance on demand rather than making a test wait on
// 100MB of models first, and reports where the fill has got to. Pair it with
// window.__gsap (see main.js) to pause and scrub the reveal at exact progress
// values -- the machine renders this page at a couple of frames a second, so a
// screenshot taken by the clock lands wherever it happens to land.
if (import.meta.env.DEV) {
  window.__loading = {
    reveal,
    fillValue: () => fill.value,
    // what the entrance decided it was waiting for, and how much of it has
    // actually drawn -- the two numbers a test needs to tell a real gate from
    // a timeout that happened to look like one
    gatedCount: () => gated?.length ?? 0,
    paintedCount: () => painted.size,
  };
}
