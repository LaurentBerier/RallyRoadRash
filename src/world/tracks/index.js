/* ============================================================
   TRACK REGISTRY
   ------------------------------------------------------------
   Data only — no three, no DOM. Importable from Node tests.
   Order is the intended progression order; progression.js gates
   which of them the player has actually earned.
   ============================================================ */
import training from './training.js';
import canyon from './canyon.js';
import forest from './forest.js';
import volcano from './volcano.js';
import thunder from './thunder.js';

/* THUNDER PARK is `bonus: true`, so it is registered here but is NOT part of
   the campaign order — progression.js gates it behind a SUNSTRIKE CANYON
   podium (docs/ARCHITECTURE.md §6.10). TRACK_ORDER below is the campaign. */
export const TRACKS = [training, canyon, forest, volcano, thunder];

/** Campaign order. Bonus stages are deliberately absent. */
export const TRACK_ORDER = TRACKS.filter(t => !t.bonus).map(t => t.id);

/** Track definition by id, or undefined. */
export function getTrack(id) {
  for (let i = 0; i < TRACKS.length; i++) if (TRACKS[i].id === id) return TRACKS[i];
  return undefined;
}

/** Ids in progression order — handy for save schemas and the track-select UI. */
export const TRACK_IDS = TRACKS.map(t => t.id);

export default TRACKS;
