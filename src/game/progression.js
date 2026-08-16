/* ============================================================
   RALLY ROAD RASH — PROGRESSION
   ------------------------------------------------------------
   Unlocks, medals and records. PURE: zero imports, no localStorage, no DOM.
   It takes a plain profile object in and hands a new one back; core/save.js
   is the only thing that knows where profiles live.

   Why the names are duplicated here rather than imported from
   tracks/index.js: this module has to stay loadable in a bare Node test with
   nothing else on the import graph, and the strings it produces are UI copy
   ("Podium at SUNSTRIKE CANYON"), not track data. The table below is the
   only place they appear; if a track is renamed, it is renamed twice, and
   dev/racecore-check.mjs will not notice — that is the accepted cost.

   THE CHAIN
     PROVING GROUNDS   finish, any placement  ->  SUNSTRIKE CANYON  (+ tutorial done)
     SUNSTRIKE CANYON  podium (top 3)         ->  TIMBERLINE CLIMB  + RIDGEBACK
     TIMBERLINE CLIMB  podium (top 3)         ->  CALDERA RUN       + REDLINE
     CALDERA RUN       win                    ->  CHAMPION
   ============================================================ */

export const PROFILE_VERSION = 1;

/** Progression order. Index is also the championship order the UI walks. */
export const TRACK_ORDER = ['training', 'canyon', 'forest', 'volcano'];
export const VEHICLE_ORDER = ['hopper', 'ridgeback', 'redline'];

const TRACK_NAME = {
  training: 'PROVING GROUNDS',
  canyon: 'SUNSTRIKE CANYON',
  forest: 'TIMBERLINE CLIMB',
  volcano: 'CALDERA RUN'
};
const VEHICLE_NAME = {
  hopper: 'DUNE HOPPER',
  ridgeback: 'RIDGEBACK',
  redline: 'REDLINE'
};

/* What each locked thing is waiting for. `podium` means placement <= 3. */
const REQUIREMENT = {
  canyon: { track: 'training', podium: false },
  forest: { track: 'canyon', podium: true },
  volcano: { track: 'forest', podium: true },
  ridgeback: { track: 'canyon', podium: true },
  redline: { track: 'forest', podium: true }
};

/** Everything a track win at `trackId` opens up. */
const REWARDS = {
  training: { tracks: ['canyon'], vehicles: [], podium: false },
  canyon: { tracks: ['forest'], vehicles: ['ridgeback'], podium: true },
  forest: { tracks: ['volcano'], vehicles: ['redline'], podium: true },
  volcano: { tracks: [], vehicles: [], podium: true, winOnly: true }
};

export const CHAMPION_BANNER = 'CHAMPION OF THE CALDERA';

const MEDALS = [null, 'gold', 'silver', 'bronze'];
const MEDAL_RANK = { gold: 3, silver: 2, bronze: 1 };

/** Medal for a finishing position, or null off the podium. */
export function medalFor(placement) {
  return MEDALS[placement] || null;
}

export function defaultProfile() {
  return {
    version: PROFILE_VERSION,
    unlockedTracks: ['training'],
    unlockedVehicles: ['hopper'],
    champion: false,
    tutorialDone: false,
    results: {}
  };
}

/**
 * Make a profile read out of localStorage safe to use. A save from a future
 * build, a truncated write, or a hand-edited key must degrade to "new player"
 * rather than throwing somewhere in the middle of the menu.
 */
export function normalizeProfile(raw) {
  const p = defaultProfile();
  if (!raw || typeof raw !== 'object') return p;
  if (Array.isArray(raw.unlockedTracks)) {
    for (const id of raw.unlockedTracks) {
      if (TRACK_ORDER.indexOf(id) >= 0 && p.unlockedTracks.indexOf(id) < 0) p.unlockedTracks.push(id);
    }
  }
  if (Array.isArray(raw.unlockedVehicles)) {
    for (const id of raw.unlockedVehicles) {
      if (VEHICLE_ORDER.indexOf(id) >= 0 && p.unlockedVehicles.indexOf(id) < 0) p.unlockedVehicles.push(id);
    }
  }
  p.champion = !!raw.champion;
  p.tutorialDone = !!raw.tutorialDone;
  if (raw.results && typeof raw.results === 'object') {
    for (const id of TRACK_ORDER) {
      const r = raw.results[id];
      if (!r || typeof r !== 'object') continue;
      p.results[id] = {
        medal: MEDAL_RANK[r.medal] ? r.medal : null,
        bestTotal: numOrNull(r.bestTotal),
        bestLap: numOrNull(r.bestLap),
        wins: Math.max(0, r.wins | 0),
        plays: Math.max(0, r.plays | 0)
      };
    }
  }
  return p;
}

function numOrNull(v) {
  const n = +v;
  return isFinite(n) && n > 0 ? n : null;
}

/** Deep-enough clone: the profile is four scalars, two id lists and a table. */
function cloneProfile(p) {
  const out = {
    version: PROFILE_VERSION,
    unlockedTracks: p.unlockedTracks.slice(),
    unlockedVehicles: p.unlockedVehicles.slice(),
    champion: !!p.champion,
    tutorialDone: !!p.tutorialDone,
    results: {}
  };
  for (const k in p.results) out.results[k] = Object.assign({}, p.results[k]);
  return out;
}

export function isTrackUnlocked(profile, id) {
  if (!profile) return id === 'training';
  return profile.unlockedTracks.indexOf(id) >= 0;
}

export function isVehicleUnlocked(profile, id) {
  if (!profile) return id === 'hopper';
  return profile.unlockedVehicles.indexOf(id) >= 0;
}

/** One line of UI copy telling the player how to earn a locked entry. */
export function lockHintFor(id) {
  const req = REQUIREMENT[id];
  if (!req) return '';
  const name = TRACK_NAME[req.track] || req.track;
  return req.podium ? `Podium at ${name}` : `Finish ${name}`;
}

/** Blank record row, so callers never have to null-check the table. */
export function recordFor(profile, trackId) {
  const r = profile && profile.results ? profile.results[trackId] : null;
  return r || { medal: null, bestTotal: null, bestLap: null, wins: 0, plays: 0 };
}

/**
 * The track the championship wants next: the first unlocked one with no gold,
 * falling back to the last unlocked track once everything is won.
 */
export function nextTrackFor(profile) {
  let last = 'training';
  for (const id of TRACK_ORDER) {
    if (!isTrackUnlocked(profile, id)) break;
    last = id;
    const r = recordFor(profile, id);
    if (r.medal !== 'gold') return id;
  }
  return last;
}

/**
 * Fold a finished race into the profile.
 *
 * @param profile    the current profile (NOT mutated)
 * @param trackId    which track was raced
 * @param placement  1-based finishing position (6 = last, or a DNF)
 * @param total      total race time in seconds, or null/Infinity for a DNF
 * @param bestLap    best lap in seconds, or null
 * @returns {{profile, unlocks:string[], medal:string|null, newRecord:{total?:number,lap?:number}}}
 *          `unlocks` are ready-to-show banner strings; `newRecord` carries the
 *          NEW time for each record that improved, and is empty otherwise.
 */
export function applyResult(profile, trackId, placement, total, bestLap) {
  const p = cloneProfile(normalizeProfile(profile));
  const unlocks = [];
  const newRecord = {};

  const finished = isFinite(total) && total > 0;
  const pos = placement > 0 ? placement | 0 : 99;
  const medal = finished ? medalFor(pos) : null;

  /* ---- records ---- */
  const rec = p.results[trackId] ||
    (p.results[trackId] = { medal: null, bestTotal: null, bestLap: null, wins: 0, plays: 0 });
  rec.plays++;
  if (pos === 1 && finished) rec.wins++;
  if (finished && (rec.bestTotal == null || total < rec.bestTotal)) {
    rec.bestTotal = total; newRecord.total = total;
  }
  const bl = numOrNull(bestLap);
  if (bl != null && (rec.bestLap == null || bl < rec.bestLap)) {
    rec.bestLap = bl; newRecord.lap = bl;
  }
  // A silver never demotes an earlier gold — the medal is the best you ever did.
  if (medal && (MEDAL_RANK[medal] || 0) > (MEDAL_RANK[rec.medal] || 0)) rec.medal = medal;

  /* ---- unlocks ---- */
  const reward = REWARDS[trackId];
  const earned = finished && (!reward || !reward.podium || pos <= 3);

  if (trackId === 'training' && finished && !p.tutorialDone) p.tutorialDone = true;

  if (reward && earned && !reward.winOnly) {
    for (const t of reward.tracks) {
      if (p.unlockedTracks.indexOf(t) < 0) {
        p.unlockedTracks.push(t);
        unlocks.push(`${TRACK_NAME[t] || t} UNLOCKED`);
      }
    }
    for (const v of reward.vehicles) {
      if (p.unlockedVehicles.indexOf(v) < 0) {
        p.unlockedVehicles.push(v);
        unlocks.push(`${VEHICLE_NAME[v] || v} UNLOCKED`);
      }
    }
  }

  // The caldera is the end of the game: only an outright win crowns you.
  if (trackId === 'volcano' && finished && pos === 1 && !p.champion) {
    p.champion = true;
    unlocks.push(CHAMPION_BANNER);
  }

  // Keep the lists in progression order so the UI never has to sort them.
  p.unlockedTracks.sort((a, b) => TRACK_ORDER.indexOf(a) - TRACK_ORDER.indexOf(b));
  p.unlockedVehicles.sort((a, b) => VEHICLE_ORDER.indexOf(a) - VEHICLE_ORDER.indexOf(b));

  return { profile: p, unlocks, medal, newRecord };
}

export default { defaultProfile, normalizeProfile, applyResult, isTrackUnlocked, isVehicleUnlocked, lockHintFor };
