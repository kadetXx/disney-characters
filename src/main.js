import gsap from "gsap";
import { characters, getCharacter, defaultCharacterId } from "./data/characters.js";
import { createViewer, createRenderLoop } from "./three/viewer.js";

// the Google Fonts link is preloaded (not render-blocking) in the HTML head --
// promote it to an active stylesheet once the module script runs
const fontsLink = document.getElementById("fontsStylesheet");
if (fontsLink) fontsLink.rel = "stylesheet";

const renderLoop = createRenderLoop();
const app = document.getElementById("app");

// dev-only: lets a test pause and scrub gsap's global timeline, so the flight
// can be inspected at exact progress values instead of hoping a screenshot
// lands mid-tween on a machine rendering at a few frames a second
if (import.meta.env.DEV) window.__gsap = gsap;

const CARD_DISTANCE_SCALE = 2.05;
const MASCOT_DISTANCE_SCALE = 1.02;
const FADE_SETTLE_TIMEOUT = 320;

const state = {
  view: "grid", // "grid" | "detail"
  detailId: defaultCharacterId,
  viewers: [], // every live viewer for the currently mounted view
};

function gradientCss(character) {
  const [a, b, c] = character.gradient;
  return `linear-gradient(135deg, ${a} 0%, ${b} 60%, ${c} 100%)`;
}

function clearViewers() {
  for (const viewer of state.viewers) renderLoop.remove(viewer);
  state.viewers = [];
}

// The two framings a character is seen in. Single source of truth: the flight
// interpolates between exactly the values the two static views are built with,
// so the motion cannot drift from where it starts and lands.
function cardFraming(character) {
  return {
    distanceScale: CARD_DISTANCE_SCALE * (character.zoomAdjust ?? 1),
    verticalAnchor: character.verticalAnchor ?? 0,
  };
}

function detailFraming(character) {
  return {
    distanceScale: MASCOT_DISTANCE_SCALE * (character.detailZoom ?? 1),
    verticalAnchor: character.detailAnchor ?? 0,
  };
}

const lerp = (a, b, t) => a + (b - a) * t;

// Top-left grows INTO something -- the detail panel's big sweep -- so it is
// carried through the whole move.
const GROWING_CORNERS = ["borderTopLeftRadius"];
// Bottom-left does both jobs in turn, so it is driven by hand in flyToDetail:
// it rides the top-left's growth up, rounding the whole left edge with it, and
// only straightens once the box has arrived.
const JOINING_CORNER = "borderBottomLeftRadius";
// The right pair simply resolve to a square 0. Straightening early reads as
// the panel losing its shape before it has landed, so they hold the card's own
// radius until the box is essentially in position.
const LATE_CORNERS = ["borderTopRightRadius", "borderBottomRightRadius"];
const CORNERS = [...GROWING_CORNERS, JOINING_CORNER, ...LATE_CORNERS];

// where along the flight the corners that end square start squaring off
const CORNER_SPLIT = 0.66;

// computed corner radii in px, so the card's own rounding can morph into the
// detail panel's single huge top-left corner
function readCorners(el) {
  const style = getComputedStyle(el);
  return Object.fromEntries(CORNERS.map((corner) => [corner, style[corner]]));
}

const lerpRect = (a, b, t) => ({
  left: lerp(a.left, b.left, t),
  top: lerp(a.top, b.top, t),
  width: lerp(a.width, b.width, t),
  height: lerp(a.height, b.height, t),
});

// smallest box containing both, so the character never leaves the canvas at
// any point along the flight and the canvas itself need never be resized
function unionRect(a, b) {
  const left = Math.min(a.left, b.left);
  const top = Math.min(a.top, b.top);
  return {
    left,
    top,
    width: Math.max(a.left + a.width, b.left + b.width) - left,
    height: Math.max(a.top + a.height, b.top + b.height) - top,
  };
}

function fadeIn(el, delay = 0) {
  el.classList.add("fade-scale-pane", "fade-scale-enter");
  requestAnimationFrame(() => {
    setTimeout(() => el.classList.remove("fade-scale-enter"), delay);
  });
}

/* ------------------------------------------------------------------ */
/* Grid view                                                          */
/* ------------------------------------------------------------------ */

function buildCharacterCard(character) {
  const card = document.createElement("button");
  card.className = "char-card";
  card.type = "button";
  card.setAttribute("aria-label", `${character.name} — ${character.movie}`);

  const canvasWrap = document.createElement("div");
  canvasWrap.className = "char-card-canvas-wrap";
  // horizontal nudge for poses that should spill off the card (Rosetta's gown)
  canvasWrap.style.setProperty("--shift-x", `${character.shiftX ?? 0}%`);
  canvasWrap.style.setProperty("--aura", rgba(character.gradient[2], AURA.alpha));
  canvasWrap.style.setProperty("--aura-size", AURA.blur);
  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  canvasWrap.appendChild(canvas);
  card.appendChild(canvasWrap);

  const panel = document.createElement("div");
  panel.className = "char-card-panel";
  panel.style.background = gradientCss(character);
  panel.style.setProperty("--panel-ratio", character.panelRatio ?? 1.06);
  panel.innerHTML = `
    <h3 class="char-card-title" style="color:${character.titleTint}">${character.name}</h3>
    <p class="char-card-movie">Movie <b>${character.movie}</b></p>
  `;
  card.appendChild(panel);

  card.addEventListener("click", () => showDetail(character.id, canvas));

  const viewer = createViewer(canvas, {
    modelUrl: character.model,
    ...cardFraming(character),
    yaw: ((character.yawDeg ?? 0) * Math.PI) / 180,
    rimColor: character.rimColor ?? character.gradient[0],
    spinSpeed: 0,
  });
  renderLoop.add(viewer);
  state.viewers.push(viewer);

  return card;
}

function buildGridView() {
  const view = document.createElement("div");
  view.className = "grid-view";

  const viewport = document.createElement("div");
  viewport.className = "carousel-viewport";
  const track = document.createElement("div");
  track.className = "carousel-track";
  characters.forEach((character) => track.appendChild(buildCharacterCard(character)));
  viewport.appendChild(track);
  view.appendChild(viewport);

  const footer = document.createElement("footer");
  footer.className = "grid-footer";
  footer.innerHTML = `
    <div class="social-links">
      <a href="#" onclick="return false">Facebook</a>
      <a href="#" onclick="return false">Twitter</a>
    </div>
    <div class="pager">
      <button class="pager-btn" id="prevBtn" type="button" aria-label="Previous">
        <svg width="8" height="14" viewBox="0 0 8 14" aria-hidden="true"><path d="M8 0L0 7L8 14Z" fill="currentColor"/></svg>
        Prev
      </button>
      <button class="pager-btn" id="nextBtn" type="button" aria-label="Next">
        Next
        <svg width="8" height="14" viewBox="0 0 8 14" aria-hidden="true"><path d="M0 0L8 7L0 14Z" fill="currentColor"/></svg>
      </button>
    </div>
  `;
  view.appendChild(footer);

  const prevBtn = footer.querySelector("#prevBtn");
  const nextBtn = footer.querySelector("#nextBtn");

  // The carousel moves in whole pages, never free-scrolls: you are either on
  // the first screenful or the second, and any swipe commits to the far end
  // rather than tracking the pointer. The track's overflow-x is hidden (see
  // style.css) so the browser never scrolls it natively -- every movement
  // below is a deliberate scrollTo, which is what makes it feel snappy
  // instead of drifting to rest wherever momentum ran out.
  const SLIDE_MS = 420;
  // how much wheel travel / finger distance counts as a committed swipe
  const WHEEL_THRESHOLD = 24;
  const SWIPE_THRESHOLD = 40;
  let slideUntil = 0;

  // One page per screenful of overflow, minimum two whenever there is
  // anything at all to scroll -- so the far end is always reachable in one
  // press even when the overflow is less than a full viewport wide.
  function pageOffsets() {
    const maxScroll = Math.max(0, track.scrollWidth - track.clientWidth);
    if (maxScroll < 1) return [0];
    const count = Math.max(2, Math.round(maxScroll / track.clientWidth) + 1);
    return Array.from({ length: count }, (_, i) => (i * maxScroll) / (count - 1));
  }

  function currentPage() {
    const offsets = pageOffsets();
    let best = 0;
    offsets.forEach((offset, i) => {
      if (Math.abs(offset - track.scrollLeft) < Math.abs(offsets[best] - track.scrollLeft)) best = i;
    });
    return best;
  }

  function goToPage(index) {
    const offsets = pageOffsets();
    const target = Math.min(offsets.length - 1, Math.max(0, index));
    slideUntil = performance.now() + SLIDE_MS;
    track.scrollTo({ left: offsets[target], behavior: "smooth" });
  }

  // A swipe is one discrete command. Ignoring input mid-slide stops a single
  // trackpad flick -- which fires dozens of wheel events -- from queuing up
  // several pages and skating past the one the user asked for.
  function step(direction) {
    if (performance.now() < slideUntil) return;
    goToPage(currentPage() + direction);
  }

  track.addEventListener(
    "wheel",
    (event) => {
      // trackpads report horizontal intent on deltaX; a mouse wheel only has
      // deltaY, so take whichever axis the gesture actually favours
      const delta =
        Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (Math.abs(delta) < WHEEL_THRESHOLD) return;
      event.preventDefault();
      step(Math.sign(delta));
    },
    { passive: false }
  );

  let touchStartX = null;
  track.addEventListener(
    "touchstart",
    (event) => {
      touchStartX = event.touches[0].clientX;
    },
    { passive: true }
  );
  track.addEventListener(
    "touchend",
    (event) => {
      if (touchStartX === null) return;
      const dx = event.changedTouches[0].clientX - touchStartX;
      touchStartX = null;
      if (Math.abs(dx) >= SWIPE_THRESHOLD) step(dx < 0 ? 1 : -1);
    },
    { passive: true }
  );

  // Items shrink as they approach and cross the scrollport edge, and return to
  // full size coming back in. The falloff spans two cards at each edge: the
  // outermost reaches EDGE_SCALE_MIN, the one inside it sits about halfway.
  //
  // Measured from layout geometry (offsetWidth / scrollLeft), never from
  // getBoundingClientRect -- that reports the *transformed* box, so feeding it
  // back in would make each card's scale depend on its own previous scale.
  const EDGE_SCALE_MIN = 0.74;
  // Where along the x axis shrinking starts and finishes, in card-pitch units
  // measured from the scrollport edge. Negative starts it while the card is
  // still inside the port; 0 would hold full size right up until the outer
  // edge touches the screen edge. Both boundaries move together so the ramp
  // keeps its length -- only the point it engages shifts.
  const EDGE_TRIGGER = -0.5;
  const EDGE_FULL = 0.7;
  let edgeFrame = null;
  function syncEdgeScale() {
    edgeFrame = null;
    const cards = [...track.children];
    if (!cards.length) return;
    const cs = getComputedStyle(track);
    const gap = parseFloat(cs.columnGap) || 0;
    const pad = parseFloat(cs.paddingLeft) || 0;
    const cardW = cards[0].offsetWidth;
    const pitch = cardW + gap;
    const viewLeft = track.scrollLeft;
    const viewRight = viewLeft + track.clientWidth;

    // Each edge only exerts pull while there is still content to scroll past
    // it, eased over one card so it fades in rather than snapping. Without
    // this the first card shrinks while parked at the start, where nothing is
    // actually leaving the viewport.
    const maxScroll = Math.max(0, track.scrollWidth - track.clientWidth);
    const leftPull = Math.min(1, viewLeft / pitch);
    const rightPull = Math.min(1, (maxScroll - viewLeft) / pitch);
    const ramp = (over) =>
      Math.min(1, Math.max(0, (over - EDGE_TRIGGER) / (EDGE_FULL - EDGE_TRIGGER)));

    cards.forEach((card, i) => {
      const left = pad + i * pitch;
      const right = left + cardW;
      // in card-pitch units: -1 is a full card inside the edge, 0 straddles
      // it, +1 is a full card beyond it
      const t = Math.max(
        ramp((viewLeft - left) / pitch) * leftPull,
        ramp((right - viewRight) / pitch) * rightPull
      );
      const scale = (1 - t * (1 - EDGE_SCALE_MIN)).toFixed(4);
      card.querySelector(".char-card-canvas-wrap").style.transform = `scale(${scale})`;
    });
  }
  function queueEdgeScale() {
    if (edgeFrame === null) edgeFrame = requestAnimationFrame(syncEdgeScale);
  }

  function syncPagerState() {
    const page = currentPage();
    prevBtn.disabled = page === 0;
    nextBtn.disabled = page === pageOffsets().length - 1;
  }

  prevBtn.addEventListener("click", () => step(-1));
  nextBtn.addEventListener("click", () => step(1));
  track.addEventListener("scroll", () => { syncPagerState(); queueEdgeScale(); }, { passive: true });
  window.addEventListener("resize", queueEdgeScale, { passive: true });
  requestAnimationFrame(() => { syncPagerState(); syncEdgeScale(); });

  return view;
}

/* ------------------------------------------------------------------ */
/* Detail view                                                        */
/* ------------------------------------------------------------------ */

// drop-shadow has no spread parameter the way box-shadow does, so the two
// levers are blur distance and colour alpha: push blur up and alpha down for a
// wider, softer halo; pull blur in and alpha up for a tighter, punchier one.
// nice value: const AURA = { blur: "45px", alpha: 0.4 };
const AURA = { blur: "50px", alpha: 0.4 };

function rgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

const BADGE_COLORS = ["#7B4FA0", "#C97B2E", "#3FA6A0", "#D6C232"];

function buildBadge() {
  const badge = document.createElement("div");
  badge.className = "detail-badge";
  badge.innerHTML = `
    <span style="top:0;left:20px;width:70px;height:70px;background:${BADGE_COLORS[0]}"></span>
    <span style="top:18px;left:60px;width:60px;height:60px;background:${BADGE_COLORS[1]}"></span>
    <span style="bottom:0;left:8px;width:64px;height:64px;background:${BADGE_COLORS[2]}"></span>
    <span style="bottom:6px;right:0;width:56px;height:56px;background:${BADGE_COLORS[3]}"></span>
  `;
  return badge;
}

function buildClips() {
  const clips = document.createElement("div");
  clips.className = "detail-clips";
  const label = document.createElement("span");
  label.className = "detail-clips-label";
  label.textContent = "Clips";
  clips.appendChild(label);

  const track = document.createElement("div");
  track.className = "clips-track";
  for (let i = 0; i < 3; i++) {
    const card = document.createElement("div");
    card.className = "clip-card";
    // one shared placeholder file behind all three; muted+playsinline so it
    // autoplays under browser policy, and preload=auto since it is reused
    card.innerHTML = `
      <video class="clip-video" src="${import.meta.env.BASE_URL}clip-placeholder.mp4"
             autoplay loop muted playsinline preload="auto" aria-hidden="true"></video>
      <div class="clip-play">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M10 8.5L16 12L10 15.5V8.5Z" fill="#243A74"/></svg>
      </div>
    `;
    track.appendChild(card);
  }
  clips.appendChild(track);
  return clips;
}

let mainViewer = null;
// set when a detail view is built mid-flight; run once the character lands
let pendingMascot = null;

// onPainted runs only once the mascot canvas actually has the character drawn
// into it -- see the mount closure in buildDetailView
function mountMascotViewer(onPainted) {
  const mount = pendingMascot;
  pendingMascot = null;
  mount?.(onPainted);
}

function buildDetailView(characterId, { deferMascot = false } = {}) {
  const character = getCharacter(characterId);
  const nextCharacter = characters[(characters.findIndex((c) => c.id === characterId) + 1) % characters.length];

  const view = document.createElement("div");
  view.className = "detail-view";

  const closeRow = document.createElement("div");
  closeRow.className = "close-row";
  closeRow.innerHTML = `
    <button class="close-btn" type="button">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M6 6L18 18M18 6L6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>
      Close
    </button>
  `;
  closeRow.querySelector(".close-btn").addEventListener("click", showGrid);
  view.appendChild(closeRow);

  const body = document.createElement("div");
  body.className = "detail-body";

  const rail = document.createElement("div");
  rail.className = "detail-rail";
  rail.innerHTML = `
    <span class="rail-tab is-active">${character.name}</span>
    <div class="rail-next-group">
      <button class="rail-tab" type="button">${nextCharacter.name}</button>
      <button class="rail-chevron" type="button" aria-label="Next character">
        <svg width="30" height="30" viewBox="0 0 24 24" fill="none"><path d="M6 9L12 15L18 9" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
    </div>
  `;
  const goNext = () => showDetail(nextCharacter.id);
  rail.querySelector(".rail-tab:not(.is-active)").addEventListener("click", goNext);
  rail.querySelector(".rail-chevron").addEventListener("click", goNext);
  body.appendChild(rail);

  const panel = document.createElement("div");
  panel.className = "detail-panel";
  panel.style.background = gradientCss(character);
  panel.style.setProperty("--panel-ratio", character.panelRatio ?? 1.06);


  const info = document.createElement("div");
  info.className = "detail-info";
  info.innerHTML = `
    <div class="detail-text">
      <h2 class="detail-title" style="color:${character.titleTint}">${character.name}</h2>
      <p class="detail-movie">Movie <b>${character.movie}</b></p>
      <p class="detail-description">${character.description}</p>
    </div>
  `;
  info.appendChild(buildBadge());
  panel.appendChild(info);
  panel.appendChild(buildClips());

  body.appendChild(panel);

  const canvas = document.createElement("canvas");
  canvas.className = "detail-mascot-canvas";
  canvas.setAttribute("aria-hidden", "true");
  canvas.style.setProperty("--detail-shift-x", `${character.detailShiftX ?? 0}%`);
  canvas.style.setProperty("--detail-shift-y", `${character.detailShiftY ?? 0}%`);
  // same accent halo the cards carry, so the character doesn't arrive here
  // permanently stripped of it. Affordable on this canvas and not on the
  // flight's precisely because this one is static -- the blur rasterises once
  // and is cached, rather than being redone every frame.
  canvas.style.setProperty("--aura", rgba(character.gradient[2], AURA.alpha));
  canvas.style.setProperty("--aura-size", AURA.blur);
  body.appendChild(canvas);

  view.appendChild(body);

  // Deferred during a flight: a second full-size viewer rendering the same
  // character while the flight is mid-air doubles the per-frame cost at
  // exactly the wrong moment. mountMascotViewer() is called on landing.
  const mount = (onPainted) => {
    // held locally rather than read back off mainViewer: onReady fires a
    // microtask later, by which point a fast second navigation may already
    // have pointed mainViewer at a different character's viewer
    const viewer = createViewer(canvas, {
      modelUrl: character.model,
      ...detailFraming(character),
      yaw: ((character.yawDeg ?? 0) * Math.PI) / 180,
      rimColor: character.rimColor ?? character.gradient[0],
      spinSpeed: 0,
      interactive: true,
      // onReady fires once the model is loaded and framed -- but nothing has
      // been DRAWN yet: the render loop is a separate rAF callback and would
      // not reach this viewer until the next frame. Draw synchronously here so
      // the canvas is never handed to the flight (or to the user) blank.
      onReady: () => {
        viewer.render();
        onPainted?.();
      },
    });
    mainViewer = viewer;
    renderLoop.add(viewer);
    state.viewers.push(viewer);
  };

  if (deferMascot) pendingMascot = mount;
  else mount();

  return view;
}

/* ------------------------------------------------------------------ */
/* View switching                                                     */
/* ------------------------------------------------------------------ */

// Cards still playing their exit animation. They live on <body> rather than in
// #app, so nothing that rebuilds #app can clear them -- this list is how they
// get collected if the user navigates again mid-exit.
let outgoingCards = [];

function dropOutgoingCards() {
  for (const card of outgoingCards) card.remove();
  outgoingCards = [];
}

function mount(buildFn) {
  dropOutgoingCards();
  clearViewers();
  app.innerHTML = "";
  const view = buildFn();
  app.appendChild(view);
  fadeIn(view);
}

function showGrid() {
  state.view = "grid";
  mount(buildGridView);
}

const FLIGHT_SECONDS = 0.62;
// render fewer pixels while the character is IN MOTION and let the browser
// scale the bitmap up; at speed the softness is invisible and it keeps the
// per-frame cost well clear of the frame budget.
//
// Applied only through the middle of the flight. Holding it across the whole
// move meant the first painted frame was 25% softer than the card the user had
// just been looking at, and the last one 25% softer than the mascot that
// replaced it -- a sharpness pop at each end of an otherwise continuous move,
// with nothing moving to hide it.
const FLIGHT_RENDER_SCALE = 0.75;
// How much of each end of the flight renders at full resolution. power3.inOut
// is at its slowest here, so these are both the frames where softness reads
// most plainly and the frames that sit against a static card or mascot. It
// cannot be the endpoints alone: the t=1 frame is never painted -- the landing
// swap replaces it within the same frame -- so the match has to be in place
// several frames before the end.
const FLIGHT_SHARP_EDGE = 0.12;
// if the mascot's model somehow never resolves, don't strand the flight canvas
// on top of the page forever
const LANDING_TIMEOUT = 2000;

// The cards that were NOT clicked don't disappear with the grid -- they drop
// away and fade while the chosen one flies. Well short of the flight so the
// grid has cleared long before the detail panel finishes growing over it.
const CARD_EXIT_SECONDS = 0.3;
// how far a card falls, in px. Scaled up slightly with distance from the
// clicked card so the row spreads apart as it goes rather than moving as a
// single slab.
const CARD_EXIT_DROP = 84;
// degrees. Cards to the left of the clicked one tilt one way and cards to the
// right the other, so the row parts around the character being chosen.
const CARD_EXIT_TILT = 4.5;
// each card further out starts this much later, rippling outward from the pick
const CARD_EXIT_STAGGER = 0.04;
// back.in loads up against the drop before releasing it -- the card lifts and
// counter-rotates a few pixels first, which is what reads as spring rather
// than as a card simply being translated downward.
const CARD_EXIT_EASE = "back.in(2.2)";

// How much the panel's bottom edge runs ahead of its top edge while the box
// grows. 0 drives both off one ease, which is what made the expansion read as
// going up-and-away from the card: the end state only puts a little more
// travel below the card than above it (167px down vs 145px up at 1440x900),
// and the box is racing ~685px leftward at the same time, so an even vertical
// split gets read as upward. Running the bottom down early makes the panel
// descend as it opens. Both edges still start and finish together.
const PANEL_DOWNWARD_BIAS = 0.45;

// Carries the character from its card into the detail layout as one continuous
// move rather than cross-fading between two separately drawn copies.
//
// The card's own viewer is adopted: its canvas is lifted out of the card and
// pinned to the viewport, so the same scene, camera and GPU textures are on
// screen the whole way. Nothing is reloaded -- only possible now that every
// viewer shares one context.
//
// The canvas is sized ONCE, to the union of the start and end rects, and never
// touched again. Assigning canvas.width/height reallocates the entire backing
// store (megabytes per frame at retina detail size) and wipes it; doing that
// per frame is what made the first attempt flash and teleport. Here the
// character is moved and grown purely by camera framing.
function flyToDetail(character, cardCanvas) {
  const viewer = state.viewers.find((v) => v.canvas === cardCanvas);
  if (!viewer) return false;

  const from = cardCanvas.getBoundingClientRect();
  if (!from.width || !from.height) return false;

  dropOutgoingCards();

  // everything below needs the clicked card's own DOM, so resolve it before
  // the canvas is lifted out of it
  const clickedCard = cardCanvas.closest(".char-card");

  // the card's coloured panel, measured before the grid is torn down -- the
  // detail panel will start life at exactly this box so it reads as this card
  // growing rather than a new panel appearing
  const cardPanel = clickedCard?.querySelector(".char-card-panel");
  const panelFrom = cardPanel?.getBoundingClientRect();
  const panelFromCorners = cardPanel ? readCorners(cardPanel) : null;

  // The cards that are staying behind, measured while the grid is still laid
  // out. Only the ones actually on screen: the carousel can be scrolled, and
  // there is no point animating cards parked off the side of the viewport.
  const leaving = [...app.querySelectorAll(".char-card")]
    .filter((card) => card !== clickedCard)
    .map((card) => ({ card, rect: card.getBoundingClientRect() }))
    .filter(({ rect }) => rect.right > 0 && rect.left < window.innerWidth);

  const clickedLeft = clickedCard?.getBoundingClientRect().left ?? 0;

  // hand the viewer to the flight before clearViewers() can dispose it
  state.viewers = state.viewers.filter((v) => v !== viewer);

  // Dispose the other cards' viewers FIRST, before the grid is repositioned
  // below. dispose() only stops them rendering and disconnects their
  // ResizeObservers -- it leaves each 2D canvas holding its last painted
  // frame, which is exactly what the exit animation needs. Order matters:
  // setSize() does not check `disposed`, so an observer still live when the
  // grid moves would assign canvas.width and wipe the very pixels being
  // faded out.
  clearViewers();

  // The cards fly out rather than vanishing. Each is pinned to the viewport at
  // the exact box it already occupies and lifted onto <body>, which buys three
  // things at once: the teardown below cannot delete them, position:fixed
  // escapes .carousel-track's overflow (hidden on one axis clips BOTH, so a
  // card sliding down inside the track would be sheared off at its edge), and
  // nothing has to re-resolve the grid's flex layout -- pinning the whole
  // .grid-view instead made its justify-content:flex-end column rebuild on
  // re-parent and threw every card to the bottom of the viewport for a frame.
  //
  // z-index 2 puts them above the detail view's background but below the rail,
  // close row and growing panel, so the panel sweeps over them as it expands.
  // Written straight to the element rather than through gsap.set: this is
  // layout-critical setup, not animation, and it has to be in effect in this
  // same task -- the card is about to be re-parented onto <body>, where
  // without it a .char-card is just an inline-block button in normal flow.
  // gsap.set() only renders through the global timeline, so anything that
  // pauses that timeline (the scrub harness does) leaves the pin unapplied.
  for (const { card, rect } of leaving) {
    Object.assign(card.style, {
      position: "fixed",
      margin: "0",
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      zIndex: "2",
      pointerEvents: "none",
    });
    document.body.appendChild(card);
    outgoingCards.push(card);
  }

  // the clicked card goes with the grid: its character is already the flight
  // canvas, and its panel is handed to the detail panel, which starts at
  // exactly that box with the same gradient
  app.innerHTML = "";
  // Build the destination at its final size, and WITHOUT the usual fadeIn():
  // that enters from scale(0.96), so any rect measured under it is 4% short
  // and the flight lands in the wrong place. The mascot's own viewer is
  // deferred until landing so it isn't rendering full-size alongside us.
  const view = buildDetailView(character.id, { deferMascot: true });
  app.appendChild(view);

  const target = view.querySelector(".detail-mascot-canvas");
  const to = target.getBoundingClientRect();
  target.style.visibility = "hidden";

  // Grow the REAL detail panel from the card's box rather than cross-fading a
  // copy: both already carry the same character gradient, so starting it at
  // the card's rect and corners makes it the same object visually. Animating
  // the box itself (not a transform: scale) is what keeps the corner radii
  // circular and the gradient unstretched while it grows.
  const panel = view.querySelector(".detail-panel");
  if (panel && panelFrom) {
    const panelTo = panel.getBoundingClientRect();
    const panelToCorners = readCorners(panel);
    // Contents stay hidden while the box resizes. visibility, not just opacity:
    // they are laid out against the panel's *current* (smaller) width, so at
    // any opacity above zero the badge spills past the panel's right edge and
    // the description is clipped mid-sentence. They appear only once the box
    // is close enough to final size for the layout to be the real one.
    const contents = [...panel.children];
    gsap.set(contents, { opacity: 0, visibility: "hidden" });
    // While growing, the panel sweeps across the rail's column (which it never
    // touches once settled, sitting at --detail-inset). The rail is z-index 3,
    // so without this its vertical name labels show straight through the
    // growing box. Cleared on landing so normal stacking resumes.
    // Written straight to the element, like the card pins above: the box this
    // establishes is what every frame below is measured against, so it has to
    // hold in this same task rather than waiting on the global timeline.
    Object.assign(panel.style, {
      position: "fixed",
      zIndex: "5",
      left: `${panelFrom.left}px`,
      top: `${panelFrom.top}px`,
      width: `${panelFrom.width}px`,
      height: `${panelFrom.height}px`,
      ...panelFromCorners,
    });
    // The corners are split by what they are actually doing.
    //
    // Top-left is the detail panel's signature sweep and the one the eye
    // follows, on screen the whole way. Growing it in step with the box, on
    // the box's own ease, makes the radius read as part of the same expansion
    // rather than something that happens to the panel after it arrives.
    const pick = (corners) =>
      Object.fromEntries(corners.map((corner) => [corner, panelToCorners[corner]]));

    gsap.to(panel, {
      ...pick(GROWING_CORNERS),
      duration: FLIGHT_SECONDS,
      ease: "power3.inOut",
    });

    // The right pair are headed for a square 0, and a corner going square while
    // the box is still moving reads as the panel straightening out before it
    // has landed. They hold the card's own radius and only square off once the
    // box is essentially in position.
    gsap.to(panel, {
      ...pick(LATE_CORNERS),
      duration: FLIGHT_SECONDS * (1 - CORNER_SPLIT),
      ease: "power2.inOut",
      delay: FLIGHT_SECONDS * CORNER_SPLIT,
    });

    // Bottom-left is the one corner that does both things. It starts on the
    // card's radius exactly as top-left does, so for the first stretch it can
    // simply BE top-left -- the two rise together and the whole left edge
    // rounds as the panel opens. Then it straightens, on the same beat as the
    // right pair.
    //
    // Multiplying by a 1 -> 0 factor rather than tweening to 0 separately is
    // what keeps that hand-off invisible: power2.inOut leaves the factor at 1
    // with zero slope at the split, so bottom-left's velocity there is still
    // exactly top-left's and there is no kink where the two phases meet.
    const fromTopLeft = parseFloat(panelFromCorners.borderTopLeftRadius) || 0;
    const toTopLeft = parseFloat(panelToCorners.borderTopLeftRadius) || 0;
    const straightenEase = gsap.parseEase("power2.inOut");
    const joiningCorner = (t, base) => {
      const riding = lerp(fromTopLeft, toTopLeft, base);
      if (t <= CORNER_SPLIT) return riding;
      return riding * (1 - straightenEase((t - CORNER_SPLIT) / (1 - CORNER_SPLIT)));
    };

    // The box is driven edge by edge rather than as one rect, so the bottom
    // can run ahead of the top (see PANEL_DOWNWARD_BIAS). Both warps are of
    // the SAME base ease and both still map 0 to 0 and 1 to 1, so the panel
    // starts on the card and lands on the stylesheet's layout exactly as it
    // did -- only the path between them changes. The horizontal edges stay on
    // the base curve; the complaint was never about the sideways travel.
    const baseEase = gsap.parseEase("power3.inOut");
    const growPanel = (t) => {
      const base = baseEase(t);
      const down = base ** (1 - PANEL_DOWNWARD_BIAS);
      const up = base ** (1 + PANEL_DOWNWARD_BIAS);
      const top = lerp(panelFrom.top, panelTo.top, up);
      const bottom = lerp(panelFrom.bottom, panelTo.bottom, down);
      const left = lerp(panelFrom.left, panelTo.left, base);
      const right = lerp(panelFrom.right, panelTo.right, base);
      Object.assign(panel.style, {
        left: `${left}px`,
        top: `${top}px`,
        width: `${right - left}px`,
        height: `${bottom - top}px`,
        // driven here rather than as its own tween so it can track top-left
        // through the growth before straightening -- see joiningCorner
        [JOINING_CORNER]: `${joiningCorner(t, base)}px`,
      });
    };

    const grow = { t: 0 };
    gsap.to(grow, {
      t: 1,
      duration: FLIGHT_SECONDS,
      // the shaping lives in growPanel, so the tween itself runs on raw time
      ease: "none",
      onUpdate: () => growPanel(grow.t),
      onComplete() {
        // hand the panel back to the stylesheet's own layout
        gsap.set(panel, { clearProps: "position,zIndex,left,top,width,height," + CORNERS.join(",") });
        gsap.set(contents, { clearProps: "visibility" });
      },
    });
    gsap.to(contents, {
      opacity: 1,
      visibility: "visible",
      duration: 0.3,
      ease: "power2.out",
      // power3.inOut has the box ~95% grown by here, so the text lands in a
      // layout that is already the final one
      delay: FLIGHT_SECONDS * 0.72,
    });
  }

  const stageRect = unionRect(from, to);
  cardCanvas.classList.add("flight-canvas");
  cardCanvas.style.left = `${stageRect.left}px`;
  cardCanvas.style.top = `${stageRect.top}px`;
  cardCanvas.style.width = `${stageRect.width}px`;
  cardCanvas.style.height = `${stageRect.height}px`;
  document.body.appendChild(cardCanvas);

  const fromFraming = cardFraming(character);
  const toFraming = detailFraming(character);

  const apply = (t) => {
    // Full detail across both ends of the flight, reduced only through the
    // fast middle. setSize early-returns when the pixel size is unchanged, so
    // this reallocates exactly twice across the whole flight (entering and
    // leaving the fast stretch) rather than the once it used to -- and both
    // happen in the same task as the render below, so the wipe a reallocation
    // causes is never what gets painted.
    const sharp = t <= FLIGHT_SHARP_EDGE || t >= 1 - FLIGHT_SHARP_EDGE;
    const renderScale = sharp ? 1 : FLIGHT_RENDER_SCALE;
    viewer.setSize(stageRect.width, stageRect.height, renderScale);
    viewer.setProjectedFraming(
      lerpRect(from, to, t),
      stageRect,
      lerp(fromFraming.distanceScale, toFraming.distanceScale, t),
      lerp(fromFraming.verticalAnchor, toFraming.verticalAnchor, t)
    );
    viewer.render();
  };
  apply(0);

  // Opacity only, never transform: the panel and character are both flying
  // toward rects measured against this layout, so it must not move. The panel
  // itself is excluded -- it grows opaque rather than fading in.
  const chrome = [view.querySelector(".close-row"), view.querySelector(".detail-rail")].filter(Boolean);
  gsap.fromTo(chrome, { opacity: 0 }, { opacity: 1, duration: 0.34, ease: "power2.out", delay: 0.12 });

  // The cards left behind drop, tilt and fade instead of being cut. They are
  // static bitmaps by now (their viewers are disposed), so this is pure
  // compositor work and costs the flight nothing.
  if (leaving.length) {
    // ranked by how far each card sits from the clicked one, left and right
    // counted separately, so the stagger ripples outward from the pick rather
    // than sweeping across the row in DOM order
    const ranks = new Map();
    for (const side of [-1, 1]) {
      leaving
        .filter(({ rect }) => Math.sign(rect.left - clickedLeft) === side)
        .sort((a, b) => side * (a.rect.left - b.rect.left))
        .forEach(({ card }, rank) => ranks.set(card, { side, rank }));
    }

    const exit = gsap.timeline({ onComplete: dropOutgoingCards });
    for (const { card } of leaving) {
      const { side, rank } = ranks.get(card) ?? { side: 1, rank: 0 };
      const at = rank * CARD_EXIT_STAGGER;
      exit.to(
        card,
        {
          y: CARD_EXIT_DROP * (1 + rank * 0.14),
          rotation: side * CARD_EXIT_TILT * (1 + rank * 0.22),
          duration: CARD_EXIT_SECONDS,
          ease: CARD_EXIT_EASE,
          // pivot at the top edge, so the tilt swings each card's weight out
          // and down rather than spinning it about its middle
          transformOrigin: "50% 0%",
        },
        at
      );
      // Fade kept off the springy ease and on its own curve: back.in starts by
      // running backwards, which on opacity means overshooting past fully
      // opaque and then dumping to zero at the very end. Holding the card
      // visible through the wind-up and fading it as it actually leaves is
      // what makes the spring legible.
      exit.to(
        card,
        { opacity: 0, duration: CARD_EXIT_SECONDS * 0.8, ease: "power2.in" },
        at + CARD_EXIT_SECONDS * 0.2
      );
    }
  }

  const progress = { t: 0 };
  gsap.to(progress, {
    t: 1,
    duration: FLIGHT_SECONDS,
    ease: "power3.inOut",
    onUpdate: () => apply(progress.t),
    onComplete() {
      // The handover has to wait for the mascot to have PIXELS, not merely to
      // exist. Revealing it and dropping the flight canvas in this task left a
      // frame with the character nowhere on screen at all (measured: zero
      // character pixels) -- the flight canvas gone, the mascot still blank
      // because the render loop's rAF had not come round yet. The mascot's
      // model is already cached by the card that flew here, so onReady lands
      // on a microtask -- still inside this frame, before anything is painted.
      let landed = false;
      const land = () => {
        if (landed) return;
        landed = true;
        clearTimeout(timer);
        target.style.visibility = "";
        cardCanvas.remove();
        renderLoop.remove(viewer);
      };
      const timer = setTimeout(land, LANDING_TIMEOUT);
      mountMascotViewer(land);
    },
  });

  return true;
}

function showDetail(characterId, cardCanvas) {
  const character = getCharacter(characterId);
  state.view = "detail";
  state.detailId = characterId;
  // falls back to the plain mount when there is nothing to fly from (the
  // rail's next-character link), so the flight is an enhancement, never a
  // dependency
  if (cardCanvas && flyToDetail(character, cardCanvas)) return;
  mount(() => buildDetailView(characterId));
}

showGrid();
