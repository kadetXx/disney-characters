// model paths point at /public/models. These are runtime strings (not
// static imports) so Vite's asset pipeline leaves them alone -- BASE_URL is
// prepended by hand so they still resolve if this ever ships under a subpath.
const MODEL_BASE = import.meta.env.BASE_URL + "models/";

// Each character carries its own accent gradient (sampled from the design
// reference) plus a title tint a couple stops lighter than the gradient's
// own top color -- keeps every card readable without just being white text
// on every card.
//
// zoomAdjust and verticalAnchor are both tuned per character against the
// reference screenshots, since Meshy's bounding boxes vary a lot by pose:
// - zoomAdjust: multiplies the camera's fit distance. Below 1 = camera
//   closer = character reads bigger on its card. Rosetta/Judy/Moana are
//   drawn big and full-figure in the reference; Sadness/Disgust/Vanellope
//   are comparatively small, compact characters.
// - verticalAnchor: fraction of the character's own height to drop it by
//   after centering, so the feet land near the card's panel edge instead of
//   floating mid-canvas -- see frameObject() in three/viewer.js. Wide,
//   diagonal poses (Rosetta's flying pose) need a bigger drop to dip into
//   the panel the way the reference does; upright poses mostly just need
//   their feet to kiss the panel's top edge.
export const characters = [
  {
    id: "rosetta",
    name: "Rosetta",
    movie: "Tinkerbell",
    description:
      "A rose fairy with a flair for the dramatic, Rosetta spends her days coaxing color into every petal in Pixie Hollow -- and reminding anyone who'll listen that a garden fairy's job is the most important one there is.",
    model: MODEL_BASE + "rosetta.glb",
    gradient: ["#C2434D", "#B02D37", "#8F1F28"],
    titleTint: "#F6DCC0",
    zoomAdjust: 0.455,
    verticalAnchor: 0.381,
    panelRatio: 0.95,
    shiftX: -7,
    detailZoom: 1.25,
    detailShiftX: -3,
    detailShiftY: -3,
  },
  {
    id: "sadness",
    name: "Sadness",
    movie: "Inside Out",
    description:
      "Sadness is literally the very definition of sorrow and gloom. She is hardly ever used because Joy is the boss and doesn't want Riley to ever be sad, even when she needs to be. Because of this, Joy treats Sadness badly.",
    model: MODEL_BASE + "sadness.glb",
    gradient: ["#3A4E74", "#243A74", "#16264D"],
    titleTint: "#A9C6E8",
    zoomAdjust: 0.431,
    verticalAnchor: 0.614,
    panelRatio: 0.75,
    yawDeg: 25,
    detailZoom: 1.27,
    detailShiftY: -6,
    detailShiftX: 4,
  },
  {
    id: "disgust",
    name: "Disgust",
    movie: "Inside Out",
    description:
      "Disgust's job is to keep Riley from being poisoned -- physically and socially. Sharp-tongued and always unimpressed, she's the first to veto broccoli, bad fashion, and anything else beneath her standards.",
    model: MODEL_BASE + "disgust.glb",
    gradient: ["#7FA36E", "#4C7A3D", "#1C4029"],
    titleTint: "#D9EBB0",
    zoomAdjust: 0.579,
    verticalAnchor: 0.465,
    panelRatio: 0.86,
    detailZoom: 1.401,
    detailShiftY: -6,
    detailShiftX: 2,
  },
  {
    id: "judy",
    name: "Judy",
    movie: "Zootopia",
    description:
      "Judy Hopps left Bunnyburrow to become Zootopia's first rabbit police officer, determined to prove that anyone can be anything. Small, stubborn, and relentlessly optimistic, she takes on cases twice her size.",
    model: MODEL_BASE + "judy.glb",
    gradient: ["#4A5E82", "#2E4468", "#1B2A44"],
    titleTint: "#C7D4EA",
    zoomAdjust: 0.576,
    verticalAnchor: 0.33,
    panelRatio: 1.03,
    shiftX: -4,
    detailZoom: 1.19,
    detailShiftY: -8,
    detailShiftX: 2,
  },
  {
    id: "moana",
    name: "Moana",
    movie: "Moana",
    description:
      "The daughter of the chief of Motunui, Moana sets sail across the open ocean to save her island, guided only by the ocean itself and a demigod who owes her a favor.",
    model: MODEL_BASE + "moana.glb",
    gradient: ["#E0A883", "#C96A4C", "#A83F2C"],
    titleTint: "#FBE3C7",
    zoomAdjust: 0.598,
    verticalAnchor: 0.396,
    panelRatio: 1.1,
    detailZoom: 1.312,
    detailShiftY: -6,
    detailShiftX: 5,
  },
  {
    id: "vanellope",
    name: "Vanellope",
    movie: "Wreck-It Ralph",
    description:
      "A glitch in Sugar Rush with a mouth faster than her kart, Vanellope just wants to race -- and once Ralph's around to back her up, nobody in the arcade is going to tell her she can't.",
    model: MODEL_BASE + "vanellope.glb",
    gradient: ["#7FA08F", "#427B69", "#244A3D"],
    titleTint: "#D7ECD9",
    zoomAdjust: 0.59,
    verticalAnchor: 0.52,
    panelRatio: 0.71,
    shiftX: -9,
    detailZoom: 1.213,
    detailShiftY: -10,
    detailShiftX: 2,
  },
];

export function getCharacter(id) {
  return characters.find((c) => c.id === id);
}

export const defaultCharacterId = characters[0].id;
