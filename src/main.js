import { characters, getCharacter, defaultCharacterId } from "./data/characters.js";
import { createViewer, createRenderLoop } from "./three/viewer.js";

// the Google Fonts link is preloaded (not render-blocking) in the HTML head --
// promote it to an active stylesheet once the module script runs
const fontsLink = document.getElementById("fontsStylesheet");
if (fontsLink) fontsLink.rel = "stylesheet";

const renderLoop = createRenderLoop();
const app = document.getElementById("app");

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

  card.addEventListener("click", () => showDetail(character.id));

  const viewer = createViewer(canvas, {
    modelUrl: character.model,
    distanceScale: CARD_DISTANCE_SCALE * (character.zoomAdjust ?? 1),
    verticalAnchor: character.verticalAnchor ?? 0,
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

  function step(direction) {
    const card = track.querySelector(".char-card");
    const cardWidth = card.getBoundingClientRect().width;
    const gap = parseFloat(getComputedStyle(track).columnGap) || 0;
    // ~2.7 cards per press: with 6 cards and roughly 3.3 visible, that's the
    // whole scroll range, so one press lands at the far end rather than nudging
    track.scrollBy({ left: direction * (cardWidth + gap) * 2.7, behavior: "smooth" });
  }

  // Items shrink as they approach and cross the scrollport edge, and return to
  // full size coming back in. The falloff spans two cards at each edge: the
  // outermost reaches EDGE_SCALE_MIN, the one inside it sits about halfway.
  //
  // Measured from layout geometry (offsetWidth / scrollLeft), never from
  // getBoundingClientRect -- that reports the *transformed* box, so feeding it
  // back in would make each card's scale depend on its own previous scale.
  const EDGE_SCALE_MIN = 0.74;
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
    const ramp = (over) => Math.min(1, Math.max(0, (over + 1) / 2));

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
    const maxScroll = track.scrollWidth - track.clientWidth - 2;
    prevBtn.disabled = track.scrollLeft <= 0;
    nextBtn.disabled = track.scrollLeft >= maxScroll;
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

function buildDetailView(characterId) {
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

  mainViewer = createViewer(canvas, {
    modelUrl: character.model,
    distanceScale: MASCOT_DISTANCE_SCALE * (character.detailZoom ?? 1),
    verticalAnchor: character.detailAnchor ?? 0,
    yaw: ((character.yawDeg ?? 0) * Math.PI) / 180,
    rimColor: character.rimColor ?? character.gradient[0],
    spinSpeed: 0,
    interactive: true,
  });
  renderLoop.add(mainViewer);
  state.viewers.push(mainViewer);

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

function showDetail(characterId) {
  state.view = "detail";
  state.detailId = characterId;
  mount(() => buildDetailView(characterId));
}

showGrid();
