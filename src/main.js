import gsap from "gsap";
import { characters, getCharacter, getMovie, defaultCharacterId } from "./data/characters.js";
import { createViewer, createRenderLoop, prefetchModel, setMeshMode } from "./three/viewer.js";

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

// Longest the off-screen models will wait on the visible ones before being
// fetched anyway. Only reached if a visible model never resolves at all --
// otherwise the prefetch starts the moment the last visible card has drawn.
const PREFETCH_FALLBACK_MS = 8000;

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

// The panel's colour, and the tint its clip stills are graded toward. Three
// unrelated trailer frames side by side brought three unrelated palettes with
// them and fought both each other and the panel; toned to one colour they read
// as a row of three rather than three separate pictures. The middle gradient
// stop is the panel's dominant tone -- the ends are its highlight and shadow.
function paintPanel(panel, character) {
  panel.style.background = gradientCss(character);
  panel.style.setProperty("--clip-tint", character.gradient[1]);
  panel.style.setProperty("--panel-ratio", character.panelRatio ?? 1.06);
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

const CORNERS = [
  "borderTopLeftRadius",
  "borderBottomLeftRadius",
  "borderTopRightRadius",
  "borderBottomRightRadius",
];

// Which side the panel's big sweep is on is a stylesheet decision: the rail
// sits on the left on desktop, and on the right on a phone, where it is the
// one thing here you actually operate and a thumb has to reach it. So the
// corners are given their roles by reading the resting panel rather than being
// named -- flip the panel in CSS and the morph mirrors itself.
//
//  - the top corner with the radius grows INTO the panel's signature sweep and
//    is carried through the whole move, because it is the one the eye follows;
//  - the bottom corner beneath it simply rides along, rounding that whole edge
//    with it and never straightening -- which it gets away with only because
//    the panel's bottom overshoots the viewport (see PANEL_BOTTOM_OVERSHOOT);
//  - the far pair resolve to a square 0, and hold the card's own radius until
//    the box has essentially landed. Straightening early reads as the panel
//    losing its shape before it arrives.
function cornerRoles(target) {
  const onLeft =
    (parseFloat(target.borderTopLeftRadius) || 0) >=
    (parseFloat(target.borderTopRightRadius) || 0);
  return onLeft
    ? {
        growing: ["borderTopLeftRadius"],
        joining: "borderBottomLeftRadius",
        late: ["borderTopRightRadius", "borderBottomRightRadius"],
      }
    : {
        growing: ["borderTopRightRadius"],
        joining: "borderBottomRightRadius",
        late: ["borderTopLeftRadius", "borderBottomLeftRadius"],
      };
}

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
  canvasWrap.style.setProperty("--card-nudge", `${character.cardNudge ?? 0}px`);
  canvasWrap.style.setProperty("--aura", rgba(character.gradient[2], AURA.alpha));
  canvasWrap.style.setProperty("--aura-size", AURA.blur);
  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  canvasWrap.appendChild(canvas);
  card.appendChild(canvasWrap);

  const panel = document.createElement("div");
  panel.className = "char-card-panel";
  paintPanel(panel, character);
  panel.innerHTML = `
    <h3 class="char-card-title" style="color:${character.titleTint}">${character.name}</h3>
    <p class="char-card-movie">Movie <b>${character.movie}</b></p>
  `;
  card.appendChild(panel);

  card.addEventListener("click", () => showDetail(character.id, canvas));

  // The viewer is NOT created here. Each character's model is 15-27MB of
  // geometry, and building all six up front meant the whole 112MB had to
  // arrive before the first card could draw. mount() is called by
  // buildGridView: immediately for the cards on screen, then in the
  // background for the rest. Idempotent, so the scroll handler and the
  // prefetch can both reach for it without coordinating.
  let viewer = null;
  // returns true only on the call that actually creates the viewer, so a
  // caller can count how many mounts it is waiting on
  const mount = (onReady) => {
    // a deferred mount can outlive its grid -- if the view has been torn
    // down, the canvas is detached and there is nothing to draw into
    if (viewer || !canvas.isConnected) return false;
    viewer = createViewer(canvas, {
      modelUrl: character.model,
      ...cardFraming(character),
      yaw: ((character.yawDeg ?? 0) * Math.PI) / 180,
      rimColor: character.rimColor ?? character.gradient[0],
      spinSpeed: 0,
      onReady,
    });
    renderLoop.add(viewer);
    state.viewers.push(viewer);
    return true;
  };

  return { card, mount };
}

function buildGridView() {
  const view = document.createElement("div");
  view.className = "grid-view";

  const viewport = document.createElement("div");
  viewport.className = "carousel-viewport";
  const track = document.createElement("div");
  track.className = "carousel-track";
  const mounts = characters.map((character) => {
    const { card, mount } = buildCharacterCard(character);
    track.appendChild(card);
    return {
      id: character.id,
      card,
      mount,
      canvas: card.querySelector("canvas"),
      panel: card.querySelector(".char-card-panel"),
    };
  });
  // how the reverse flight finds the card it is flying back into
  view.cardFor = (id) => mounts.find((m) => m.id === id) ?? null;
  view.otherCards = (id) => mounts.filter((m) => m.id !== id).map((m) => m.card);

  // Every model starts downloading now, on-screen or not. Only the per-viewer
  // work is deferred (see mountNearby). Deferring the fetch as well was a
  // mistake: on a throttled 20Mbit connection, paging to the second screenful
  // the moment the first had drawn left those two cards blank for eleven
  // seconds, because their bytes had not even been asked for yet. The bytes
  // are the part that has to be in flight early; the decode is the part that
  // has to wait its turn.
  for (const character of characters) {
    // a prefetch failure must not surface as an unhandled rejection: the card
    // that needs it will report it properly through onError when it mounts
    prefetchModel(character.model).catch(() => {});
  }
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
        <svg width="9" height="15" viewBox="0 0 9 15" fill="none" aria-hidden="true"><path d="M7.5 1.5L2 7.5L7.5 13.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        Prev
      </button>
      <button class="pager-btn" id="nextBtn" type="button" aria-label="Next">
        Next
        <svg width="9" height="15" viewBox="0 0 9 15" fill="none" aria-hidden="true"><path d="M1.5 1.5L7 7.5L1.5 13.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
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

  // The page a given card sits on: the first one whose screenful contains it
  // outright, and failing that the last, which is where a card past the end of
  // every page must be. With two pages that is simply "left side or right
  // side", which is all the carousel can express.
  function pageHolding(card) {
    const offsets = pageOffsets();
    const left = card.offsetLeft;
    const right = left + card.offsetWidth;
    for (let i = 0; i < offsets.length; i++) {
      if (left >= offsets[i] - 1 && right <= offsets[i] + track.clientWidth + 1) return i;
    }
    return offsets.length - 1;
  }

  // Jump (never slide) the carousel to wherever a character's card lives.
  // Used when returning from the detail view so the card is already on screen
  // -- and, for the reverse flight, so it can be measured before anything
  // moves. scroll-behavior is smooth in the stylesheet, so it has to be
  // overridden or this animates instead of applying at once.
  function revealCard(characterId) {
    const index = characters.findIndex((c) => c.id === characterId);
    const entry = mounts[index];
    if (!entry) return;
    const previous = track.style.scrollBehavior;
    track.style.scrollBehavior = "auto";
    track.scrollLeft = pageOffsets()[pageHolding(entry.card)] ?? 0;
    track.style.scrollBehavior = previous;
    syncPagerState();
    syncEdgeScale();
  }
  view.revealCard = revealCard;

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

  // Everything not already mounted, fetched in the background. This is what
  // keeps deferral from ever showing an empty card: the off-screen models are
  // on their way while the user is still looking at the first page, not when
  // they ask for the second. One at a time, so several multi-megabyte decodes
  // cannot pile onto each other.
  let prefetching = false;
  function prefetchRest(index = 0) {
    if (index >= mounts.length) return;
    const { card, mount } = mounts[index];
    if (!card.isConnected) return; // grid torn down; stop walking
    const next = () => prefetchRest(index + 1);
    // wait for each one to finish before starting the following one
    if (!mount(next)) next();
  }
  function startPrefetch() {
    if (prefetching) return;
    prefetching = true;
    prefetchRest();
  }

  // Cards whose model should already be in hand: anything on screen, plus half
  // a screen of runway either side, so a card is never mounted at the exact
  // moment it becomes visible.
  //
  // The prefetch deliberately waits until these have actually DRAWN rather
  // than merely been asked for. The models are 15-27MB of geometry each and
  // the cost is meshopt decode and GPU upload, not download -- measured, every
  // file had arrived by 4.3s but nothing was on screen until 12.8s. Starting
  // all six decoding at once simply made the visible ones queue behind the
  // ones nobody can see.
  let waitingOn = 0;
  function mountNearby() {
    // half a card of runway. Measured against the card, not the scrollport:
    // half a viewport is wider than the entire overflow here, so it swept in
    // all six and the deferral did nothing at all.
    const pad = (mounts[0]?.card.offsetWidth ?? 0) * 0.5;
    for (const { card, mount } of mounts) {
      const r = card.getBoundingClientRect();
      if (r.right <= -pad || r.left >= window.innerWidth + pad) continue;
      if (mount(() => { if (--waitingOn <= 0) startPrefetch(); })) waitingOn++;
    }
  }

  prevBtn.addEventListener("click", () => step(-1));
  nextBtn.addEventListener("click", () => step(1));
  track.addEventListener(
    "scroll",
    () => { syncPagerState(); queueEdgeScale(); mountNearby(); },
    { passive: true }
  );
  window.addEventListener("resize", queueEdgeScale, { passive: true });
  requestAnimationFrame(() => {
    syncPagerState();
    syncEdgeScale();
    // on-screen cards first, so the first paint waits only on those; the rest
    // follow via startPrefetch once these have drawn
    mountNearby();
    // belt and braces: if a visible model never resolves, the off-screen ones
    // must still get fetched rather than waiting on it forever
    setTimeout(startPrefetch, PREFETCH_FALLBACK_MS);
  });

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

// The movie's logo, sitting where the four decorative circles used to. Kept at
// the same footprint so the info row's layout is unchanged, and contained
// rather than cropped so a real logo of any sensible aspect drops straight in
// without being cut.
//
// The four-circle version this replaced is parked, with its placeholder art, at
// ~/Desktop/disney-characters-parked/four-circle-badge -- the idea of putting
// four different images in four circles is still open, it just is not this.
function buildBadge(character) {
  const badge = document.createElement("div");
  badge.className = "detail-badge";
  const movie = getMovie(character.movie);
  const logo = document.createElement("img");
  logo.className = "movie-logo";
  logo.src = movie.logo;
  logo.style.setProperty("--logo-scale", movie.logoScale ?? 1);
  // decorative: the movie is already named in the text beside it
  logo.alt = "";
  badge.appendChild(logo);
  return badge;
}

// Split out of buildDetailView so switching characters can rebuild just this
// block and cross-fade it, instead of rebuilding the whole view.
function buildDetailInfo(character) {
  const info = document.createElement("div");
  info.className = "detail-info";
  info.innerHTML = `
    <div class="detail-text">
      <h2 class="detail-title" style="color:${character.titleTint}">${character.name}</h2>
      <p class="detail-movie">Movie <b>${character.movie}</b></p>
      <p class="detail-description">${character.description}</p>
    </div>
  `;
  info.appendChild(buildBadge(character));
  return info;
}

// The character's canvas, and the viewer that draws into it. Also split out so
// a switch can build a second one and slide it in over the first.
function buildMascotCanvas(character) {
  const canvas = document.createElement("canvas");
  canvas.className = "detail-mascot-canvas";
  canvas.setAttribute("aria-hidden", "true");
  canvas.style.setProperty("--detail-shift-x", `${character.detailShiftX ?? 0}%`);
  canvas.style.setProperty("--detail-shift-y", `${character.detailShiftY ?? 0}%`);
  canvas.style.setProperty("--mobile-nudge", `${character.mobileNudge ?? 0}px`);
  // same accent halo the cards carry, so the character doesn't arrive here
  // permanently stripped of it. Affordable on this canvas and not on the
  // flight's precisely because this one is static -- the blur rasterises once
  // and is cached, rather than being redone every frame.
  canvas.style.setProperty("--aura", rgba(character.gradient[2], AURA.alpha));
  canvas.style.setProperty("--aura-size", AURA.blur);
  return canvas;
}

function mountMascot(canvas, character, onPainted) {
  const viewer = createViewer(canvas, {
    modelUrl: character.model,
    ...detailFraming(character),
    yaw: ((character.yawDeg ?? 0) * Math.PI) / 180,
    rimColor: character.rimColor ?? character.gradient[0],
    spinSpeed: 0,
    onReady: () => {
      viewer.render();
      onPainted?.();
    },
  });
  renderLoop.add(viewer);
  state.viewers.push(viewer);
  return viewer;
}

function buildClips(character) {
  const clips = document.createElement("div");
  clips.className = "detail-clips";
  const label = document.createElement("span");
  label.className = "detail-clips-label";
  label.textContent = "Clips";
  clips.appendChild(label);

  const track = document.createElement("div");
  track.className = "clips-track";

  getMovie(character.movie).clips.forEach((clip, i) => {
    // A div, not a button: once it is playing it contains an iframe, and a
    // button wrapping an interactive player swallows the player's own controls
    // (and is invalid). It carries the button role only while it is still a
    // poster waiting to be clicked -- stopClip puts that back.
    const card = document.createElement("div");
    card.className = "clip-card";
    card.innerHTML = `
      <img class="clip-poster" src="${clip.poster}" alt="" loading="lazy">
      <span class="clip-play">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M10 8.5L16 12L10 15.5V8.5Z" fill="#243A74"/></svg>
      </span>
    `;

    // A video with no maxres thumbnail comes back as a 120x90 grey placeholder
    // on a 404, which loads successfully as far as the browser is concerned --
    // so both the error and the too-small case have to be caught.
    const poster = card.querySelector(".clip-poster");
    const useFallback = () => {
      if (poster.dataset.fallback) return;
      poster.dataset.fallback = "1";
      poster.src = clip.posterFallback;
    };
    poster.addEventListener("error", useFallback);
    poster.addEventListener("load", () => {
      if (poster.naturalWidth < 320) useFallback();
    });

    const asPoster = () => {
      card.setAttribute("role", "button");
      card.setAttribute("tabindex", "0");
      card.setAttribute("aria-label", `Play ${character.movie} trailer ${i + 1}`);
    };
    asPoster();

    const stop = () => {
      card.classList.remove("is-playing");
      // Removing the iframe is what actually stops it -- there is no pause()
      // to reach for without loading YouTube's player API, and leaving it in
      // the DOM leaves the audio running. It costs nothing to rebuild: the
      // next click makes a fresh one.
      card.querySelector(".clip-embed")?.remove();
      asPoster();
    };

    const play = () => {
      if (card.classList.contains("is-playing")) return;
      // only ever one at a time, so starting a second does not leave the first
      // playing behind it
      for (const other of track.querySelectorAll(".clip-card.is-playing")) {
        other.dispatchEvent(new CustomEvent("clip:stop"));
      }
      card.classList.add("is-playing");
      // it is the player's turn to handle keys and clicks now
      card.removeAttribute("role");
      card.removeAttribute("tabindex");
      card.removeAttribute("aria-label");

      // Built on click rather than up front: eighteen embeds across six
      // characters, nearly all of them never played, and each one is a whole
      // document. The poster is what gets seen until one is asked for.
      // autoplay is allowed here because the click IS the user gesture.
      const frame = document.createElement("iframe");
      frame.className = "clip-embed";
      frame.title = `${character.movie} trailer ${i + 1}`;
      frame.allow =
        "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share";
      frame.allowFullscreen = true;
      frame.referrerPolicy = "strict-origin-when-cross-origin";
      // -nocookie so idle viewers who never press play are not tracked
      frame.src =
        `https://www.youtube-nocookie.com/embed/${clip.youtubeId}` +
        `?autoplay=1&rel=0&modestbranding=1&playsinline=1`;
      card.appendChild(frame);
    };

    card.addEventListener("clip:stop", stop);
    card.addEventListener("click", () => {
      if (!card.classList.contains("is-playing")) play();
    });
    card.addEventListener("keydown", (event) => {
      if (card.classList.contains("is-playing")) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        play();
      }
    });
    track.appendChild(card);
  });

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
  paintPanel(panel, character);


  panel.appendChild(buildDetailInfo(character));
  panel.appendChild(buildClips(character));

  body.appendChild(panel);

  const canvas = buildMascotCanvas(character);
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

// fade:false is for the reverse flight, which measures rects inside the view it
// has just mounted -- fadeIn enters from scale(0.96), so anything measured
// under it is 4% short and the flight lands in the wrong place.
function mount(buildFn, { fade = true } = {}) {
  dropOutgoingCards();
  clearViewers();
  app.innerHTML = "";
  const view = buildFn();
  app.appendChild(view);
  if (fade) fadeIn(view);
  return view;
}

// When the grid arrives behind the shrinking panel, as a share of the flight.
// Late on purpose: the shrinking panel does not cover the destination card for
// most of the move -- at the halfway point its left edge is still well right of
// a card sitting at the start of the row -- so bringing the grid in early let
// you see the card being flown into before the flight got there. The cards now
// land just as the panel does, and the character is the only thing to follow
// until then.
const CARD_RETURN_SECONDS = 0.3;
const CARD_RETURN_DELAY = 0.55;
// the detail panel's own text goes early, while the box is still near full
// size; below about this the layout it was written for no longer fits
const DETAIL_TEXT_FADE = 0.28;

// The mirror of flyToDetail: carries the expanded character back into its card
// rather than cutting to the grid. Same machinery throughout -- the mascot's
// own canvas and viewer are adopted, the canvas is sized once to the union of
// both rects, and the character is moved by camera framing alone.
function flyToGrid(characterId) {
  const character = getCharacter(characterId);
  const detailView = app.firstElementChild;
  const mascotCanvas = detailView?.querySelector(".detail-mascot-canvas");
  const viewer = mascotCanvas && state.viewers.find((v) => v.canvas === mascotCanvas);
  if (!viewer) return false;

  const from = mascotCanvas.getBoundingClientRect();
  if (!from.width || !from.height) return false;

  // anything still in the air from the expand (its text ghost, the footer)
  dropOutgoingCards();

  const detailPanel = detailView.querySelector(".detail-panel");
  const panelFrom = detailPanel?.getBoundingClientRect();
  const panelFromCorners = detailPanel ? readCorners(detailPanel) : null;
  const detailContents = detailPanel ? [...detailPanel.children] : [];

  // hand the viewer to the flight before clearViewers() can dispose it
  state.viewers = state.viewers.filter((v) => v !== viewer);

  // Lift the two pieces that carry across out of the detail view before it is
  // torn down. Both are pinned to the box they already occupy, so nothing
  // moves in the frame the grid replaces the detail layout.
  if (detailPanel && panelFrom) {
    Object.assign(detailPanel.style, {
      position: "fixed",
      margin: "0",
      left: `${panelFrom.left}px`,
      top: `${panelFrom.top}px`,
      width: `${panelFrom.width}px`,
      height: `${panelFrom.height}px`,
      zIndex: "5",
      pointerEvents: "none",
      ...panelFromCorners,
    });
    document.body.appendChild(detailPanel);
    outgoingCards.push(detailPanel);
  }
  // the class has to come OFF, not just have .flight-canvas added alongside:
  // .detail-mascot-canvas is declared later in the stylesheet, so at equal
  // specificity its position:absolute and z-index:6 would beat the flight's
  // fixed/60 and the canvas would be laid out against a detail view that no
  // longer exists. Losing its aura with it is correct -- the flight never
  // carries one.
  mascotCanvas.classList.remove("detail-mascot-canvas");
  mascotCanvas.classList.add("flight-canvas");
  document.body.appendChild(mascotCanvas);

  // The close button and the rail's name labels go the same way -- pinned and
  // faded rather than deleted with the view. They fade in on the way out to
  // the detail layout, so cutting them on the way back was the one asymmetry
  // left in the pair.
  for (const el of [detailView.querySelector(".close-row"), detailView.querySelector(".detail-rail")]) {
    if (!el) continue;
    const box = el.getBoundingClientRect();
    Object.assign(el.style, {
      position: "fixed",
      margin: "0",
      left: `${box.left}px`,
      top: `${box.top}px`,
      width: `${box.width}px`,
      height: `${box.height}px`,
      pointerEvents: "none",
    });
    document.body.appendChild(el);
    outgoingCards.push(el);
    gsap.to(el, {
      opacity: 0,
      duration: FLIGHT_SECONDS * DETAIL_TEXT_FADE,
      ease: "power2.in",
      onComplete: () => el.remove(),
    });
  }

  clearViewers();
  app.innerHTML = "";

  // Built without the usual fadeIn for the same reason the forward flight
  // skips it: everything below is measured inside this view.
  const view = buildGridView();
  app.appendChild(view);
  view.revealCard(characterId);

  const target = view.cardFor(characterId);
  if (!target) return false;
  const to = target.canvas.getBoundingClientRect();
  // the flying character stands in for this one until it lands
  target.canvas.style.visibility = "hidden";

  // The card's own viewer has to be building while the flight is in the air,
  // or the hand-off at the end has nothing to hand over to. Its model is
  // already cached, so this is the Box3 and the upload, not a download.
  // mount() is idempotent and ignores the callback once a viewer exists, so
  // the landing cannot just call it again and expect to be told -- it has to
  // leave word here instead.
  let cardReady = false;
  let whenCardReady = null;
  target.mount(() => {
    cardReady = true;
    whenCardReady?.();
  });

  // The cards simply arrive -- they are not reversing their exit. The card
  // being flown into is faded with the rest rather than left standing: it is
  // the one the eye is heading towards, so seeing it sitting there waiting is
  // what gave away the ending. It has to be fully opaque before the flying
  // panel is removed at the landing, which the window below guarantees.
  const arriving = [...view.otherCards(characterId), target.card];
  gsap.fromTo(
    arriving,
    { opacity: 0 },
    {
      opacity: 1,
      duration: FLIGHT_SECONDS * CARD_RETURN_SECONDS,
      ease: "power2.out",
      delay: FLIGHT_SECONDS * CARD_RETURN_DELAY,
    }
  );

  if (detailPanel && panelFrom) {
    const panelTo = target.panel.getBoundingClientRect();
    const panelToCorners = readCorners(target.panel);
    // out early, while the box is still big enough for the layout they were
    // written for; visibility follows so they cannot spill as it shrinks
    gsap.to(detailContents, {
      opacity: 0,
      duration: FLIGHT_SECONDS * DETAIL_TEXT_FADE,
      ease: "power2.in",
      onComplete: () => gsap.set(detailContents, { visibility: "hidden" }),
    });

    const baseEase = gsap.parseEase("power3.inOut");
    const shrink = { t: 0 };
    gsap.to(shrink, {
      t: 1,
      duration: FLIGHT_SECONDS,
      ease: "none",
      onUpdate() {
        const e = baseEase(shrink.t);
        Object.assign(detailPanel.style, {
          left: `${lerp(panelFrom.left, panelTo.left, e)}px`,
          top: `${lerp(panelFrom.top, panelTo.top, e)}px`,
          width: `${lerp(panelFrom.width, panelTo.width, e)}px`,
          height: `${lerp(panelFrom.height, panelTo.height, e)}px`,
          ...Object.fromEntries(
            CORNERS.map((corner) => [
              corner,
              `${lerp(parseFloat(panelFromCorners[corner]) || 0, parseFloat(panelToCorners[corner]) || 0, e)}px`,
            ])
          ),
        });
      },
      onComplete: () => detailPanel.remove(),
    });
  }

  const stageRect = unionRect(from, to);
  mascotCanvas.style.left = `${stageRect.left}px`;
  mascotCanvas.style.top = `${stageRect.top}px`;
  mascotCanvas.style.width = `${stageRect.width}px`;
  mascotCanvas.style.height = `${stageRect.height}px`;

  const fromFraming = detailFraming(character);
  const toFraming = cardFraming(character);

  const apply = (t) => {
    const sharp = t <= FLIGHT_SHARP_EDGE || t >= 1 - FLIGHT_SHARP_EDGE;
    viewer.setSize(stageRect.width, stageRect.height, sharp ? 1 : FLIGHT_RENDER_SCALE);
    viewer.setProjectedFraming(
      lerpRect(from, to, t),
      stageRect,
      lerp(fromFraming.distanceScale, toFraming.distanceScale, t),
      lerp(fromFraming.verticalAnchor, toFraming.verticalAnchor, t)
    );
    viewer.render();
  };
  apply(0);

  const progress = { t: 0 };
  gsap.to(progress, {
    t: 1,
    duration: FLIGHT_SECONDS,
    ease: "power3.inOut",
    onUpdate: () => apply(progress.t),
    onComplete() {
      // same rule as the forward landing: hand over only once the card's own
      // viewer has pixels in it, never merely because it exists
      let landed = false;
      const land = () => {
        if (landed) return;
        landed = true;
        clearTimeout(timer);
        target.canvas.style.visibility = "";
        mascotCanvas.remove();
        renderLoop.remove(viewer);
      };
      const timer = setTimeout(land, LANDING_TIMEOUT);
      if (cardReady) land();
      else whenCardReady = land;
    },
  });

  return true;
}

/* ------------------------------------------------------------------ */
/* Switching between expanded characters                              */
/* ------------------------------------------------------------------ */

const SWITCH_SECONDS = 0.55;
// matches select-weapon's fadeScaleReplace: 240ms, scale 0.95, origin left
const SWITCH_TEXT_SECONDS = 0.24;
const SWITCH_TEXT_SCALE = 0.95;
// how far the clip row drops as it leaves, and arrives from
const SWITCH_CLIPS_DROP = 44;
// how far each model travels, as a share of its own height. The outgoing one
// goes DOWN and the incoming arrives from above, so the swap runs the same way
// the rail's chevron points.
const SWITCH_MODEL_TRAVEL = 0.5;

// Snaps an in-flight switch to its finished state. Set while one is running so
// the next one can land cleanly on top of it.
let endActiveSwitch = null;

// Moves between two expanded characters without moving the expanded slide
// itself. The panel stays exactly where it is and only its contents change:
// its colour washes over to the next character's, the copy cross-fades, the
// clip row drops away and the model is swapped top to bottom, following the
// chevron. Nothing relayouts and the page never slides.
function switchDetail(characterId) {
  // a second click while the first swap is still running would otherwise leave
  // two outgoing copies of everything behind
  endActiveSwitch?.();

  const view = app.firstElementChild;
  if (!view?.classList.contains("detail-view")) return false;
  const body = view.querySelector(".detail-body");
  const panel = view.querySelector(".detail-panel");
  const oldCanvas = view.querySelector(".detail-mascot-canvas");
  const oldInfo = view.querySelector(".detail-info");
  const oldClips = view.querySelector(".detail-clips");
  const rail = view.querySelector(".detail-rail");
  if (!body || !panel || !oldCanvas || !oldInfo || !oldClips || !rail) return false;

  const character = getCharacter(characterId);
  const index = characters.findIndex((c) => c.id === characterId);
  const nextCharacter = characters[(index + 1) % characters.length];

  // Freeze the outgoing character. Disposing its viewer stops it rendering but
  // leaves its canvas holding the last frame, so only the arriving model
  // actually draws while both are on screen.
  clearViewers();

  // --- the panel's colour ------------------------------------------------
  // A gradient cannot be tweened, so the next character's is laid over the
  // panel and faded up, then adopted as the panel's own. border-radius is
  // inherited so it follows the panel's corner exactly.
  const wash = document.createElement("div");
  wash.className = "panel-wash";
  wash.style.background = gradientCss(character);
  panel.insertBefore(wash, panel.firstChild);

  // --- the copy and the clip row ----------------------------------------
  // The outgoing pair are pinned to the boxes they already occupy and taken
  // out of flow, so the incoming pair lay out in exactly the slots they just
  // vacated. Switching the panel to a grid to overlap them instead would
  // change its layout algorithm mid-transition and shift the contents; this
  // leaves the panel a flex column throughout, which is what it is built as.
  const panelRect = panel.getBoundingClientRect();
  // Every box is measured BEFORE any of them is moved. Pinning one at a time
  // does not work: the panel is a flex column with justify-content
  // space-between, so the instant the copy goes position:absolute the clip row
  // is the only child left in flow and jumps to the top -- and that is then
  // the position it gets pinned at, so it flew up before dropping away.
  const pinned = [oldInfo, oldClips].map((el) => ({ el, r: el.getBoundingClientRect() }));
  for (const { el, r } of pinned) {
    Object.assign(el.style, {
      position: "absolute",
      left: `${r.left - panelRect.left}px`,
      top: `${r.top - panelRect.top}px`,
      width: `${r.width}px`,
      height: `${r.height}px`,
      margin: "0",
      pointerEvents: "none",
    });
    el.classList.add("switch-pane");
  }

  const newInfo = buildDetailInfo(character);
  const newClips = buildClips(character);
  newInfo.classList.add("switch-pane");
  newClips.classList.add("switch-pane");
  panel.appendChild(newInfo);
  panel.appendChild(newClips);

  // --- the model ---------------------------------------------------------
  const newCanvas = buildMascotCanvas(character);
  body.appendChild(newCanvas);
  mountMascot(newCanvas, character, null);

  const travel = oldCanvas.getBoundingClientRect().height * SWITCH_MODEL_TRAVEL;

  const tl = gsap.timeline();
  tl.to(wash, { opacity: 1, duration: SWITCH_SECONDS * 0.7, ease: "power2.inOut" }, 0);

  // copy and clips cross-fade on select-weapon's curve
  tl.to(oldInfo, { opacity: 0, scale: SWITCH_TEXT_SCALE, duration: SWITCH_TEXT_SECONDS, ease: "power2.in" }, 0);
  tl.fromTo(
    newInfo,
    { opacity: 0, scale: SWITCH_TEXT_SCALE },
    { opacity: 1, scale: 1, duration: SWITCH_TEXT_SECONDS, ease: "power2.out" },
    SWITCH_TEXT_SECONDS * 0.8
  );

  tl.to(oldClips, { opacity: 0, y: SWITCH_CLIPS_DROP, duration: SWITCH_TEXT_SECONDS, ease: "power2.in" }, 0);
  // in from ABOVE, not back up from below: the whole swap runs one way down
  // the screen, the same way the chevron points, so the clip row arriving has
  // to travel with the model rather than against it
  tl.fromTo(
    newClips,
    { opacity: 0, y: -SWITCH_CLIPS_DROP },
    { opacity: 1, y: 0, duration: SWITCH_TEXT_SECONDS * 1.3, ease: "power2.out" },
    SWITCH_TEXT_SECONDS * 0.8
  );

  // the swap that follows the chevron: this one out of the bottom, the next in
  // from the top
  // The one leaving goes quicker than the one arriving, and on a harder curve.
  // Matching their speeds left two characters sharing the frame for most of
  // the switch, which is what made it feel crowded rather than smooth -- the
  // outgoing one has nothing left to say, so it should clear out and leave the
  // arrival to be the thing you watch.
  tl.to(oldCanvas, { y: travel, opacity: 0, duration: SWITCH_SECONDS * 0.38, ease: "power3.in" }, 0);
  tl.fromTo(
    newCanvas,
    { y: -travel, opacity: 0 },
    { y: 0, opacity: 1, duration: SWITCH_SECONDS * 0.7, ease: "power3.out" },
    SWITCH_SECONDS * 0.22
  );

  // --- the rail ----------------------------------------------------------
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
  tl.fromTo(rail, { opacity: 0 }, { opacity: 1, duration: SWITCH_TEXT_SECONDS, ease: "power2.out" }, 0);

  const finish = () => {
    if (endActiveSwitch !== finish) return;
    endActiveSwitch = null;
    tl.kill();
    // the wash becomes the panel's own background, and every outgoing piece goes
    paintPanel(panel, character);
    wash.remove();
    oldInfo.remove();
    oldClips.remove();
    oldCanvas.remove();
    for (const el of [newInfo, newClips, newCanvas]) {
      el.classList.remove("switch-pane");
      gsap.set(el, { clearProps: "opacity,transform" });
    }
  };
  endActiveSwitch = finish;
  tl.eventCallback("onComplete", finish);

  return true;
}

// A playing embed is a live document with sound, and the flight back to the
// grid takes long enough for it to be heard over a view it no longer belongs
// to. Switching characters tears its clip row out of the DOM, which stops it;
// closing does not, so it is stopped here.
function stopAllClips() {
  for (const card of document.querySelectorAll(".clip-card.is-playing")) {
    card.dispatchEvent(new CustomEvent("clip:stop"));
  }
}

function showGrid() {
  stopAllClips();
  resetYawFollow();
  state.view = "grid";
  // flies the character back into its card when there is one in the air to
  // fly; falls back to a plain mount otherwise (first load, or a failed flight)
  if (flyToGrid(state.detailId)) return;
  const view = mount(buildGridView);
  // come back to the page the character was on, rather than always to page one
  view.revealCard?.(state.detailId);
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

// The clicked card's own title and movie line are carried across the flight as
// a ghost, because nothing else covers that gap: the real card dies with the
// grid, and the detail panel's contents cannot appear until late (they are
// laid out against a padding-left of up to 620px, so at card width the badge
// spills out and the description clips). Without this the text blinks out on
// the very first frame of the flight and fades back in two thirds of the way
// through -- read as a flash right at the click.
//
// Fades out across this window, which overlaps the detail contents fading in,
// so the two crossfade rather than leaving a gap with no text at all.
const CARD_TEXT_FADE_FROM = 0.5;
const CARD_TEXT_FADE_TO = 0.95;
// the grid footer is chrome rather than a card, so it just fades rather than
// dropping and tilting -- but it has to go somewhere, not vanish with the grid
const FOOTER_FADE_SECONDS = 0.22;
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

// How far past the bottom of the viewport the panel's bottom edge travels,
// over and above its final radius. The panel keeps growing downward until its
// rounded bottom-left corner is entirely below the fold -- like dragging a
// sheet of paper down behind the screen edge -- so the corner never has to
// straighten on screen. Once it is off the fold the stylesheet's own square
// bottom is indistinguishable from it, and the landing hand-off is invisible.
const PANEL_BOTTOM_OVERSHOOT = 8;

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

  // measured before the teardown, pinned after it
  const gridFooter = app.querySelector(".grid-footer");
  const footerFrom = gridFooter?.getBoundingClientRect();

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

  // A copy of the clicked card's panel, stripped to just its text. Cloning the
  // whole panel rather than lifting the title and movie line individually is
  // what makes the text land exactly where it already was -- it inherits the
  // panel's own padding, font sizes and flex-end alignment for free, so there
  // is no second set of numbers to keep in step with the stylesheet. The
  // background and shadow come off because the real detail panel is already
  // drawing those, directly underneath.
  let cardTextGhost = null;
  if (cardPanel && panelFrom) {
    cardTextGhost = cardPanel.cloneNode(true);
    Object.assign(cardTextGhost.style, {
      position: "fixed",
      margin: "0",
      left: `${panelFrom.left}px`,
      top: `${panelFrom.top}px`,
      width: `${panelFrom.width}px`,
      height: `${panelFrom.height}px`,
      background: "none",
      boxShadow: "none",
      // above the growing panel (5), below the character in flight (60)
      zIndex: "6",
      pointerEvents: "none",
    });
    document.body.appendChild(cardTextGhost);
    outgoingCards.push(cardTextGhost);
  }

  if (gridFooter && footerFrom) {
    Object.assign(gridFooter.style, {
      position: "fixed",
      margin: "0",
      left: `${footerFrom.left}px`,
      top: `${footerFrom.top}px`,
      width: `${footerFrom.width}px`,
      height: `${footerFrom.height}px`,
      zIndex: "2",
      pointerEvents: "none",
    });
    document.body.appendChild(gridFooter);
    outgoingCards.push(gridFooter);
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
    const roles = cornerRoles(panelToCorners);
    const pick = (corners) =>
      Object.fromEntries(corners.map((corner) => [corner, panelToCorners[corner]]));

    gsap.to(panel, {
      ...pick(roles.growing),
      duration: FLIGHT_SECONDS,
      ease: "power3.inOut",
    });

    // The right pair are headed for a square 0, and a corner going square while
    // the box is still moving reads as the panel straightening out before it
    // has landed. They hold the card's own radius and only square off once the
    // box is essentially in position.
    gsap.to(panel, {
      ...pick(roles.late),
      duration: FLIGHT_SECONDS * (1 - CORNER_SPLIT),
      ease: "power2.inOut",
      delay: FLIGHT_SECONDS * CORNER_SPLIT,
    });

    // Bottom-left starts on the card's radius exactly as top-left does, so it
    // can simply BE top-left for the whole move: the two rise together and the
    // entire left edge rounds as the panel opens, with no second phase and no
    // switch of behaviour to hide.
    const [growingCorner] = roles.growing;
    const fromGrowing = parseFloat(panelFromCorners[growingCorner]) || 0;
    const toGrowing = parseFloat(panelToCorners[growingCorner]) || 0;
    const joiningCorner = (base) => lerp(fromGrowing, toGrowing, base);

    // ...which only works because the bottom edge outruns the viewport. The
    // corner's curve occupies the last `radius` pixels of the left edge, so
    // once the bottom sits a full radius below the fold the curve is entirely
    // out of sight and the edge reads as straight all the way down. The
    // stylesheet's resting box -- square, ending exactly at the fold -- looks
    // identical, which is what makes the hand-off on landing invisible.
    const bottomTo = panelTo.bottom + toGrowing + PANEL_BOTTOM_OVERSHOOT;

    // Growing past the fold would otherwise drag the panel's contents down
    // with it, since they are laid out with space-between against whatever
    // height the box currently has. Adding the overshoot to the bottom padding
    // cancels it out of the content box exactly (box-sizing is border-box
    // throughout), so the text, badge and clips sit where they always did.
    const basePadBottom = parseFloat(getComputedStyle(panel).paddingBottom) || 0;

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
      const bottom = lerp(panelFrom.bottom, bottomTo, down);
      const left = lerp(panelFrom.left, panelTo.left, base);
      const right = lerp(panelFrom.right, panelTo.right, base);
      // only what has actually gone past the fold needs cancelling; before
      // that the panel is still a card-sized box on screen
      const belowFold = Math.max(0, bottom - panelTo.bottom);
      Object.assign(panel.style, {
        left: `${left}px`,
        top: `${top}px`,
        width: `${right - left}px`,
        height: `${bottom - top}px`,
        paddingBottom: `${basePadBottom + belowFold}px`,
        // driven here rather than as its own tween so it can track top-left
        // exactly -- see joiningCorner
        [roles.joining]: `${joiningCorner(base)}px`,
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
        gsap.set(panel, {
          clearProps: "position,zIndex,left,top,width,height,paddingBottom," + CORNERS.join(","),
        });
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

  // the card's text holds its place while the panel grows out from under it,
  // then hands over to the detail panel's own title as that fades in
  if (cardTextGhost) {
    gsap.to(cardTextGhost, {
      opacity: 0,
      duration: FLIGHT_SECONDS * (CARD_TEXT_FADE_TO - CARD_TEXT_FADE_FROM),
      ease: "power2.in",
      delay: FLIGHT_SECONDS * CARD_TEXT_FADE_FROM,
      onComplete() {
        cardTextGhost.remove();
      },
    });
  }

  if (gridFooter) {
    gsap.to(gridFooter, {
      opacity: 0,
      duration: FOOTER_FADE_SECONDS,
      ease: "power2.in",
      onComplete() {
        gridFooter.remove();
      },
    });
  }

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

    // collects only the cards it animated -- the text ghost and the footer are
    // on their own, longer schedules and must not be swept up with them
    const exit = gsap.timeline({
      onComplete() {
        for (const { card } of leaving) card.remove();
      },
    });
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
  // a new character starts facing front, however the last one was left
  resetYawFollow();
  const character = getCharacter(characterId);
  const fromDetail = state.view === "detail";
  state.view = "detail";
  state.detailId = characterId;
  // Three ways in, each falling through to the next so every transition is an
  // enhancement rather than a dependency: flying from a card, sliding between
  // two expanded characters, or a plain mount.
  if (cardCanvas && flyToDetail(character, cardCanvas)) return;
  if (fromDetail && switchDetail(characterId)) return;
  mount(() => buildDetailView(characterId));
}

/* ------------------------------------------------------------------ */
/* Turning the character with the cursor                              */
/* ------------------------------------------------------------------ */

// How much of a turn the swing is worth, and how far the cursor has to travel
// to reach the end of it, as a share of the viewport width.
const YAW_SWING = 0.42;
const YAW_SPAN = 0.33;

// The expanded character follows the cursor, with no hover needed to start it.
//
// What she follows is how far the cursor has moved from where it FIRST moved,
// not where it sits on screen. Absolute position cannot work: the pointer is
// wherever the last click left it when the view opens -- frequently out at the
// rail or over the panel -- and mapping that directly would snap her hard
// round before the cursor had moved at all. Taking the first move as neutral
// means she starts facing front wherever the pointer happens to be, and turns
// only in response to actual movement.
//
// This also replaced a hover-to-arm version that hit-tested the rendered
// alpha to find her silhouette. None of that is needed now, and the
// per-pointermove getImageData readback it cost goes with it.
let yawOrigin = null;
let yawFrame = null;
let lastPointer = null;

// called whenever the expanded character changes or the view is left, so the
// next one starts facing front and re-establishes its own neutral
function resetYawFollow() {
  yawOrigin = null;
  lastPointer = null;
  const canvas = document.querySelector(".detail-mascot-canvas");
  state.viewers.find((v) => v.canvas === canvas)?.setYawOffset(0);
}

function pointerYaw() {
  yawFrame = null;
  if (lastPointer === null) return;
  const canvas = document.querySelector(".detail-mascot-canvas");
  if (!canvas) return;
  const viewer = state.viewers.find((v) => v.canvas === canvas);
  if (!viewer) return;

  // the first move only establishes neutral -- she does not turn for it
  if (yawOrigin === null) {
    yawOrigin = lastPointer;
    viewer.setYawOffset(0);
    return;
  }

  const span = Math.max(1, window.innerWidth * YAW_SPAN);
  const side = Math.max(-1, Math.min(1, (lastPointer - yawOrigin) / span));
  viewer.setYawOffset(side * YAW_SWING);
}

document.addEventListener(
  "pointermove",
  (event) => {
    lastPointer = event.clientX;
    // one update per frame at most; the pointer fires far more often than the
    // page can paint, and this does a DOM lookup
    if (yawFrame === null) yawFrame = requestAnimationFrame(pointerYaw);
  },
  { passive: true }
);

// The Menu button has nothing to open, so it toggles a look at how the page is
// built instead: the whole thing desaturates and every character drops its
// texture for its raw topology.
const menuBtn = document.querySelector(".menu-btn");
let meshMode = false;
menuBtn?.addEventListener("click", () => {
  meshMode = !meshMode;
  document.documentElement.classList.toggle("mesh-mode", meshMode);
  menuBtn.setAttribute("aria-pressed", String(meshMode));
  setMeshMode(meshMode);
  // the materials are shared and the scenes only redraw on demand, so every
  // live viewer has to be told the look changed under it
  for (const viewer of state.viewers) viewer.render();
});

showGrid();
