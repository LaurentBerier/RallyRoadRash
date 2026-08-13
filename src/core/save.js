/* ============================================================
   SAVE — localStorage, defensively
   ------------------------------------------------------------
   Two keys and nothing else:
     rallye.v1       the progression profile (see game/progression.js)
     rallye.v1.set   settings (see the settings-keys contract)

   Every path is wrapped: private browsing throws on setItem, a corrupt value
   throws on parse, and neither may take the game down. A failed read reads as
   "new player", a failed write is simply lost.
   ============================================================ */

const KEY = 'rallye.v1';
const SKEY = KEY + '.set';

export const Save = {
  /** Raw profile object, or null if there is nothing (or nothing valid). */
  read() {
    try { return JSON.parse(localStorage.getItem(KEY) || 'null'); }
    catch { return null; }
  },
  write(data) {
    try { localStorage.setItem(KEY, JSON.stringify(data)); return true; }
    catch { return false; }
  },
  clear() { try { localStorage.removeItem(KEY); } catch { /* private mode */ } },

  /** Named wrappers, so callers read as intent rather than as storage. */
  readProfile() { return Save.read(); },
  writeProfile(profile) { return Save.write(profile); },

  settings() {
    try { return JSON.parse(localStorage.getItem(SKEY) || 'null') || {}; }
    catch { return {}; }
  },
  saveSettings(s) {
    try { localStorage.setItem(SKEY, JSON.stringify(s)); return true; }
    catch { return false; }
  },
  clearSettings() { try { localStorage.removeItem(SKEY); } catch { /* ignore */ } }
};

export default Save;
