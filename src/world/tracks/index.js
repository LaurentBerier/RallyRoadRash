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

export const TRACKS = [training, canyon, forest, volcano];

/** Track definition by id, or undefined. */
export function getTrack(id) {
  for (let i = 0; i < TRACKS.length; i++) if (TRACKS[i].id === id) return TRACKS[i];
  return undefined;
}

/** Ids in progression order — handy for save schemas and the track-select UI. */
export const TRACK_IDS = TRACKS.map(t => t.id);

export default TRACKS;
