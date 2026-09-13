import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";

const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);

const modelCache = new Map();

function loadModel(url) {
  if (!modelCache.has(url)) {
    modelCache.set(
      url,
      loader.loadAsync(url).then((gltf) => gltf.scene)
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

export function createViewer(canvas, { modelUrl, distanceScale = 1.6, verticalAnchor = 0, yaw = 0, spinSpeed = 0.25, interactive = false, preserveDrawingBuffer = false, onReady }) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);

  scene.add(new THREE.AmbientLight(0xffffff, 1.1));
  const key = new THREE.DirectionalLight(0xfff2d9, 2.4);
  key.position.set(3, 4, 5);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xffa93e, 1.1);
  rim.position.set(-4, -2, -3);
  scene.add(rim);

  const rig = new THREE.Group();
  scene.add(rig);

  let disposed = false;
  let currentModel = null;

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
  }

  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(canvas);

  setModel(modelUrl).then(() => onReady?.());

  function tick(deltaSeconds) {
    if (disposed) return;
    if (!autoRotatePaused) rig.rotation.y += deltaSeconds * spinSpeed;
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
