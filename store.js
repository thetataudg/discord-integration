// store.js (ESM)
import { promises as fs } from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.DATA_DIR || path.resolve(process.cwd(), 'data');
const STORE_PATH = path.join(DATA_DIR, 'emailMap.json');

let cache = {
    emailToUser: {},          // email -> { userId, channelId, savedAt }
    userToEmail: {},          // userId -> email
    inviteIdToDiscord: {},    // inviteId ('inv_*') -> { userId, email, channelId, savedAt }
    pendingIdToDiscord: {},   // pending DB id -> { userId, email, channelId, savedAt }
};

function debounce(fn, ms) {
    let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
const saveNow = async () => {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const tmp = STORE_PATH + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(cache, null, 2), 'utf8');
    await fs.rename(tmp, STORE_PATH);
};
const save = debounce(saveNow, 200);

// --- helpers to migrate old data where inv_* was under pendingIdToDiscord ---
function migrateOldShape() {
    const moved = [];
    for (const k of Object.keys(cache.pendingIdToDiscord || {})) {
        if (k.startsWith('inv_')) {
            cache.inviteIdToDiscord[k] = cache.pendingIdToDiscord[k];
            delete cache.pendingIdToDiscord[k];
            moved.push(k);
        }
    }
    if (moved.length) save();
}

export async function initStore() {
    try {
        await fs.mkdir(DATA_DIR, { recursive: true });
        const txt = await fs.readFile(STORE_PATH, 'utf8');
        cache = JSON.parse(txt);
    } catch (e) {
        if (e.code !== 'ENOENT') console.error('store load error:', e);
    }
    migrateOldShape();
}

// Save email<->user and optionally inviteId/pendingId linkages
export function rememberEmail({ userId, email, channelId, inviteId, pendingId }) {
    if (!userId || !email) return;
    const e = String(email).trim().toLowerCase();
    const savedAt = Date.now();

    cache.emailToUser[e] = { userId, channelId, savedAt };
    cache.userToEmail[userId] = e;

    if (inviteId) {
        cache.inviteIdToDiscord[String(inviteId)] = { userId, email: e, channelId, savedAt };
    }
    if (pendingId) {
        cache.pendingIdToDiscord[String(pendingId)] = { userId, email: e, channelId, savedAt };
    }
    save();
}

// Explicitly link a pending DB id to a known invite id
export function linkPendingToInvite(pendingId, inviteId) {
    const inv = cache.inviteIdToDiscord[String(inviteId)];
    if (!inv) return false;
    cache.pendingIdToDiscord[String(pendingId)] = { ...inv };
    save();
    return true;
}

export function getByEmail(email) {
    if (!email) return null;
    return cache.emailToUser[String(email).trim().toLowerCase()] || null;
}
export function getByUserId(userId) {
    const e = cache.userToEmail[userId];
    return e ? { email: e, ...(cache.emailToUser[e] || { userId }) } : null;
}
export function getByPendingId(pendingId) {
    if (!pendingId) return null;
    return cache.pendingIdToDiscord[String(pendingId)] || null;
}

// Find the most recent invite mapping around a timestamp window
export function findRecentInviteMapping(tsMs, windowMs = 30 * 60 * 1000) {
    if (!tsMs) return null;
    let best = null;
    for (const [inviteId, rec] of Object.entries(cache.inviteIdToDiscord)) {
        const dt = Math.abs((rec.savedAt || 0) - tsMs);
        if (dt <= windowMs) {
            if (!best || dt < best.dt) best = { inviteId, mapping: rec, dt };
        }
    }
    return best; // { inviteId, mapping, dt } or null
}
