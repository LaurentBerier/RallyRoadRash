/* ============================================================
   RALLY ROAD RASH — race presentation
   ------------------------------------------------------------
   Everything a race SHOWS and PLAYS that changes nothing about the race:
   crash bangs, boost flames, landing thumps, the lava banner, respawn dust.
   Split out of race.js so the frame contract in that file stays readable and
   so the sound/particle/shake response to an event can be worked on without
   touching the loop that decides the event happened.

   The rule for anything living here: it may READ vehicle and racer state and
   it may drive audio / feel / dust / hud / vfx. It may not write to a
   vehicle, a racer row, the tracker or the arsenal. If a method here
   returned a value that changed the race, it would belong in race.js.

   The arsenal (game/arsenal.js) presents its own events — the muzzle
   flash, the bang, the nitro flame — at the point it decides them, because
   every one of them needs the world position of a rocket this file never
   sees. What it hands race.js instead is sequence numbers, and race.js
   turns those into the HUD's race log.

   Distance gating is the recurring idea. A rival's crash, boost or landing
   seventy metres up the road is information — somebody just got a run on you
   — but past that it is noise, so almost everything takes the camera distance
   and fades itself out. race.js already has that number for other reasons.
   ============================================================ */
import * as THREE from 'three';
import { SURF, SURFACES } from '../world/surfaces.js';
import { DUST_KIND } from '../world/dust.js';
import { TUNE } from './config.js';
import { clamp } from '../core/rng.js';

const BOOST = TUNE.boost;
const BOOST_HEAR = 70;              // m — a rival's boost you can still hear
const CRASH_HEAR = 55;              // m — a rival's crash you can still hear
const LAND_HEAR = 70;               // m — a rival's landing you can still hear
const TOUCHDOWN_AIR = 0.12;         // s of air before a landing is an event
const AIRTIME_BRAG = 1.3;           // s of air worth a HUD flourish. Hang-time
                                    //   gravity makes 1 s airs routine; the brag
                                    //   has to stay something you earn.
const LAVA_WARN_GAP = 3.5;          // s between lava banners

export class RaceFX {
  /**
   * @param o.audio    core/audio.js Audio
   * @param o.feel     game/feel.js Feel, or null
   * @param o.dust     world/dust.js Dust
   * @param o.terrain  world/terrain.js Terrain
   * @param o.hud      ui/hud.js HUD
   * @param o.engine   core/engine.js Engine
   * @param o.vfx      world/vfx.js VFX, or null until it exists
   */
  constructor(o) {
    this.audio = o.audio; this.feel = o.feel; this.dust = o.dust;
    this.terrain = o.terrain; this.hud = o.hud; this.engine = o.engine;
    this.vfx = o.vfx || null;
    this._lavaT = 0;
  }

  /** Called at the grid: nothing may carry over from the previous attempt. */
  reset() { this._lavaT = 0; }

  /**
   * Collision heard and felt. Rivals only ring the bell if you are near them.
   * @param a       the racer row that was hit
   * @param b       the other racer row, or null for a prop
   * @param impact  closing speed, m/s
   * @param player  the player's racer row (for distance and shake direction)
   */
  contact(a, b, impact, player) {
    const p = player.vehicle;
    const near = a.isPlayer || (b && b.isPlayer);
    let gain = 1, pan = 0;
    if (!near) {
      const src = a.vehicle.pos;
      const d = src.distanceTo(p.pos);
      if (d > CRASH_HEAR) return;
      gain = clamp(1 - d / CRASH_HEAR, 0.15, 1);
      pan = clamp(_v1.subVectors(src, p.pos).dot(p.right) / 22, -1, 1);
    }
    this.audio.crash(clamp(impact * 0.16, 0.2, 2.2) * gain, pan);
    if (near && this.feel) {
      // Direction of the shove, so the shake leans the way the hit came from.
      const other = b ? (a.isPlayer ? b.vehicle : a.vehicle) : null;
      if (other) _v2.subVectors(p.pos, other.pos).setY(0).normalize();
      else _v2.copy(p.vel).setY(0).normalize().negate();
      this.feel.collision(impact, _v2);
    }
  }

  /**
   * Mini-turbo cues. Called once per racer per frame from the wheel-effects
   * pass, because that is where the drift state has already been stepped for
   * every wheel, and because `tierUp`/`fired` are single-frame flags that must
   * be consumed exactly once.
   * @param r     racer row
   * @param D     the vehicle's drift state (miniturbo.js)
   * @param camD  distance from the camera to this car, m
   */
  boost(r, D, camD) {
    if (D.tierUp) {
      if (r.isPlayer) {
        this.audio.boostTier(D.tier);
        if (this.feel) this.feel.kick(BOOST.tierFov);
      }
    }
    if (!D.fired) return;
    const t = D.fired;
    if (r.isPlayer) {
      this.audio.boostFire(t, 1);
      if (this.feel) {
        this.feel.kick(BOOST.fireFov[t - 1]);
        this.feel.addShake(BOOST.fireShake[t - 1]);
      }
    } else if (camD < BOOST_HEAR) {
      this.audio.boostFire(t, clamp(1 - camD / BOOST_HEAR, 0.12, 0.5));
    }
    /* The flame. EMBER is already a glowing, buoyant, cooling particle whose
       shader multiplies by a fixed warm tint and clears the bloom threshold —
       so an ember IS a flame with no new particle kind, no fourth entry in
       dust.js's K_GY/K_BUOY tables and no shader branch. It cannot be tinted
       cool, which is why the TIER is read from the charge dust and the FLAME
       is the same every time. */
    const v = r.vehicle;
    if (camD < 120) {
      const f = v.forward;
      this.dust.spawn(3 + t, v.pos.x - f.x * 1.6, v.pos.y - 0.15, v.pos.z - f.z * 1.6,
        2.0 + t * 0.9, 0.30, -f.x, -f.z, 1.0, 0.55, 0.16, DUST_KIND.EMBER);
    }
  }

  /** Leaving a lip. Called on the airborne rising edge. */
  lip(r, v) {
    if (v.vel.y <= 4) return;
    this.audio.jumpWhoosh(clamp(v.vel.y * 0.12, 0.25, 1.5) * (r.isPlayer ? 1 : 0.35));
    if (r.isPlayer && this.feel && this.feel.jump) this.feel.jump();
  }

  /**
   * Touching down. Called on the airborne falling edge; `r.airPeak` still
   * holds the flight time, because airTime is already zero by now.
   * @param emit  0 or 1 — the wheel-effects pass's particle budget for this car
   */
  touchdown(r, v, camD, emit) {
    if (r.airPeak <= TOUCHDOWN_AIR) return;
    const hit = Math.max(v.hardHit, Math.max(0,-(v._airVy||0)), 2.5);
    if (r.isPlayer) {
      if (this.feel) this.feel.landing(hit);
      this.audio.land(clamp(hit * 0.22, 0.2, 2.2), v.surfaceId, v.spec.id, 0, true);
      if (r.airPeak > AIRTIME_BRAG) this.hud.airtime(r.airPeak);
    } else if (camD < LAND_HEAR) {
      this.audio.land(clamp(hit * 0.22, 0.2, 2.2) * clamp(1 - camD / LAND_HEAR, 0.1, 0.6), v.surfaceId, v.spec.id, 0, false);
    }
    const S = SURFACES[v.surfaceId] || SURFACES[SURF.DIRT];
    if (emit > 0) {
      this.dust.burst(v.pos.x, this.terrain.heightAt(v.pos.x, v.pos.z), v.pos.z,
        Math.atan2(v.vel.x, v.vel.z), clamp(hit * 0.16, 0.4, 2.0) * S.dust, S.dustCol);
    }
  }

  /**
   * Lava is not damage — it is 0.55 grip and a lot of drag, which is
   * punishment enough. The banner and the hiss exist so the player knows WHY
   * the car has gone vague.
   */
  lava(dt, pv) {
    if (this.terrain.surfaceAt(pv.pos.x, pv.pos.z) === SURF.LAVA) {
      this.audio.scrape(SURF.LAVA, clamp(Math.abs(pv.speed) / 18, 0.2, 1));
      this._lavaT -= dt;
      if (this._lavaT <= 0) { this._lavaT = LAVA_WARN_GAP; this.hud.banner('LAVA CRUST — NO GRIP', 'bad', 1.8); }
    } else if (this._lavaT > 0) {
      this._lavaT = 0;
    }
  }

  /** Puff of the local surface where a car has just been put back on course. */
  respawn(v, yaw) {
    const S = SURFACES[v.surfaceId] || SURFACES[SURF.DIRT];
    this.dust.burst(v.pos.x, this.terrain.heightAt(v.pos.x, v.pos.z), v.pos.z, yaw, 1.4, S.dustCol);
  }

  /* ------------------------------------------------------------------
     Seams for the wave-6 packages. race.js calls these from the right
     places already, so the day VFX and the trick system land there is no
     integration left to do — only bodies to write. Each is deliberately a
     no-op rather than absent: a missing method would make every call site
     grow a guard.
     ------------------------------------------------------------------ */
  /** A crate or a can was taken. (ri, pickupKind) */
  pickup() { }
  /** A rocket connected. (ri, byRi, direct) */
  hit() { }
  /** A trick was scored on landing. (r, trickId, pts, tier) */
  trick() { }
  /** A boost pad was crossed. (r, pad) */
  pad() { }
  /** A checkpoint was taken. (r, cpIndex) */
  checkpoint() { }
  /** Somebody crossed the line for the last time. (r, place) */
  finish() { }
  /** The leader started the final lap. (r) */
  finalLap() { }

  dispose() { this.vfx = null; }
}

/* ---------------- module scratch ---------------- */
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
