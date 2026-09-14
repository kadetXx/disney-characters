import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

const loader = new GLTFLoader();
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

function loadModel(url) {
  if (!modelCache.has(url)) {
    modelCache.set(
      url,
      loader.loadAsync(url).then((gltf) => {
        applyGloss(gltf.scene);
        return gltf.scene;
      })
    );
  }
  return modelCache.get(url);
}

function frameObject(pivot, camera, distanceScale, verticalAnchor = 0) {
  // measure AFTER any rotation has been applied to the pivot, so the fit is
  // computed against the silhouette actually being rendered rather than the
  // untwisted one (a turned character presents a different width/height).
  const box = new THREE.Box3().setFromObject(pivot);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  // move the pivot (not the model) so the measured centre lands on the origin
  pivot.position.sub(center);

  // fit both extents, not just height, or a wide object looks tiny on a wide canvas
  const verticalFov = (camera.fov * Math.PI) / 180;
  const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * camera.aspect);

  const distanceForHeight = size.y / 2 / Math.tan(verticalFov / 2);
  const distanceForWidth = size.x / 2 / Math.tan(horizontalFov / 2);
  let fitDistance = Math.max(distanceForHeight, distanceForWidth, size.z) || 1;

  // the tight fit above touches the frame on all sides with zero margin, so
  // shifting the object down by verticalAnchor afterward would push its feet
  // straight through the bottom of the frustum. Pull the camera back first
  // (in proportion to the shift) to open up exactly enough headroom.
  fitDistance *= 1 + 2 * Math.abs(verticalAnchor);

  camera.position.set(0, 0, fitDistance * distanceScale);
  camera.near = fitDistance / 100;
  camera.far = fitDistance * 100;
  camera.updateProjectionMatrix();

  // the camera looks straight down -Z with no roll, so shifting in world Y is a
  // pure screen-space pan -- this lets the canvas be much taller than the
  // character and still anchor its feet low instead of centring it in all that
  // room, leaving headroom above for tall poses to protrude into.
  pivot.position.y -= verticalAnchor * size.y;
}

export function createViewer(canvas, { modelUrl, distanceScale = 1.6, verticalAnchor = 0, yaw = 0, rimColor = 0xffa93e, spinSpeed = 0.25, interactive = false, preserveDrawingBuffer = false, onReady }) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
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

  const scene = new THREE.Scene();
  // gloss needs something to reflect. Generated per viewer rather than shared:
  // a PMREM texture belongs to the WebGL context that produced it, and each
  // viewer owns its own renderer.
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
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
  // the scenes are static (spin is off), so redraw only when something
  // actually changes rather than re-rendering all seven viewers every frame
  let needsRender = true;
  const invalidate = () => { needsRender = true; };

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
      frameObject(pivot, camera, modelDistanceScale, modelVerticalAnchor);
      invalidate();
    });
  }

  let autoRotatePaused = false;
  let resumeTimer = null;
  let dragCleanup = null;

  if (interactive) {
    const ROTATE_SPEED = 0.008;
    // capped well short of the theoretical framing limit: past this, a
    // rotated model's silhouette can grow past what the camera fit for at
    // rest and get clipped by the frustum edge (verified empirically per weapon)
    const PITCH_LIMIT = 0.45;
    const RESUME_DELAY = 1500;
    let dragging = false;
    let lastX = 0;
    let lastY = 0;

    const onPointerDown = (event) => {
      dragging = true;
      autoRotatePaused = true;
      clearTimeout(resumeTimer);
      lastX = event.clientX;
      lastY = event.clientY;
      canvas.style.cursor = "grabbing";
      canvas.setPointerCapture(event.pointerId);
    };
    const onPointerMove = (event) => {
      if (!dragging) return;
      const dx = event.clientX - lastX;
      const dy = event.clientY - lastY;
      lastX = event.clientX;
      lastY = event.clientY;
      rig.rotation.y += dx * ROTATE_SPEED;
      rig.rotation.x = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, rig.rotation.x + dy * ROTATE_SPEED));
      invalidate();
    };
    const onPointerUp = (event) => {
      if (!dragging) return;
      dragging = false;
      canvas.style.cursor = "grab";
      if (canvas.hasPointerCapture?.(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      resumeTimer = setTimeout(() => {
        autoRotatePaused = false;
      }, RESUME_DELAY);
    };

    canvas.style.cursor = "grab";
    canvas.style.touchAction = "none";
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);

    dragCleanup = () => {
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
    };
  }

  function resize() {
    const { clientWidth, clientHeight } = canvas;
    if (!clientWidth || !clientHeight) return;
    renderer.setSize(clientWidth, clientHeight, false);
    camera.aspect = clientWidth / clientHeight;
    camera.updateProjectionMatrix();
    invalidate();
  }

  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(canvas);

  setModel(modelUrl).then(() => onReady?.());

  function tick(deltaSeconds) {
    if (disposed) return;
    if (spinSpeed && !autoRotatePaused) {
      rig.rotation.y += deltaSeconds * spinSpeed;
      needsRender = true;
    }
    if (!needsRender) return;
    needsRender = false;
    renderer.render(scene, camera);
  }

  function dispose() {
    disposed = true;
    clearTimeout(resumeTimer);
    dragCleanup?.();
    resizeObserver.disconnect();
    renderer.dispose();
    // dispose() alone doesn't free the actual WebGL context, so repeated
    // create/destroy cycles hit the browser's context limit and go blank
    renderer.forceContextLoss();
  }

  resize();

  return { tick, dispose, setModel, canvas };
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
