import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

const loader = new GLTFLoader();

// The characters are Draco-compressed: 112MB of meshopt became 51MB, which is
// what got them under Cloudflare Pages' 25 MiB per-file cap (moana was 27) and
// halves every cold load into the bargain.
//
// The decoder is served from our own /draco/ rather than Google's CDN, because
// script-src is 'self' and the CDN copy would simply be refused. Three files,
// 752KB, copied from three's own examples/jsm/libs/draco/gltf.
//
// DRACOLoader runs the decoder in a worker built from a blob, so index.html's
// CSP carries `worker-src 'self' blob:`. Without it the worker is refused and
// nothing renders at all -- which is exactly how this was left last time it was
// attempted, and why that attempt's "comparison" was a blank canvas.
const draco = new DRACOLoader();
draco.setDecoderPath(import.meta.env.BASE_URL + "draco/");
loader.setDRACOLoader(draco);

// Kept alongside it. Draco replaced meshopt in these files, but the two
// extensions are independent and a glTF may carry either -- registering both
// costs nothing and means a model dropped in with meshopt still loads.
loader.setMeshoptDecoder(MeshoptDecoder);

const modelCache = new Map();

// How glossy the characters read. Roughness is clamped (lower = sharper
// reflections) and a clearcoat layer sits on top, like the lacquer on a vinyl
// figure. Gloss needs something to reflect, so this only shows up alongside
// the environment map below.
// One place to tune how the characters are lit and how shiny they read.
// envIntensity is the big lever for "too shiny": it controls how much of the
// environment they reflect, and it also lifts the shadow side, so turning it
// down both dulls the sheen and restores light-to-dark falloff across the form.
// ambient vs key is the other lever -- a low ambient with a strong key is what
// gives them shape instead of looking evenly lit from everywhere.
const LOOK = {
  // Deliberately NOT clamping roughness. A Math.min() clamp can only ever make
  // a material shinier, so anything authored matte (knit wool, soft cloth) got
  // dragged glossy against its own definition while already-smooth models
  // passed through untouched -- which is why only some characters read wrong.
  // The clearcoat is additive instead: a thin lacquer over the top that leaves
  // each model's authored matte/shiny balance intact.
  // These models bake their lighting into the base colour texture, so the
  // albedo arrives already bright and evenly lit -- which is why scene lighting
  // alone barely moves them. albedo multiplies that texture down; normalScale
  // deepens the relief the normal map already carries.
  toneMapping: 'neutral',   // 'aces' | 'neutral' | 'linear' | 'none'
  albedo: 0.8,
  normalScale: 1.6,
  // two independent sources of shine: the clearcoat lacquer layer, and the
  // base material's own specular reflection of the environment. Zero both for
  // a fully matte finish -- the env map still lights the characters diffusely,
  // so the colour richness is unaffected either way.
  clearcoat: 0.0,
  clearcoatRoughness: 0.3,
  specularIntensity: 0.15,
  envIntensity: 0.25,
  exposure: 0.9,
  ambient: 0.1,
  key: 2.0,
  rim: 1.2,
  // a rim light has to GRAZE the silhouette to register. Sat straight behind
  // the character it only lights surfaces facing away from camera, so it was
  // invisible; out to the side and slightly behind catches the visible edge.
  rimPos: [-6, 1.2, -1.2],
};
const GLOSS = LOOK;

// Every material this module creates, so a display mode can be applied across
// every character at once. They are shared between viewers already (the gloss
// pass runs on the cached source scene), so this is one set for the whole app.
const characterMaterials = new Set();

// Strips the texture and leaves the bare form. `map` is stashed and put back
// rather than rebuilt, so nothing is reloaded on the way out.
export function setMeshMode(on) {
  for (const m of characterMaterials) {
    if (on) {
      if (m.userData.texturedMap === undefined) m.userData.texturedMap = m.map;
      m.map = null;
    } else if (m.userData.texturedMap !== undefined) {
      m.map = m.userData.texturedMap;
    }
    m.needsUpdate = true;
  }
}

// glTF gives us MeshStandardMaterial; MeshPhysicalMaterial adds the clearcoat.
// Built field by field rather than via copy(), which would read clearcoat
// properties off the standard material that don't exist there.
function toGlossy(m) {
  if (!m || !m.isMeshStandardMaterial || m.isMeshPhysicalMaterial) return m;
  const g = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(GLOSS.albedo, GLOSS.albedo, GLOSS.albedo).multiply(m.color ?? new THREE.Color(1, 1, 1)),
    map: m.map,
    normalMap: m.normalMap,
    normalScale: (m.normalScale ?? new THREE.Vector2(1, 1)).clone().multiplyScalar(GLOSS.normalScale),
    roughnessMap: m.roughnessMap, metalnessMap: m.metalnessMap,
    aoMap: m.aoMap, aoMapIntensity: m.aoMapIntensity,
    emissive: m.emissive, emissiveMap: m.emissiveMap, emissiveIntensity: m.emissiveIntensity,
    alphaMap: m.alphaMap, transparent: m.transparent, opacity: m.opacity,
    alphaTest: m.alphaTest, side: m.side, vertexColors: m.vertexColors,
    metalness: m.metalness,
    roughness: m.roughness,
    specularIntensity: GLOSS.specularIntensity,
    clearcoat: GLOSS.clearcoat,
    clearcoatRoughness: GLOSS.clearcoatRoughness,
    envMapIntensity: GLOSS.envIntensity,
  });
  g.name = m.name;
  characterMaterials.add(g);
  return g;
}

// applied once to the cached source scene, so every clone of a model inherits
// it and the six card viewers keep sharing one set of materials
function applyGloss(root) {
  root.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    o.material = Array.isArray(o.material) ? o.material.map(toGlossy) : toGlossy(o.material);
  });
}

// Pulls a model's BYTES into the HTTP cache without decoding it.
//
// This used to call loadModel, which parses as well -- and parsing is the
// expensive half by a wide margin. Decoded, the six characters are ~580MB of
// vertex and index buffers on the CPU (moana alone is 126MB, 3M triangles) and
// roughly as much again once uploaded. Doing that for all six at page load is
// about a gigabyte, which iOS Safari answers by killing the tab: the page
// reloads, reloads again, then shows "a problem repeatedly occurred".
//
// The original reasoning still holds and is preserved here -- deferring the
// FETCH was a mistake, because paging to the second screenful left those cards
// blank for eleven seconds waiting on bytes nobody had asked for. Bytes early,
// decode late. The bug was that one call did both.
//
// The bytes are held rather than left to the HTTP cache, because loadModel
// parses straight out of them. That avoids the obvious trap in fetching and
// parsing separately -- two requests racing for the same URL, which browsers
// do not reliably coalesce, so a cold load would pull every model twice. All
// six as compressed GLB is 51MB, and each buffer is dropped the moment it has
// been parsed.
const byteCache = new Map();

export function prefetchModel(url) {
  if (modelCache.has(url)) return modelCache.get(url).then(() => undefined);
  if (!byteCache.has(url)) {
    byteCache.set(
      url,
      fetch(url, { credentials: "same-origin" })
        .then((response) => {
          if (!response.ok) throw new Error(`${response.status} for ${url}`);
          const total = Number(response.headers.get("content-length")) || 0;
          if (total) modelBytes.set(url, { loaded: total, total });
          return response.arrayBuffer();
        })
        .then((buffer) => {
          // report it as arrived, so the loading sheet's fill advances on the
          // bytes exactly as it did when the loader owned the download
          for (const listener of byteListeners) listener(url);
          return buffer;
        })
        .catch((error) => {
          byteCache.delete(url);
          modelBytes.delete(url);
          throw error;
        })
    );
  }
  return byteCache.get(url).then(() => undefined);
}

// How far each model's bytes have got, kept for the whole life of the page so a
// loading screen that starts watching late still sees what already arrived --
// including a model the HTML preloaded, whose transfer can be over before any
// of this runs.
const modelBytes = new Map();
const byteListeners = new Set();

// Only ever reports what the transfer actually said. A response that arrives
// without a length (no Content-Length) leaves the model absent from the map
// rather than guessed at: a caller can tell "nothing known" from "0% done" and
// decide for itself, which a fabricated total would take away.
export function modelProgress(url) {
  return modelBytes.get(url) ?? null;
}

export function onModelProgress(listener) {
  byteListeners.add(listener);
  return () => byteListeners.delete(listener);
}

// Parses, and caches the parsed scene. This is the expensive half -- ~85MB of
// buffers for a typical character, 126MB for moana -- so it happens only for a
// character something actually wants to draw, never speculatively for all six.
function loadModel(url) {
  if (!modelCache.has(url)) {
    // If the bytes are already in hand (or on their way), parse those rather
    // than asking the network a second time.
    const source = byteCache.has(url)
      ? byteCache.get(url).then((buffer) => loader.parseAsync(buffer, ""))
      : loader.loadAsync(url, (event) => {
          if (!event.lengthComputable || !event.total) return;
          modelBytes.set(url, { loaded: event.loaded, total: event.total });
          for (const listener of byteListeners) listener(url);
        });
    modelCache.set(
      url,
      source
        .then((gltf) => {
          // the compressed bytes have served their purpose; holding them as
          // well as the parsed scene is 51MB nobody is going to read again
          byteCache.delete(url);
          applyGloss(gltf.scene);
          return gltf.scene;
        })
        .catch((error) => {
          // Drop the failure out of the cache. A rejected promise left in
          // here is permanent: every later viewer of this character -- the
          // detail view, the flight, a second visit -- would await the same
          // rejection with no way to try again.
          modelCache.delete(url);
          // and the part-transferred byte count goes with it, or a retry starts
          // out reading as already half done
          modelBytes.delete(url);
          throw error;
        })
    );
  }
  return modelCache.get(url);
}

// Measured once per model, kept apart from the framing below so framing can be
// re-derived every frame (for the card->detail flight, and on resize) without
// re-running Box3 over the mesh -- and so it stays idempotent: the old
// single-shot version did pivot.position.sub(center), which only lands
// correctly when the pivot starts at the origin.
function measureObject(pivot) {
  // measure AFTER any rotation has been applied to the pivot, so the fit is
  // computed against the silhouette actually being rendered rather than the
  // untwisted one (a turned character presents a different width/height).
  const box = new THREE.Box3().setFromObject(pivot);
  return {
    size: box.getSize(new THREE.Vector3()),
    center: box.getCenter(new THREE.Vector3()),
  };
}

// The camera distance that fits this object inside a viewport of the given
// aspect. Shared by both framing paths so they cannot drift apart.
function fitDistanceFor({ size }, verticalFov, aspect, verticalAnchor) {
  // fit both extents, not just height, or a wide object looks tiny on a wide canvas
  const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * aspect);
  const distanceForHeight = size.y / 2 / Math.tan(verticalFov / 2);
  const distanceForWidth = size.x / 2 / Math.tan(horizontalFov / 2);
  const fit = Math.max(distanceForHeight, distanceForWidth, size.z) || 1;
  // the tight fit above touches the frame on all sides with zero margin, so
  // shifting the object down by verticalAnchor afterward would push its feet
  // straight through the bottom of the frustum. Pull the camera back first
  // (in proportion to the shift) to open up exactly enough headroom.
  return fit * (1 + 2 * Math.abs(verticalAnchor));
}

function applyFraming(pivot, camera, measurement, distanceScale, verticalAnchor = 0) {
  const { size, center } = measurement;
  // move the pivot (not the model) so the measured centre lands on the origin
  pivot.position.set(-center.x, -center.y, -center.z);

  const verticalFov = (camera.fov * Math.PI) / 180;
  const fitDistance = fitDistanceFor(measurement, verticalFov, camera.aspect, verticalAnchor);

  camera.position.set(0, 0, fitDistance * distanceScale);
  camera.near = fitDistance / 100;
  camera.far = fitDistance * 100;
  // this path owns the whole canvas, so drop any window the projected path
  // left behind (clearViewOffset updates the projection matrix itself)
  camera.clearViewOffset();

  // the camera looks straight down -Z with no roll, so shifting in world Y is a
  // pure screen-space pan -- this lets the canvas be much taller than the
  // character and still anchor its feet low instead of centring it in all that
  // room, leaving headroom above for tall poses to protrude into.
  pivot.position.y -= verticalAnchor * size.y;
}

// Frames the character so it appears exactly where it WOULD appear if it had a
// canvas of its own occupying `rect` -- while actually being drawn into a
// different, larger canvas occupying `canvasRect`. Both rects are viewport CSS
// pixels.
//
// This is what lets the flight animate without ever resizing its canvas.
// Assigning canvas.width/height reallocates the whole backing store (megabytes
// per frame at retina detail size) and wipes it, which is what made the first
// attempt flash and teleport. Here the canvas is allocated once at the union of
// the two rects and never touched again: the character is moved and grown
// purely by camera distance and pivot offset, which is a few multiplications.
function applyProjectedFraming(pivot, camera, measurement, rect, canvasRect, distanceScale, verticalAnchor = 0) {
  const { size, center } = measurement;
  const verticalFov = (camera.fov * Math.PI) / 180;

  // the distance a canvas of exactly `rect` would have used -- and the distance
  // actually used, unchanged: the canvas being larger no longer means pulling
  // back, because the extra area is added by widening the frustum window below
  // rather than by zooming out.
  const rectDistance =
    fitDistanceFor(measurement, verticalFov, rect.width / rect.height, verticalAnchor) * distanceScale;

  camera.position.set(0, 0, rectDistance);
  camera.near = rectDistance / 100;
  camera.far = rectDistance * 100;

  // The character is placed exactly as applyFraming would place it for a canvas
  // of `rect`: centred on the optical axis, then pushed down by the anchor.
  //
  // Staying ON the axis is the entire point. The previous version slid the
  // pivot sideways to position the character within the larger canvas, and a
  // perspective camera renders anything off its axis at an angle -- so the
  // model visibly yawed the instant the flight took over from the card, and
  // yawed back when the mascot took over at the end. Measured on a 1440x900
  // viewport the character sat 57% of the way to the frustum edge at t=0,
  // which is 11.4 degrees of unasked-for rotation.
  pivot.position.set(-center.x, -center.y - verticalAnchor * size.y, -center.z);

  // ...so the FRUSTUM moves instead of the model. setViewOffset renders a
  // window into a larger virtual image: make that virtual image exactly `rect`
  // (so the pixel scale, and therefore the character's size, is whatever a
  // canvas of `rect` would have given) and the window exactly `canvasRect`.
  // The window's offset within the image is then just the difference between
  // the two boxes' corners -- and the image stays centred on the optical axis,
  // so the character is rendered dead-on however far off-centre it appears.
  camera.aspect = rect.width / rect.height;
  camera.setViewOffset(
    rect.width,
    rect.height,
    canvasRect.left - rect.left,
    canvasRect.top - rect.top,
    canvasRect.width,
    canvasRect.height
  );
}

/* ------------------------------------------------------------------ */
/* Shared stage                                                        */
/* ------------------------------------------------------------------ */

// ONE WebGL context for the whole app, on a canvas that is never in the DOM.
// Viewers draw into a corner of it and then blit the result to their own 2D
// canvas, which is what the user actually sees.
//
// Why not a context per canvas (the previous design): a GPU texture belongs to
// the context that uploaded it, so tearing down a view's contexts threw away
// every texture these 100MB+ models carry and the next view had to re-upload
// all of them. modelCache only ever cached the *parsed* glTF on the JS side.
// Sharing one context means the upload happens once for the life of the page.
//
// The cost is a drawImage per visible canvas whenever a viewer re-renders --
// affordable here precisely because these scenes are static (spinSpeed is 0
// everywhere), so that happens on load, resize and transitions, not per frame.
let stage = null;
function getStage() {
  if (stage) return stage;

  const canvas = document.createElement("canvas");
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  const pixelRatio = Math.min(window.devicePixelRatio, 2);
  renderer.setPixelRatio(pixelRatio);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // ACES has a strong shoulder that re-lifts the midrange, which mutes albedo
  // and exposure changes; the flatter curves respond much more directly
  renderer.toneMapping = {
    aces: THREE.ACESFilmicToneMapping,
    neutral: THREE.NeutralToneMapping,
    linear: THREE.LinearToneMapping,
    none: THREE.NoToneMapping,
  }[LOOK.toneMapping] ?? THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = LOOK.exposure;
  renderer.setScissorTest(true);

  // built once on this context and handed to every scene, instead of each
  // viewer generating its own copy of an identical environment
  const pmrem = new THREE.PMREMGenerator(renderer);
  const environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();

  // grow-only: reallocating the drawing buffer is expensive, and the largest
  // viewer (the detail mascot) sets the high-water mark for everyone
  let width = 0;
  let height = 0;
  function reserve(w, h) {
    if (w <= width && h <= height) return;
    width = Math.max(width, Math.ceil(w));
    height = Math.max(height, Math.ceil(h));
    renderer.setSize(width, height, false);
  }

  // Renders into the TOP-LEFT of the stage buffer, then copies that region
  // across. GL's viewport origin is bottom-left, so the top of the image is
  // at y = height - h.
  function draw(scene, camera, target, cssWidth, cssHeight) {
    if (!cssWidth || !cssHeight) return;
    reserve(cssWidth, cssHeight);
    renderer.setViewport(0, height - cssHeight, cssWidth, cssHeight);
    renderer.setScissor(0, height - cssHeight, cssWidth, cssHeight);
    renderer.render(scene, camera);

    const ctx = target.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, target.width, target.height);
    // read back in device pixels (canvas.width is already scaled), and let the
    // destination rect match the target's own buffer 1:1 so nothing resamples.
    // Valid without preserveDrawingBuffer because this runs synchronously
    // after render(), before the browser gets a chance to composite.
    ctx.drawImage(
      canvas,
      0, 0, Math.round(cssWidth * pixelRatio), Math.round(cssHeight * pixelRatio),
      0, 0, target.width, target.height
    );
  }

  stage = { renderer, environment, draw, pixelRatio };
  return stage;
}

export function createViewer(canvas, { modelUrl, distanceScale = 1.6, verticalAnchor = 0, yaw = 0, rimColor = 0xffa93e, spinSpeed = 0.25, onReady, onError }) {
  const { environment, draw, pixelRatio } = getStage();

  const scene = new THREE.Scene();
  scene.environment = environment;
  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);

  // dialled back from the un-lit-environment values: the env map now carries
  // most of the fill, and these only add shape and a warm rim
  scene.add(new THREE.AmbientLight(0xffffff, LOOK.ambient));
  const key = new THREE.DirectionalLight(0xfff2d9, LOOK.key);
  key.position.set(3, 4, 5);
  scene.add(key);
  // tinted to the character's own card accent so they read as lit by their
  // panel rather than pasted onto it
  const rim = new THREE.DirectionalLight(rimColor, LOOK.rim);
  rim.position.set(...LOOK.rimPos);
  scene.add(rim);

  const rig = new THREE.Group();
  scene.add(rig);

  let disposed = false;
  let currentModel = null;
  // the model's measured bounds plus whichever framing is currently applied,
  // held so framing can be re-derived on resize (the fit depends on aspect)
  // and driven frame by frame during the flight
  let measurement = null;
  let framing = { distanceScale, verticalAnchor };
  // When set, the character is being framed as though it occupied some other
  // rect (the flight). Held so a resize re-applies the SAME framing mode --
  // otherwise the ResizeObserver, which fires as soon as the flight sets the
  // canvas's CSS box, would reset the character to plain centred framing
  // in the middle of the move.
  let projection = null;
  // likewise remembered, so an incidental resize doesn't silently restore
  // full-resolution rendering and undo the flight's reduced buffer
  let renderScale = 1;
  // the scenes are static (spin is off), so redraw only when something
  // actually changes rather than re-rendering all seven viewers every frame
  let needsRender = true;
  const invalidate = () => { needsRender = true; };

  function setFraming(nextDistanceScale = framing.distanceScale, nextVerticalAnchor = framing.verticalAnchor) {
    framing = { distanceScale: nextDistanceScale, verticalAnchor: nextVerticalAnchor };
    projection = null;
    if (!measurement || !currentModel) return;
    applyFraming(currentModel, camera, measurement, framing.distanceScale, framing.verticalAnchor);
    invalidate();
  }

  // re-applies whichever framing mode is currently in effect
  function reframe() {
    if (!measurement || !currentModel) return;
    if (projection) {
      applyProjectedFraming(
        currentModel, camera, measurement, projection.rect, projection.canvasRect,
        framing.distanceScale, framing.verticalAnchor
      );
    } else {
      applyFraming(currentModel, camera, measurement, framing.distanceScale, framing.verticalAnchor);
    }
    invalidate();
  }

  // draws the character as though it occupied `rect`, while really rendering
  // into this viewer's (larger, fixed) canvas at `canvasRect` -- see
  // applyProjectedFraming
  function setProjectedFraming(rect, canvasRect, nextDistanceScale, nextVerticalAnchor) {
    framing = { distanceScale: nextDistanceScale, verticalAnchor: nextVerticalAnchor };
    projection = { rect, canvasRect };
    reframe();
  }

  function setModel(url, modelDistanceScale = distanceScale, modelVerticalAnchor = verticalAnchor, modelYaw = yaw) {
    if (currentModel) {
      rig.remove(currentModel);
      currentModel = null;
    }
    return loadModel(url).then((source) => {
      if (disposed) return;
      const model = source.clone(true);
      // pivot wrapper: carries the character's own turn about its vertical
      // axis, applied before measuring so the framing accounts for it
      const pivot = new THREE.Group();
      pivot.add(model);
      pivot.rotation.y = modelYaw;
      currentModel = pivot;
      // freeze to a canonical pose before measuring: the rig spins continuously,
      // so a rotated bounding box reads a different (larger, diagonal) footprint
      // each time, making the fit distance -- and apparent size -- random.
      // matrixWorld only updates during render(), so force it or Box3 reads the
      // stale (still-rotated) transform from the previous frame
      rig.rotation.set(0, 0, 0);
      rig.add(pivot);
      rig.updateMatrixWorld(true);
      resize();
      measurement = measureObject(pivot);
      setFraming(modelDistanceScale, modelVerticalAnchor);
    });
  }

  // How far the character can be turned by the cursor, and how quickly it
  // chases the target. The cap is well short of the framing limit: the camera
  // distance was fitted to the silhouette measured at rest, so a far enough
  // turn presents a wider profile than was fitted for and clips at the
  // frustum edge.
  const YAW_LIMIT = 0.42;
  const YAW_CHASE = 0.16;
  let yawTarget = 0;
  let yawCurrent = 0;

  // Offset from the character's resting yaw, in radians, clamped. Driven by
  // the cursor rather than by a drag -- see the hover handling in main.js,
  // which decides whether the pointer is actually over the character.
  function setYawOffset(offset) {
    yawTarget = Math.max(-YAW_LIMIT, Math.min(YAW_LIMIT, offset));
    // the scenes are static and only redraw on demand, so the chase in tick()
    // has to be woken up or it will never run
    if (Math.abs(yawTarget - yawCurrent) > 0.0005) invalidate();
  }

  // the CSS size this viewer occupies on screen -- drives both the camera
  // aspect (so framing is identical to the old per-canvas renderer) and the
  // stage region we render into
  let cssWidth = 0;
  let cssHeight = 0;

  // Takes the size directly rather than reading it off the element, so callers
  // can drive it without forcing a layout read. renderScale below 1 renders
  // fewer pixels and lets the browser scale the bitmap up to the element's box
  // -- worth it while something is moving, where the softness is invisible.
  function setSize(width, height, nextRenderScale = renderScale) {
    if (!width || !height) return;
    renderScale = nextRenderScale;
    const nextWidth = width * renderScale;
    const nextHeight = height * renderScale;
    if (nextWidth === cssWidth && nextHeight === cssHeight) return;
    cssWidth = nextWidth;
    cssHeight = nextHeight;
    // the 2D canvas owns its own backing store now; match device pixels so the
    // blit lands 1:1 and nothing is resampled
    canvas.width = Math.round(cssWidth * pixelRatio);
    canvas.height = Math.round(cssHeight * pixelRatio);
    // aspect comes from the DISPLAYED box, which renderScale leaves unchanged
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    // the fit distance is derived from the aspect, so a resize has to re-frame
    // or the character keeps a fit computed for the old shape
    reframe();
    // Assigning canvas.width above WIPED the canvas. Draw again now, in this
    // same task, rather than flagging it and letting the render loop catch up
    // on its next rAF: a ResizeObserver fires after layout but before paint,
    // so a wipe left unpainted here reaches the compositor as an empty canvas
    // -- one frame with the character simply gone. That is exactly the flash
    // that showed at the start of every flight, where lifting the card's
    // canvas out and resizing it to the flight stage triggers a resize
    // notification inside the very frame the flight begins.
    render();
  }

  function resize() {
    setSize(canvas.clientWidth, canvas.clientHeight);
  }

  // contentRect is fractional; clientWidth/clientHeight are rounded to whole
  // pixels. The flight sizes this canvas from a union rect that is almost
  // never integral (1252.29px, say), so reading it back rounded reports a
  // "new" size on every single flight, and setSize reallocates -- and wipes --
  // a canvas that had not actually changed size at all. Reading the fractional
  // box means that comparison matches and the reallocation never happens.
  const resizeObserver = new ResizeObserver((entries) => {
    const box = entries[entries.length - 1]?.contentRect;
    if (box) setSize(box.width, box.height);
    else resize();
  });
  resizeObserver.observe(canvas);

  // onReady fires only on success. It is what the flight waits on before
  // handing the character over, so resolving it after a failed load would
  // hand the transition a permanently blank canvas.
  setModel(modelUrl).then(
    () => onReady?.(),
    (error) => {
      if (disposed) return;
      console.error(`[viewer] could not load ${modelUrl}`, error);
      onError?.(error);
    }
  );

  // Whether this canvas is anywhere near the screen. Drawing costs a readback
  // from the shared WebGL context into this canvas's own 2D context, and
  // profiling a cold load put two thirds of the main thread's time in exactly
  // that blit -- so a character sitting on the carousel's second page is
  // seconds of work for pixels nobody can see.
  //
  // Starts true: a viewer built for the flight, or for the detail view, is
  // wanted on screen immediately and must not wait for an observer callback
  // that arrives a frame later.
  // Measured synchronously, at the moment of drawing. An IntersectionObserver
  // alone cannot do this job: its callbacks are delivered asynchronously, so
  // during a burst of mounts -- precisely the case this exists to cut -- the
  // main thread is blocked and no observer entry can arrive until the work is
  // already done. Every viewer would still believe it was on screen and blit
  // anyway, which is exactly what the first attempt at this measured.
  //
  // A getBoundingClientRect per draw is a forced layout, and worth it: it is
  // orders of magnitude cheaper than the readback it prevents, and these
  // scenes only draw when something has actually changed.
  function isOnScreen() {
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    const pad = Math.max(window.innerWidth, window.innerHeight) * 0.5;
    return (
      r.bottom > -pad &&
      r.top < window.innerHeight + pad &&
      r.right > -pad &&
      r.left < window.innerWidth + pad
    );
  }

  // The observer is still worth keeping, for the other half of the problem:
  // noticing that a deferred canvas has come into view while nothing else is
  // invalidating it, and paying the draw then.
  const visibility = new IntersectionObserver(
    ([entry]) => {
      if (entry.isIntersecting && needsRender) render();
    },
    // Half a screen of runway, so a card is drawn before it is reached rather
    // than at the moment it arrives. Deliberately not a full screen: on a
    // phone the carousel's pitch IS one screen, so a full-screen margin would
    // sweep in the next card and defeat the whole point -- and a phone is
    // exactly where the saved work matters most.
    { rootMargin: "50%" }
  );
  visibility.observe(canvas);

  // Draws now rather than waiting for the loop's next frame. The flight needs
  // this: gsap's ticker and the render loop are separate rAF callbacks, so
  // relying on the loop leaves the canvas showing last frame's content.
  function render() {
    if (disposed) return;
    // Deliberately leaves needsRender set: this is deferred, not skipped, and
    // the observer above pays it the moment the canvas is worth drawing into.
    if (!isOnScreen()) return;
    needsRender = false;
    draw(scene, camera, canvas, cssWidth, cssHeight);
  }

  function tick(deltaSeconds) {
    if (disposed) return;
    if (spinSpeed) {
      rig.rotation.y += deltaSeconds * spinSpeed;
      needsRender = true;
    }
    // eased rather than set outright, so the turn follows the cursor with some
    // weight instead of snapping to it, and settles back when the cursor leaves
    if (Math.abs(yawTarget - yawCurrent) > 0.0005) {
      yawCurrent += (yawTarget - yawCurrent) * YAW_CHASE;
      rig.rotation.y = yawCurrent;
      needsRender = true;
    }
    if (!needsRender) return;
    render();
  }

  function dispose() {
    disposed = true;
    visibility.disconnect();
    resizeObserver.disconnect();
    // Nothing GPU-side to tear down: the context, its uploaded textures and
    // the environment map are the shared stage's and outlive this viewer --
    // that persistence is the entire point. Geometry and materials belong to
    // the cached source scene (clone(true) shares them), so disposing them
    // here would corrupt every other viewer of the same character.
    if (currentModel) {
      rig.remove(currentModel);
      currentModel = null;
    }
  }

  resize();

  return { tick, render, dispose, setModel, setFraming, setProjectedFraming, setSize, setYawOffset, canvas };
}

export function createRenderLoop() {
  const viewers = new Set();
  const clock = new THREE.Clock();
  let running = false;

  function frame() {
    if (!running) return;
    const delta = clock.getDelta();
    for (const viewer of viewers) viewer.tick(delta);
    requestAnimationFrame(frame);
  }

  return {
    add(viewer) {
      viewers.add(viewer);
      if (!running) {
        running = true;
        clock.start();
        requestAnimationFrame(frame);
      }
    },
    remove(viewer) {
      viewers.delete(viewer);
      viewer.dispose();
    },
  };
}
