/* ============================================================
   RALLY ROAD RASH — terrain constants
   ------------------------------------------------------------
   The numbers the bake, the shader and the CPU height query must all agree
   on. They live alone so that changing one cannot be done in only two of the
   three places: terrain-bake.js writes the fields at these extents,
   terrain-shader.js hands the same numbers to the GPU as uniforms, and
   Terrain.heightAt() reads them back on the CPU. See the parity table in
   terrain-shader.js before touching anything below.

   Metres unless the name says otherwise. Treat every value as frozen.
   ============================================================ */

/* ---------------- world constants (metres) ---------------- */
/** Half-extent of the racing world. Everything past this is vista. */
export const PLAYABLE_EXT = 600;
/** Radial soft fence, for anything that still wants one number. */
export const PLAYABLE_R = 620;

export const MACRO_EXT = 1360, MACRO_RES = 2048;      // 0.664 m / texel
export const FAR_EXT = 7200, FAR_RES = 512;           // horizon scenery
export const DET_TILE = 12, DET_RES = 256;            // 0.047 m / texel, tiling
export const DENT_EXT = 1200;                         // rut field extent
export const SUNMASK_EXT = 1500;
export const SURF_EXT = 1240, SURF_RES = 1024;        // 1.21 m / texel

/* Detail noise is deliberately small. Coarser grain only works if the shader
   fades detail out with camera distance — a term the CPU cannot see, and
   therefore a lie the moment a car is more than 95 m away. Here the amplitude
   is low enough to need no fade at all, so the two sides evaluate the
   identical expression everywhere. */
export const DET_AMP = 0.135, DET_AMP2 = 0.052, DET_SCALE2 = 3.71;
export const FADE0 = 600, FADE1 = 668;   // macro -> far crossfade radius

export const BERM_OUT = 1.72;      // berm reaches this multiple of the rut half-width
export const BERM_GAIN = 0.85;     // how much displaced volume shows up as lip
export const DIG_CAP = 0.22;       // hub-deep, not axle-deep: a rally car must always
                                   // have a fighting chance of powering out of its hole
export const SLUMP_TTL = 2.0;
export const CURVE_R = 620000;     // horizon-curvature radius
