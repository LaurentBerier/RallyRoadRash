/* ============================================================
   RALLY ROAD RASH — carcass fit tables
   ------------------------------------------------------------
   Pure data and pure arithmetic, no three: this is the one description of
   how a generated GLB is dropped onto a spec, and it is read by TWO callers
   that must never disagree — vehicle-carcass.js, which fits and strips the
   mesh in the browser, and dev/model-check.mjs, which parses the same bytes
   in Node and gates that nothing wheel-shaped survives. If the rule lived in
   the three-side module the check could not import it.

   WHAT A GENERATED CARCASS LOOKS LIKE. The image model draws wheels on a car
   you told it not to, the mesh model fuses everything into one node, and
   the long axis comes out along X with the nose at either end — measured,
   never assumed (dev/tmp has the probe). So every entry here is a record of
   measurements in MODEL UNITS, and the fit derives everything else:

     yaw     radians about +Y that put the nose on +Z
     axles   long-axis coordinate of the front and rear wheel contact
             clusters. The scale is chosen so these land on the spec's
             axles — the tyres the game draws must sit in the arches the
             mesh has, and "length = dims.L" alone puts them a wheel radius
             off on a long-nosed truck. Clamped to ±15 % of the length rule.
     lat     [inner, outer] lateral extent of the tyres, for the strip
     wheelR  tyre radius, from the chord profile of the contact clusters
     dy/dz   metres, body space, after everything above
     tint    GLB material names the livery hue multiplies; empty = all
     flame   {x,y,z} body-space home for the pipe flare, or null to keep the
             procedural one
     strip   {r} multiplier on the strip radius (default STRIP_R)
     lamps   {head:{dx,dy,dz}, brake:{dx,dy,dz}} — DELTAS, like `flame` is not:
             a carcass has its own lamp surfaces, so the procedural discs are
             hidden and only the bloom sprites survive, moved by this much so
             the light lands on the painted lamp instead of in mid-air
     launcher {dx,dy,dz} delta on the arsenal rig, for the very common case
             that the carcass's roof or deck is not where the procedural one
             was and the tubes end up buried in it
     keepLamps  true = this machine's lamps stay exactly where the procedural
             body put them, discs and all. The escape hatch for a carcass
             whose lamp positions could not be MEASURED (see below): a wrong
             number moves a headlight onto a mudguard, and that is worse than
             a carcass wearing the procedural lamps it was always wearing.

   HOW THE LAMP DELTAS WERE DERIVED. Not by eye — there is no eye in a Node
   check, and the browser is the lead's. dev/tmp/lamp-probe.mjs parses the GLB
   the way dev/model-check.mjs does, runs the same carcassFit + wheelZones,
   and reports, for the front and rear tenth of the STRIPPED body: the z of
   the frontmost/rearmost surviving skin, and a triangle-count histogram of
   its height in the outer lateral band. `dz` puts the bloom 4 cm proud of
   that face. `dy` is the histogram's modal band — the broadest surface at
   that end of the car, which is usually the lit fascia rather than a cage
   tube or a splitter lip. Twice it is not, and both are argued at the entry:
   the REDLINE nose, whose mode is the splitter lip, takes the band midpoint;
   the HOPPER tail, whose histogram is a sill and a roll cage with a metre of
   fresh air between them, takes no correction in y at all.
   `dx` is zero everywhere: one delta serves both sides of a
   symmetric pair, so a lateral term would break the symmetry it was meant to
   fix. The launcher `dy` is the top of the carcass's own deck in a ±0.28 ×
   ±0.32 m window under the mount.
   Every one of these still wants eyeballing in
   dev/garage.html?veh=<id>&model=1&ang=0|90|180|270.

   Units in the fit result are metres, body space: origin at the centre of
   mass, +Z forward, right is −X, ground at y = −comHeight.
   ============================================================ */

/** Strip radius over the measured tyre radius. Just over one: the tyre's
    tread ring has to go and the arch lip just outside it has to stay. */
const STRIP_R = 1.06;
/** How far outside the length rule the axle rule may pull the scale. */
const SCALE_SLACK = 0.15;
/** The width the length rule may reach before it is clamped — a carcass
    carries its (later stripped) wheels in its bounding box. */
const WIDTH_SLACK = 1.30;
/** The mesh's lowest point sits this far above the ground plane. */
const GROUND_LIFT = 0.02;

export const MODEL_FIT = {
  /* bbox 1.897 × 0.831 × 1.256 (X×Y×Z), 6,149 tris, nose at −X. Wheel
     clusters at x −0.71 / +0.62, z ±0.40..0.61, contact at y −0.474. */
  hopper: {
    yaw: Math.PI / 2,
    axles: { front: -0.710, rear: 0.620 }, lat: [0.400, 0.612], wheelR: 0.245,
    dy: 0, dz: 0, tint: [], flame: null,
    /* Nose skin ends at z 1.805 (the procedural bloom floated 11 cm past it)
       and its broadest band sits at y 0.19–0.22, which is 0.70 m over the
       ground — within a centimetre of where buildBuggy puts the LED brows.
       The tail is the odd one: the outer corners carry a thin sill at
       y −0.07..0.07 and then nothing at all until the cage at 0.85+, so
       there is no band that says "tail light". The procedural height already
       lands on the sill, so it stays and only z moves in to the tailgate. */
    lamps: {
      head: { dx: 0, dy: 0.13, dz: -0.07 },
      brake: { dx: 0, dy: 0, dz: 0.04 },
    },
    // the cage roof is 23 cm above the procedural one; without this the
    // launcher's tubes come out of the middle of the roof panel
    launcher: { dx: 0, dy: 0.23, dz: 0 },
  },
  /* Regenerated Ridgeback: bbox 1.899 × 0.655 × 0.733, 6,992 tris.
     Nose at −X; wheel contact clusters measured at −0.609 / +0.506.
     Strip the narrower baked wheels before adding the live running gear. */
  ridgeback: {
    yaw: Math.PI / 2,
    axles: { front: -0.609, rear: 0.506 }, lat: [0.190, 0.370], wheelR: 0.175,
    dy: 0, dz: 0, tint: [],
    // the bed runs 0.24 m past the procedural tail, so the flare moves back
    flame: { x: 0, y: -0.08, z: -2.85 },
    /* The longest carcass of the four: the nose reaches z 2.550 against the
       procedural 2.024 and the tailgate −2.724 against −2.254, so both blooms
       were half a metre INSIDE the bodywork. Heights are the modal bands —
       0.37–0.43 at the nose (0.98 m over the ground, a truck headlamp) and
       0.30–0.36 at the tail (0.88 m, the bed side). The same head delta also
       carries the roof-bar bloom to (0, 1.38, 1.72), which is 4 cm under this
       carcass's own roofline at 1.417 — checked, because one delta moves
       every head glow on the machine. */
    lamps: {
      head: { dx: 0, dy: 0.24, dz: 0.52 },
      brake: { dx: 0, dy: 0.17, dz: -0.46 },
    },
    launcher: { dx: 0, dy: 0.16, dz: 0 },       // regenerated cab roof, lower mount
  },
  /* bbox 1.895 × 0.562 × 0.841, 7,229 tris, nose at −X with the wing at +X.
     Wheels at x −0.507 / +0.570, z ±0.22..0.41, and bigger than the spec's
     (0.17 model = 0.44 m against 0.37). */
  redline: {
    yaw: Math.PI / 2,
    axles: { front: -0.507, rear: 0.570 }, lat: [0.217, 0.412], wheelR: 0.170,
    dy: 0, dz: 0, tint: [],
    // the tail sits 7 cm behind the procedural one; the flare clears it
    flame: { x: 0, y: -0.14, z: -2.55 },
    /* Nose z 2.558 against the procedural 2.111. The nose histogram is the
       one that argues with itself — its biggest single band is the splitter
       lip at y −0.17, which is 0.27 m over the ground and would put the
       headlights under the bumper, so the head height is the band MIDPOINT
       (0.556 m over the ground) rather than its mode. The tail takes its
       mode, 0.08–0.15, which is 0.55 m up on the panel under the wing. */
    lamps: {
      head: { dx: 0, dy: 0.12, dz: 0.49 },
      brake: { dx: 0, dy: 0.12, dz: -0.24 },
    },
    // rear deck at 0.60, not the 0.85 the raw window maximum reports — that
    // is two triangles of wing edge, and the deck under it is the mount
    launcher: { dx: 0, dy: 0.26, dz: 0 },
  },
  /* bbox 1.895 × 1.669 × 0.808, 5,592 tris, and this one faces +X: the bars
     and the rider's lean are at +X. Wheels at x +0.618 / −0.641 on the
     centreline (z ±0.06), r 0.33 — a 21-inch front measured, not guessed. */
  moto: {
    yaw: -Math.PI / 2,
    axles: { front: 0.618, rear: -0.641 }, lat: [0.0, 0.062], wheelR: 0.330,
    dy: 0, dz: 0, tint: [], flame: null, strip: { r: 1.06 },
    /* THE HONEST FALLBACK. Strip a bike's wheels and almost nothing is left
       at either end: 13 triangles at the nose and 8 at the tail, and they are
       the mudguard tips, 0.93 m over the ground where the headlight belongs
       at 1.22. Take the measurement and the light moves onto the front
       fender. There is no deck under the side rack either — the ±0.28 m
       window round the mount is 1000 triangles of rider from the peg to the
       helmet, so the launcher stays where the spec bolted it. */
    keepLamps: true,
  },
};

/**
 * The transform that drops a model onto a spec.
 *
 *   body = R_y(yaw) · (s · model) + (x, y, z)
 *
 * @param {object} spec   one of VEHICLES
 * @param {string} id     spec.id, keys MODEL_FIT
 * @param {object} raw    { min:[x,y,z], max:[x,y,z] } of the WHOLE model in
 *                        model units, wheels and all
 * @returns {{yaw, s, x, y, z, c, sn, bottom}}  `c`/`sn` are cos/sin(yaw),
 *          `bottom` the body-space y of the model's lowest point
 */
export function carcassFit(spec, id, raw) {
  const F = MODEL_FIT[id] || {};
  const size = [raw.max[0] - raw.min[0], raw.max[1] - raw.min[1], raw.max[2] - raw.min[2]];
  const yaw = F.yaw != null ? F.yaw : (size[0] >= size[2] ? Math.PI / 2 : 0);
  const c = Math.cos(yaw), sn = Math.sin(yaw);
  const alongX = Math.abs(sn) > Math.abs(c);     // model X becomes body ±Z
  const len = alongX ? size[0] : size[2], wid = alongX ? size[2] : size[0];
  const { L, W } = spec.dims;
  const sLen = Math.min(L / Math.max(len, 1e-6), W * WIDTH_SLACK / Math.max(wid, 1e-6));
  let s = sLen;
  if (F.axles) {
    const wb = Math.abs(F.axles.front - F.axles.rear);
    if (wb > 1e-6) {
      const sWb = (spec.wheelbase.front - spec.wheelbase.rear) / wb;
      s = Math.min(sLen * (1 + SCALE_SLACK), Math.max(sLen * (1 - SCALE_SLACK), sWb));
    }
  }
  s *= F.scale != null ? F.scale : 1;

  /* Anchor: the axle midpoint lands on the spec's axle midpoint when the
     axles are known, else the box centre lands on the origin. */
  let mx = (raw.min[0] + raw.max[0]) * 0.5, mz = (raw.min[2] + raw.max[2]) * 0.5;
  let targetZ = 0;
  if (F.axles) {
    const mid = (F.axles.front + F.axles.rear) * 0.5;
    if (alongX) mx = mid; else mz = mid;
    targetZ = (spec.wheelbase.front + spec.wheelbase.rear) * 0.5;
  }
  const ax = (mx * c + mz * sn) * s, az = (-mx * sn + mz * c) * s;
  const bottom = -spec.comHeight + GROUND_LIFT + (F.dy || 0);
  return {
    yaw, s, c, sn, bottom,
    x: -ax + (F.dx || 0),
    y: bottom - raw.min[1] * s,
    z: targetZ - az + (F.dz || 0),
  };
}

/** Model point → body space, into `out` (an array or Vector3-like). */
export function toBody(fit, px, py, pz, out) {
  const sx = px * fit.s, sz = pz * fit.s;
  out.x = sx * fit.c + sz * fit.sn + fit.x;
  out.y = py * fit.s + fit.y;
  out.z = -sx * fit.sn + sz * fit.c + fit.z;
  return out;
}

/**
 * The wheel cylinders to strip, body space. One per corner for a car, one
 * per axle on the centreline for a bike. `r` is the strip radius, `y`/`z`
 * the hub, and the lateral test is a band: `xIn ≤ |x| ≤ xOut` on the wheel's
 * own side (`side` ±1), or `|x| ≤ xOut` when `side` is 0.
 */
export function wheelZones(spec, id, fit) {
  const F = MODEL_FIT[id] || {};
  const bike = spec.bodyStyle === 'bike';
  const k = (F.strip && F.strip.r) || STRIP_R;
  const zones = [];
  let zF, zR, r, xIn, xOut, hubY;
  if (F.axles && F.wheelR) {
    const alongX = Math.abs(fit.sn) > Math.abs(fit.c);
    const zOf = (l) => alongX ? (-l * fit.sn) * fit.s + fit.z : (l * fit.c) * fit.s + fit.z;
    zF = zOf(F.axles.front); zR = zOf(F.axles.rear);
    r = F.wheelR * fit.s * k;
    hubY = fit.bottom + F.wheelR * fit.s;
    xIn = Math.max(0, (F.lat ? F.lat[0] : 0) * fit.s - 0.03);
    xOut = (F.lat ? F.lat[1] : spec.track + spec.wheelW) * fit.s + 0.08;
  } else {
    // unmeasured model: trust the spec, and be generous with the radius
    zF = spec.wheelbase.front; zR = spec.wheelbase.rear;
    r = spec.wheelR * k;
    hubY = fit.bottom + spec.wheelR;
    xIn = bike ? 0 : spec.track - spec.wheelW * 0.7;
    xOut = bike ? spec.wheelW * 1.2 : spec.track + spec.wheelW * 1.2;
  }
  for (const z of [zF, zR]) {
    if (bike) zones.push({ side: 0, xIn: 0, xOut, y: hubY, z, r });
    else for (const side of [-1, 1]) zones.push({ side, xIn, xOut, y: hubY, z, r });
  }
  return zones;
}

/** Is a body-space point inside any wheel zone? Allocation-free. */
export function inWheelZone(zones, x, y, z) {
  for (let i = 0; i < zones.length; i++) {
    const w = zones[i];
    if (w.side !== 0) {
      if (x * w.side <= 0) continue;
      const ax = x < 0 ? -x : x;
      if (ax < w.xIn || ax > w.xOut) continue;
    } else if ((x < 0 ? -x : x) > w.xOut) continue;
    const dy = y - w.y, dz = z - w.z;
    if (dy * dy + dz * dz <= w.r * w.r) return true;
  }
  return false;
}
