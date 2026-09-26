// Fixed grid identities, shared by paint and race markers. Player keeps works paint.
export const RIVAL_COLORS = [0x398ccc, 0x65ad58, 0xe3ad35, 0x9560c6, 0xcc5050];
export const rivalColor = livery => RIVAL_COLORS[((livery - 1) % RIVAL_COLORS.length + RIVAL_COLORS.length) % RIVAL_COLORS.length];
