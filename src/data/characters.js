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
const MOVIE_BASE = import.meta.env.BASE_URL + "movies/";

// Artwork is keyed by MOVIE, not by character: Sadness and Disgust are both
// Inside Out, and should share one rather than carrying duplicates.
//
// Clips are YouTube trailers, played in place. Only the 11-character video id
// is stored: the poster is YouTube's own thumbnail for it, so there is no
// artwork to source, host or keep in sync with the video -- change the id and
// the still changes with it.
//
// Every id below was verified rather than trusted: oEmbed resolves it, and the
// watch page reports playableInEmbed:true. That second check is the one that
// matters and is easy to skip -- six otherwise-perfect candidates, including
// the top "official" hit for Inside Out, Zootopia and the Ralph/Vanellope
// clip, resolve fine but refuse to embed, and would have been three silently
// dead cards. If you swap an id, re-run both checks.
// maxresdefault is 1280x720 and mqdefault 320x180 -- both true 16:9, so they
// fill the card without bars. hqdefault, the obvious choice, is 480x360: a 4:3
// frame with the letterboxing baked into the pixels.
//
// maxres does not exist for every video (2 of the 15 below), and YouTube
// answers a missing one with a 120x90 grey placeholder rather than a clean
// error -- so the fallback is chosen on the loaded image's SIZE, not on an
// error event. See buildClips.
const YT_THUMB = (id) => `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`;
const YT_THUMB_FALLBACK = (id) => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;

// logoFile is spelled out rather than derived, because the real logos arrive
// in whatever format they were found in -- webp, png, svg -- and there is no
// reason to re-encode them just to satisfy a naming rule.
function movieAssets(slug, logoFile, logoScale, youtubeIds) {
  return {
    // how much bigger than the slot this particular logo wants to be drawn.
    // Tuned per movie by eye -- a wordmark reads at 1, a lockup carrying a
    // studio mark needs more before the small type resolves.
    logoScale,
    // one logo per movie. Wider than tall, transparent, and light enough to
    // read, because the panel behind it is always a dark character gradient.
    logo: MOVIE_BASE + logoFile,
    clips: youtubeIds.map((youtubeId) => ({
      youtubeId,
      poster: YT_THUMB(youtubeId),
      posterFallback: YT_THUMB_FALLBACK(youtubeId),
    })),
  };
}

export const movies = {
  "Tinkerbell": movieAssets("tinkerbell", "tinkerbell-logo.png", 1.5, [
    "B2DRnfYqBL8", // Secret of the Wings -- Disney UK
    "Et4zsoUNb_0", // The Pirate Fairy -- Disney UK
    "5ztzhchMcsY", // The Great Fairy Rescue -- Disney UK
  ]),
  "Inside Out": movieAssets("inside-out", "inside-out-logo.png", 1.3, [
    // The emotions are drawn emissive -- Joy is literally a light source -- so
    // on a darkened, graded card their rim light becomes the brightest thing in
    // the row and pulls the eye. Frames are picked for low blown-out highlights
    // rather than by scene: measuring the share of pixels above 235 separates
    // them cleanly (8.8% for Joy at Long Term Memory, 0.4% for these two).
    "8XInTTCydDQ", // four emotions at the console -- moving house
    "aOE92_DnZ_0", // Disgust at the console
    "nEUzQ7yL9A0", // Get To Know Your Emotions
  ]),
  "Zootopia": movieAssets("zootopia", "zootopia-logo.png", 1.4, [
    "Vsjghjdt7GY", // "Judy Hopps Leaves the Carrot Farm" clip -- Disney
    "AB1BxqB8kxA", // Flash the sloth at the DMV
    "w9rAB4UTtlQ", // Night Howlers scene
  ]),
  "Moana": movieAssets("moana", "moana-logo.png", 1.8, [
    "wkAQAV1jBTs", // "The Ocean Insists" scene
    "x6WlZbeaNHE", // Trailer 2
    "zjHYnmH4GbE", // "You're Welcome" song scene
  ]),
  "Wreck-It Ralph": movieAssets("wreck-it-ralph", "wreck-it-ralph-logo.webp", 1.3, [
    "2EFey5M_G8A", // Ralph meets Vanellope
    "0dEFNCCVDos", // Ralph and Vanellope make a deal
    "VFHixDtU0to", // Vanellope in Sugar Rush
  ]),
};

export function getMovie(title) {
  return movies[title] ?? movies["Inside Out"];
}

export const characters = [
  {
    id: "rosetta",
    // px to lift this character on its card on mobile, so its lowest point
    // clears the name by the same amount as everyone else. Rosetta\'s trailing
    // foot overlapped the title by 11px; Judy floated 39px clear of it.
    cardNudge: -39,
    // px to drop this character so its feet land on the panel\'s top edge
    // on mobile. Measured per character: the framing that suits each pose on
    // desktop leaves the feet anywhere from 14px below that edge to 33px above
    // it, and on a phone the panel edge is the ground they stand on.
    mobileNudge: -23,
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
    shiftX: -9,
    detailZoom: 1.313,
    detailShiftX: -3,
    detailShiftY: -5.0,
  },
  {
    id: "sadness",
    // px to lift this character on its card on mobile, so its lowest point
    // clears the name by the same amount as everyone else. Rosetta\'s trailing
    // foot overlapped the title by 11px; Judy floated 39px clear of it.
    cardNudge: -23,
    // px to drop this character so its feet land on the panel\'s top edge
    // on mobile. Measured per character: the framing that suits each pose on
    // desktop leaves the feet anywhere from 14px below that edge to 33px above
    // it, and on a phone the panel edge is the ground they stand on.
    mobileNudge: -13,
    name: "Sadness",
    movie: "Inside Out",
    description:
      "Sadness is literally the very definition of sorrow and gloom. She is hardly ever used because Joy is the boss and doesn't want Riley to ever be sad, even when she needs to be. Because of this, Joy treats Sadness badly.",
    model: MODEL_BASE + "sadness.glb",
    gradient: ["#3A4E74", "#243A74", "#16264D"],
    titleTint: "#A9C6E8",
    zoomAdjust: 0.408,
    verticalAnchor: 0.542,
    panelRatio: 0.75,
    yawDeg: 25,
    detailZoom: 1.27,
    detailShiftY: -6,
    detailShiftX: 4,
    shiftX: -4,
  },
  {
    id: "disgust",
    // px to lift this character on its card on mobile, so its lowest point
    // clears the name by the same amount as everyone else. Rosetta\'s trailing
    // foot overlapped the title by 11px; Judy floated 39px clear of it.
    cardNudge: -1,
    // px to drop this character so its feet land on the panel\'s top edge
    // on mobile. Measured per character: the framing that suits each pose on
    // desktop leaves the feet anywhere from 14px below that edge to 33px above
    // it, and on a phone the panel edge is the ground they stand on.
    mobileNudge: -13,
    name: "Disgust",
    movie: "Inside Out",
    description:
      "Disgust's job is to keep Riley from being poisoned -- physically and socially. Sharp-tongued and always unimpressed, she's the first to veto broccoli, bad fashion, and anything else beneath her standards.",
    model: MODEL_BASE + "disgust.glb",
    gradient: ["#7FA36E", "#4C7A3D", "#1C4029"],
    titleTint: "#D9EBB0",
    zoomAdjust: 0.609,
    verticalAnchor: 0.469,
    panelRatio: 0.86,
    detailZoom: 1.401,
    detailShiftY: -6,
    detailShiftX: 2,
    shiftX: -3,
  },
  {
    id: "judy",
    // px to lift this character on its card on mobile, so its lowest point
    // clears the name by the same amount as everyone else. Rosetta\'s trailing
    // foot overlapped the title by 11px; Judy floated 39px clear of it.
    cardNudge: 11,
    // px to drop this character so its feet land on the panel\'s top edge
    // on mobile. Measured per character: the framing that suits each pose on
    // desktop leaves the feet anywhere from 14px below that edge to 33px above
    // it, and on a phone the panel edge is the ground they stand on.
    mobileNudge: -11,
    name: "Judy",
    movie: "Zootopia",
    description:
      "Judy Hopps left Bunnyburrow to become Zootopia's first rabbit police officer, determined to prove that anyone can be anything. Small, stubborn, and relentlessly optimistic, she takes on cases twice her size.",
    model: MODEL_BASE + "judy.glb",
    gradient: ["#4A5E82", "#2E4468", "#1B2A44"],
    titleTint: "#C7D4EA",
    zoomAdjust: 0.638,
    verticalAnchor: 0.22,
    panelRatio: 1.03,
    shiftX: -5,
    detailZoom: 1.25,
    detailShiftY: -7.0,
    detailShiftX: 2,
  },
  {
    id: "moana",
    // px to lift this character on its card on mobile, so its lowest point
    // clears the name by the same amount as everyone else. Rosetta\'s trailing
    // foot overlapped the title by 11px; Judy floated 39px clear of it.
    cardNudge: -4,
    // px to drop this character so its feet land on the panel\'s top edge
    // on mobile. Measured per character: the framing that suits each pose on
    // desktop leaves the feet anywhere from 14px below that edge to 33px above
    // it, and on a phone the panel edge is the ground they stand on.
    mobileNudge: -34,
    name: "Moana",
    movie: "Moana",
    description:
      "The daughter of the chief of Motunui, Moana sets sail across the open ocean to save her island, guided only by the ocean itself and a demigod who owes her a favor.",
    model: MODEL_BASE + "moana.glb",
    gradient: ["#E0A883", "#C96A4C", "#A83F2C"],
    titleTint: "#FBE3C7",
    zoomAdjust: 0.611,
    verticalAnchor: 0.286,
    panelRatio: 1.1,
    detailZoom: 1.378,
    detailShiftY: -3.6,
    detailShiftX: 5,
    shiftX: -6,
  },
  {
    id: "vanellope",
    // px to lift this character on its card on mobile, so its lowest point
    // clears the name by the same amount as everyone else. Rosetta\'s trailing
    // foot overlapped the title by 11px; Judy floated 39px clear of it.
    cardNudge: -1,
    // px to drop this character so its feet land on the panel\'s top edge
    // on mobile. Measured per character: the framing that suits each pose on
    // desktop leaves the feet anywhere from 14px below that edge to 33px above
    // it, and on a phone the panel edge is the ground they stand on.
    mobileNudge: 13,
    name: "Vanellope",
    movie: "Wreck-It Ralph",
    description:
      "A glitch in Sugar Rush with a mouth faster than her kart, Vanellope just wants to race -- and once Ralph's around to back her up, nobody in the arcade is going to tell her she can't.",
    model: MODEL_BASE + "vanellope.glb",
    gradient: ["#7FA08F", "#427B69", "#244A3D"],
    titleTint: "#D7ECD9",
    zoomAdjust: 0.613,
    verticalAnchor: 0.572,
    panelRatio: 0.71,
    shiftX: -9,
    detailZoom: 1.334,
    detailShiftY: -10,
    detailShiftX: 2,
  },
];

export function getCharacter(id) {
  return characters.find((c) => c.id === id);
}

export const defaultCharacterId = characters[0].id;
