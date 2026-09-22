/* ============================================================
   AUTOMATED RACE QA — every stage, every machine, on the real input path
   ------------------------------------------------------------
   Load from the game's own page, with a race NOT running:

       const qa = await import('/dev/qa-drive.js');
       await qa.sweep();                      // all stages x all machines
       await qa.one('volcano', 'moto');       // just the one

   HOW IT WORKS, and why it works
   ------------------------------
   Nothing here reaches into the physics. It patches `input.poll` so the
   player car is driven by an AIDriver, which means every lap runs through
   the exact code path a human's keystrokes take — reset holds, checkpoint
   logic, collision, recovery, audio triggers, the lot. Then it drives the
   frame loop by hand at a fixed 1/60 with rendering stubbed out, so a
   six-minute race takes a couple of seconds.

   Two rules learned the hard way, both load-bearing:

     • notifyReset(). When the race flow teleports the car (respawn, or the
       grid), the AI's route tracker is still holding a projection from
       where the car USED to be, and it will steer confidently at a piece of
       road 200 m behind it — for ever. Watch for a jump of more than 20 m
       between frames and tell it.

     • THE WHOLE FIELD, not just the player slot. Every driving metric here
       is collected for all six cars, because the rivals are AI on the same
       stage and until this harness measured them the ONLY gate on AIDriver
       was dev/ai-check.mjs's kinematic mock, which has no terrain, no
       collisions and no recovery net. `out.rivals[]` is one row per rival;
       the flat player fields are kept as aliases so old readers still work.

     • Completion, not position, is the health signal. The QA driver has no
       AI_BALANCE handicap and typically finishes fifth or sixth. That is
       expected and is not a failure; a DNF, a stuck car, a NaN or a
       runaway reset count IS.
   ============================================================ */
const APP = () => window.ROADRASH;

/**
 * Wait until `fn()` is truthy. Polled on a TIMER, not requestAnimationFrame:
 * an automated browser runs this page in a pane that is frequently not
 * composited, and there rAF fires at a couple of hertz or not at all — which
 * is exactly why main.js races rAF against a timer when it pumps a bake. A
 * QA harness that waits on rAF simply hangs.
 */
function until(fn, ms = 60000, label = 'condition') {
  return new Promise((res, rej) => {
    const t0 = performance.now();
    const step = () => {
      let v;
      try { v = fn(); } catch (e) { return rej(e); }
      if (v) return res(v);
      if (performance.now() - t0 > ms) return rej(new Error('timeout waiting for ' + label));
      setTimeout(step, 16);
    };
    step();
  });
}

/** FNV-1a, so a stage/machine pair always seeds the same driver. */
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

const finite = (v) =>
  [v.pos.x, v.pos.y, v.pos.z, v.vel.x, v.vel.y, v.vel.z,
    v.quat.x, v.quat.y, v.quat.z, v.quat.w].every(Number.isFinite);

/**
 * Run one stage with one machine.
 * @param {string} trackId
 * @param {string} vehId
 * @param {object} opts  { maxSeconds, quality }
 */
export async function one(trackId, vehId, opts = {}) {
  const App = APP();
  if (!App) throw new Error('ROADRASH is not on window — is the game booted?');
  const maxSeconds = opts.maxSeconds || 900;
  /* Power-ups on unless told otherwise. `items: false` takes the clean
     handling baseline — the only way to prove a physics change did not
     regress, since an items race is chaotic by design. */
  const savedItems = App.settings.items;
  if (opts.items !== undefined) App.settings.items = !!opts.items;

  /* The profile is the player's save. Snapshot it, unlock everything for the
     duration, and put it back exactly as it was — a QA sweep that silently
     hands somebody the whole game would be a nasty surprise.

     BOTH copies. Restoring only App.profile is not enough and it bit us:
     race.js writes the result straight through to localStorage when the
     podium settles, so a sweep that reset the in-memory object left sixteen
     races' worth of medals and unlocks on disk, and the next real session
     picked them up. The storage key is save.js's `rallye.v1` — kept under
     the old name deliberately, see the note at the top of that file. */
  const SAVE_KEY = 'rallye.v1';
  const savedProfile = JSON.parse(JSON.stringify(App.profile));
  let savedStorage = null;
  try { savedStorage = localStorage.getItem(SAVE_KEY); } catch { /* private mode */ }
  App.profile = Object.assign({}, App.profile, {
    unlockedTracks: ['training', 'canyon', 'forest', 'volcano', 'thunder'],
    unlockedVehicles: ['hopper', 'ridgeback', 'redline', 'moto'],
  });

  const { AIDriver } = await import('../src/game/ai.js');
  const { makeRNG } = await import('../src/core/rng.js');

  App.startRace(trackId, vehId);
  /* AS.RACE (5) is the state main.js reaches only once the bake, the world
     and the Race object are all up. Waiting on App.race alone is not enough:
     it exists one statement earlier, and a tick taken before the state flips
     runs idle() instead of the race, which looks exactly like a hung sim. */
  await until(() => App.state === 5 && App.race && App.race.racers && App.race.racers.length,
    180000, 'world build');
  const race = App.race;
  const me = race.racers.find(r => r.isPlayer);

  /* SEEDED, not Math.random.

     A race is chaotic: one dab of contact into turn one changes every lap
     that follows, and with an unseeded driver the same machine on the same
     stage came back at 77 s one run and 101 s the next. Comparing two builds
     — or two vehicles — across that noise is impossible. Seeding on
     (stage, machine, opts.seed) makes a run reproducible, so a lap time that
     moves means something moved. Pass a different `seed` to sample the
     spread on purpose. */
  /* Mixed, not OR'd. `makeRNG(seed | 1)` forced the low bit and made every
     even seed identical to its odd successor — a four-seed sweep sampled two
     trajectories. Fold the seed through the hash instead and never hand
     makeRNG a zero. */
  const seed = (hashStr(trackId + '/' + vehId) ^ Math.imul((opts.seed | 0) + 1, 0x9E3779B1)) >>> 0;
  const driver = new AIDriver('qa', me.vehicle, race.trackData,
    { name: 'QA', skill: 0.78, aggression: 0.45, consistency: 0.9 }, makeRNG(seed || 1));
  const ctx = { vehicles: race.racers.map(r => r.vehicle), tracker: race.tracker, myId: me.id, state: 'running' };

  // ---- take over the input path ----
  const realPoll = App.input.poll.bind(App.input);
  let lastPos = me.vehicle.pos.clone();
  App.input.poll = (dt) => {
    const raw = realPoll(dt);
    // A teleport bigger than any single frame of motion means the race flow
    // moved us; the route tracker has to be told or it never re-acquires.
    if (me.vehicle.pos.distanceTo(lastPos) > 20) driver.notifyReset();
    lastPos.copy(me.vehicle.pos);
    ctx.state = race.state >= 2 ? 'running' : 'countdown';   // RS.RUNNING = 2
    const c = driver.update(dt, ctx);
    raw.throttle = c.throttle; raw.steer = c.steer;
    raw.brake = c.brake; raw.handbrake = c.handbrake;
    raw.reset = 0; raw.pause = false; raw.camera = false;
    return raw;
  };

  // ---- stub the expensive halves ----
  const realRender = App.engine.render.bind(App.engine);
  App.engine.render = () => { };
  const realBake = App.hud.bakeMap.bind(App.hud);
  App.hud.bakeMap = () => { };

  const t0 = performance.now();
  const DT = 1 / 60;
  const out = {
    track: trackId, veh: vehId, finished: false, dnf: false,
    position: null, total: null, bestLap: null, laps: 0,
    resets: 0, resetAt: {}, contacts: 0, maxAir: 0, worstY: 0, nan: false,
    fieldUnfinished: 0, wallSeconds: 0, simSeconds: 0, ticks: 0, error: null,
    /* Power-ups. The QA driver never FIRES one — it only copies the four
       driving axes off the AI — so `fired` is the field's doing and `hits`
       is what landed on anybody. A hits count that climbs while resets do
       too is the signature of a spin-crash-respawn loop. */
    itemsOn: false, itemsTaken: 0, itemsFired: 0, itemHits: 0,
    /* Where the lap time actually went. A machine can be slow for four very
       different reasons and the total tells you none of them: no top end
       (meanSpeed down, crawlFrac flat), no corner speed (crawlFrac up), too
       much time in the air (airFrac up), or simply crashing (resets, and
       offFrac — distance from the centreline is the only honest measure of
       "not on the road" that does not need the racing line). */
    meanSpeed: 0, crawlFrac: 0, airFrac: 0, offFrac: 0, maxSpeed: 0,
    /* One row per car on the grid, player included (`rivals` excludes it).
       `why` is race.js's reset-cause tally: 'off' and 'noprog' mean the nets
       are firing on racing, 'flip' and 'wedged' mean the terrain is. */
    cars: [], rivals: [], fieldResets: 0, rivalsUnfinished: 0,
  };
  /* Per-car accumulators, indexed by grid slot. The player's are aliased into
     the flat fields at the end so nothing that read this file before moves. */
  const acc = race.racers.map((r) => ({
    slot: r.slot, name: r.name, isPlayer: !!r.isPlayer, veh: r.spec.id,
    skill: r.ai ? +(r.ai.skill || 0).toFixed(3) : null,
    resets: 0, resetAt: {}, why: {}, maxAir: 0,
    spdSum: 0, spdN: 0, crawlN: 0, airN: 0, offN: 0, maxSpeed: 0,
  }));
  let spdSum = 0, spdN = 0, crawlN = 0, airN = 0, offN = 0;
  const near = { s: 0, d: 0, side: 1, lat: 0, x: 0, z: 0 };

  // Count the recovery system's work by watching the racer rows, which is
  // where race.js keeps it — no hook needed and nothing to leave behind.
  const resetSeen = race.racers.map(() => 0);

  try {
    let simT = 0, yieldN = 0;
    while (simT < maxSeconds) {
      App.tick(DT);
      simT += DT;
      const v = me.vehicle;
      if (!finite(v)) { out.nan = true; break; }
      if (v.airTime > out.maxAir) out.maxAir = v.airTime;
      if (Math.abs(v.pos.y) > out.worstY) out.worstY = Math.abs(v.pos.y);
      if (race.state === 2) {                                  // RS.RUNNING
        /* Every car, sequentially through the one `near` scratch. The player's
           columns are still accumulated separately so the flat fields keep
           their exact old meaning even if the loop below ever changes. */
        for (let i = 0; i < race.racers.length; i++) {
          const rv = race.racers[i].vehicle, a = acc[i];
          const sp2 = rv.speed;
          a.spdSum += sp2; a.spdN++;
          if (sp2 > a.maxSpeed) a.maxSpeed = sp2;
          if (sp2 < 8) a.crawlN++;
          if (rv.airborne) a.airN++;
          if (rv.airTime > a.maxAir) a.maxAir = rv.airTime;
          race.trackData.spline.nearest(rv.pos.x, rv.pos.z, near);
          if (near.d > race.trackData.spline.widthAt(near.s) * 1.4) a.offN++;
        }
        const sp = v.speed;
        spdSum += sp; spdN++;
        if (sp > out.maxSpeed) out.maxSpeed = sp;
        if (sp < 8) crawlN++;
        if (v.airborne) airN++;
        race.trackData.spline.nearest(v.pos.x, v.pos.z, near);
        if (near.d > race.trackData.spline.widthAt(near.s) * 1.4) offN++;
      }
      for (let i = 0; i < race.racers.length; i++) {
        const r = race.racers[i];
        if (r.ghostT > 0 && resetSeen[i] === 0) {
          resetSeen[i] = 1;
          /* WHERE, not just how many, and for EVERY car. A reset count on its
             own says a stage is hard; a histogram says which 25 m of it is,
             and a rival histogram says whether the AI is the hard part.
             Bucketed because the same feature catches a car at slightly
             different s every lap, and a list of raw arc lengths hides that
             they are one place. */
          race.trackData.spline.nearest(r.vehicle.pos.x, r.vehicle.pos.z, near);
          const b = Math.round(near.s / 25) * 25;
          const a = acc[i];
          a.resets++;
          a.resetAt[b] = (a.resetAt[b] || 0) + 1;
          const w = r.resetWhy || '?';
          a.why[w] = (a.why[w] || 0) + 1;
          if (r.isPlayer) {
            out.resets++;
            out.resetAt[b] = (out.resetAt[b] || 0) + 1;
          }
        } else if (r.ghostT <= 0) resetSeen[i] = 0;
      }
      if (race.state >= 4 || me.finished) break;              // RS.RESULTS = 4
      /* NO yield inside a run, deliberately.

         A browser throttles timers in a background tab to one wake-up a
         second, and after five minutes of that to one a MINUTE. A yield
         every N frames therefore does not cost N frames of latency, it costs
         a whole minute — a three-lap canyon race went from forty seconds to
         over an hour, which looks exactly like a hung simulation and is the
         single biggest trap in driving a game loop from a script.

         So a race is one synchronous burst: ~15 000 ticks, ten to thirty
         seconds of blocked main thread, and the yield happens between runs
         where one clamped wake-up is neither here nor there. `yieldN` still
         counts frames so a wedged run is visible in the result. */
      yieldN++;
    }
    out.simSeconds = +simT.toFixed(1);
    out.ticks = yieldN;
    const N = Math.max(1, spdN);
    out.meanSpeed = +(spdSum / N).toFixed(2);
    out.maxSpeed = +out.maxSpeed.toFixed(2);
    out.crawlFrac = +(crawlN / N).toFixed(3);
    out.airFrac = +(airN / N).toFixed(3);
    out.offFrac = +(offN / N).toFixed(3);
    out.finished = !!me.finished;
    out.dnf = !me.finished;
    out.position = me.pos || null;
    const st = (race.tracker.results() || []).find(r => r.id === me.id) || null;
    if (st) {
      out.laps = st.lap;
      out.total = st.total;
      out.bestLap = st.bestLap;
      out.finished = out.finished || !!st.finished;
    }
    out.position = race.tracker.position(me.id) || out.position;
    out.fieldUnfinished = race.racers.filter(r => !r.finished).length;

    const results = race.tracker.results() || [];
    out.cars = acc.map((a, i) => {
      const r = race.racers[i];
      const st = results.find(q => q.id === r.id) || null;
      const N = Math.max(1, a.spdN);
      return {
        slot: a.slot, name: a.name, veh: a.veh, isPlayer: a.isPlayer, skill: a.skill,
        resets: a.resets, resetAt: a.resetAt, why: a.why,
        meanSpeed: +(a.spdSum / N).toFixed(2), maxSpeed: +a.maxSpeed.toFixed(2),
        crawlFrac: +(a.crawlN / N).toFixed(3), airFrac: +(a.airN / N).toFixed(3),
        offFrac: +(a.offN / N).toFixed(3), maxAir: +a.maxAir.toFixed(2),
        finished: !!(r.finished || (st && st.finished)),
        bestLap: st ? st.bestLap : null, total: st ? st.total : null,
        laps: st ? st.lap : 0,
        position: race.tracker.position(r.id) || null,
      };
    });
    out.rivals = out.cars.filter(c => !c.isPlayer);
    out.fieldResets = out.rivals.reduce((n, c) => n + c.resets, 0);
    out.rivalsUnfinished = out.rivals.filter(c => !c.finished).length;
    if (race.arsenal) {
      out.itemsOn = race.arsenal.enabled;
      out.itemsTaken = race.arsenal.stats.taken;
      out.itemsFired = race.arsenal.stats.fired;
      out.itemHits = race.arsenal.stats.hits;
    }
  } catch (e) {
    out.error = String(e && e.message || e);
  } finally {
    out.wallSeconds = +((performance.now() - t0) / 1000).toFixed(1);
    App.input.poll = realPoll;
    App.engine.render = realRender;
    App.hud.bakeMap = realBake;
    try { if (App.race) App.race.quit(); } catch { /* already gone */ }
    App.profile = savedProfile;
    App.settings.items = savedItems;
    try {
      if (savedStorage === null) localStorage.removeItem(SAVE_KEY);
      else localStorage.setItem(SAVE_KEY, savedStorage);
    } catch { /* private mode */ }
  }
  return out;
}

/** One rival's line in a sweep table. Skill first: every other column on the
    row is only interesting relative to how good this driver is meant to be. */
export function printRival(c) {
  const why = Object.entries(c.why).map(([k, n]) => `${k}x${n}`).join(',') || '-';
  console.log(`      ${String(c.name).padEnd(8)} ${String(c.veh).padEnd(9)}` +
    ` sk ${c.skill == null ? ' n/a' : c.skill.toFixed(2)}` +
    ` P${c.position || '-'} ${c.finished ? 'fin' : 'DNF'}` +
    ` best ${c.bestLap ? c.bestLap.toFixed(2) : '  -   '}` +
    ` mean ${c.meanSpeed.toFixed(1)} crawl ${c.crawlFrac.toFixed(3)}` +
    ` off ${c.offFrac.toFixed(3)} air ${c.maxAir.toFixed(2)}s` +
    ` resets ${c.resets} [${why}]`);
}

/** Every stage against every machine. Returns the table and prints it. */
export async function sweep(tracks, vehicles, opts = {}) {
  const T = tracks || ['training', 'canyon', 'forest', 'volcano'];
  const V = vehicles || ['hopper', 'ridgeback', 'redline', 'moto'];
  const rows = [];
  for (const t of T) {
    for (const v of V) {
      // eslint-disable-next-line no-await-in-loop
      const r = await one(t, v, opts);
      rows.push(r);
      console.log(`[qa] ${t}/${v}`, r.finished ? `P${r.position} in ${r.simSeconds}s sim` : 'DNF',
        `resets ${r.resets} maxAir ${r.maxAir.toFixed(2)}s`,
        `| field resets ${r.fieldResets} unfinished ${r.rivalsUnfinished}`, r.error || '');
      for (const c of r.rivals) printRival(c);
      // eslint-disable-next-line no-await-in-loop
      await new Promise(res => setTimeout(res, 120));
    }
  }
  const bad = rows.filter(r => !r.finished || r.nan || r.error);
  const fieldResets = rows.reduce((n, r) => n + (r.fieldResets || 0), 0);
  const rivalsUnfinished = rows.reduce((n, r) => n + (r.rivalsUnfinished || 0), 0);
  console.log(`[qa] ${rows.length - bad.length}/${rows.length} completed` +
    `  | rivals: ${fieldResets} resets, ${rivalsUnfinished} unfinished at player finish over ${rows.length * 5} starts`);
  return { rows, bad, fieldResets, rivalsUnfinished };
}

export default { one, sweep, printRival };
