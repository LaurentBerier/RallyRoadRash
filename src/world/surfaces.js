/* ============================================================
   SURFACE TABLE — the one place a surface means anything.
   ------------------------------------------------------------
   Physics reads grip/drag/sink, the terrain shader reads the same
   ids for albedo, dust reads the colours, audio reads skid. Pure
   data: importable from Node tests and from the browser alike.
   ============================================================ */
export const SURF = { ROAD: 0, DIRT: 1, SAND: 2, MUD: 3, ROCK: 4, GRASS: 5, LAVA: 6 };

export const SURFACES = [
  // grip multiplies tyre friction; drag is rolling resistance as a fraction of
  // load; sink scales rut depth; bump scales baked micro-roughness; dust/dustCol
  // drive particles; skid scales tyre-squeal loudness.
  { id: 0, name: 'ROAD',  grip: 1.00, drag: 0.006, sink: 0.00, bump: 0.15, dust: 0.15, dustCol: [0.55, 0.50, 0.44], skid: 0.9 },
  { id: 1, name: 'DIRT',  grip: 0.82, drag: 0.012, sink: 0.35, bump: 0.45, dust: 0.85, dustCol: [0.58, 0.46, 0.32], skid: 0.6 },
  { id: 2, name: 'SAND',  grip: 0.62, drag: 0.030, sink: 0.80, bump: 0.30, dust: 1.00, dustCol: [0.78, 0.66, 0.44], skid: 0.3 },
  { id: 3, name: 'MUD',   grip: 0.52, drag: 0.045, sink: 1.00, bump: 0.40, dust: 0.55, dustCol: [0.30, 0.22, 0.14], skid: 0.2 },
  { id: 4, name: 'ROCK',  grip: 0.92, drag: 0.008, sink: 0.00, bump: 0.90, dust: 0.35, dustCol: [0.45, 0.43, 0.41], skid: 0.8 },
  { id: 5, name: 'GRASS', grip: 0.68, drag: 0.025, sink: 0.25, bump: 0.55, dust: 0.40, dustCol: [0.35, 0.40, 0.22], skid: 0.3 },
  // LAVA is a hazard, and the only thing in this table that can express that is
  // the cost of being on it: low grip, high drag, and almost no squeal (you are
  // not sliding, you are wading). CALDERA RUN puts it beside the racing line and
  // in one fissure the second kicker clears. If damage-on-lava is wanted, race
  // logic should key off `surfaceAt() === SURF.LAVA` — the table has no field
  // for it and inventing one would break the contract.
  { id: 6, name: 'LAVA',  grip: 0.55, drag: 0.038, sink: 0.10, bump: 0.45, dust: 0.75, dustCol: [0.30, 0.11, 0.06], skid: 0.25 },
];
