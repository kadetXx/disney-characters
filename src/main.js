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

function mountMascotViewer() {
  const mount = pendingMascot;
  pendingMascot = null;
  mount?.();
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
  body.appendChild(canvas);

  view.appendChild(body);

  // Deferred during a flight: a second full-size viewer rendering the same
  // character while the flight is mid-air doubles the per-frame cost at
  // exactly the wrong moment. mountMascotViewer() is called on landing.
  const mount = () => {
    mainViewer = createViewer(canvas, {
      modelUrl: character.model,
      ...detailFraming(character),
      yaw: ((character.yawDeg ?? 0) * Math.PI) / 180,
      rimColor: character.rimColor ?? character.gradient[0],
      spinSpeed: 0,
      interactive: true,
    });
    renderLoop.add(mainViewer);
    state.viewers.push(mainViewer);
  };

  if (deferMascot) pendingMascot = mount;
  else mount();

  return view;
}

/* ------------------------------------------------------------------ */
/* View switching                                                     */
/* ------------------------------------------------------------------ */

function mount(buildFn) {
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
// render fewer pixels while the character is in motion and let the browser
// scale the bitmap up; at speed the softness is invisible and it keeps the
// per-frame cost well clear of the frame budget
const FLIGHT_RENDER_SCALE = 0.75;

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

  // hand the viewer to the flight before clearViewers() can dispose it
  state.viewers = state.viewers.filter((v) => v !== viewer);

  // Build the destination at its final size, and WITHOUT the usual fadeIn():
  // that enters from scale(0.96), so any rect measured under it is 4% short
  // and the flight lands in the wrong place. The mascot's own viewer is
  // deferred until landing so it isn't rendering full-size alongside us.
  clearViewers();
  app.innerHTML = "";
  const view = buildDetailView(character.id, { deferMascot: true });
  app.appendChild(view);

  const target = view.querySelector(".detail-mascot-canvas");
  const to = target.getBoundingClientRect();
  target.style.visibility = "hidden";

  const stageRect = unionRect(from, to);
  cardCanvas.classList.add("flight-canvas");
  cardCanvas.style.left = `${stageRect.left}px`;
  cardCanvas.style.top = `${stageRect.top}px`;
  cardCanvas.style.width = `${stageRect.width}px`;
  cardCanvas.style.height = `${stageRect.height}px`;
  document.body.appendChild(cardCanvas);
  // the one and only allocation for the whole flight
  viewer.setSize(stageRect.width, stageRect.height, FLIGHT_RENDER_SCALE);

  const fromFraming = cardFraming(character);
  const toFraming = detailFraming(character);

  const apply = (t) => {
    viewer.setProjectedFraming(
      lerpRect(from, to, t),
      stageRect,
      lerp(fromFraming.distanceScale, toFraming.distanceScale, t),
      lerp(fromFraming.verticalAnchor, toFraming.verticalAnchor, t)
    );
    viewer.render();
  };
  apply(0);

  // opacity only, no transform -- the panel must not move the layout while the
  // character is flying toward a rect measured against it
  gsap.fromTo(view, { opacity: 0 }, { opacity: 1, duration: 0.34, ease: "power2.out" });

  const progress = { t: 0 };
  gsap.to(progress, {
    t: 1,
    duration: FLIGHT_SECONDS,
    ease: "power3.inOut",
    onUpdate: () => apply(progress.t),
    onComplete() {
      mountMascotViewer();
      target.style.visibility = "";
      cardCanvas.remove();
      renderLoop.remove(viewer);
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
