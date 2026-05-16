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
    committeeNameToRoleId: {}, // committee name -> Discord role ID
    statusNameToRoleId: {},   // status string -> Discord role ID
    ecouncilRoleId: '',       // Discord role ID for ECouncil members
    committeeHeadRoleId: '',  // Discord role ID for Committee Head (single shared role)
    dbIdToDiscord: {},        // member DB _id -> { userId, email, channelId, savedAt }
    bootstrapCompleted: false,
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

export function rememberDbId(dbId, { userId, email, channelId } = {}) {
    const key = String(dbId || '').trim();
    const mappedUserId = String(userId || '').trim();
    if (!key || !mappedUserId) return false;
    cache.dbIdToDiscord[key] = {
        userId: mappedUserId,
        email: email ? String(email).trim().toLowerCase() : '',
        channelId: channelId || null,
        savedAt: Date.now(),
    };
    save();
    return true;
}

export function getByDbId(dbId) {
    if (!dbId) return null;
    return cache.dbIdToDiscord[String(dbId).trim()] || null;
}

function normalizeCommitteeName(name) {
    return String(name || '').trim();
}

export function rememberCommitteeMapping(committeeName, roleId) {
    const key = normalizeCommitteeName(committeeName);
    const value = String(roleId || '').trim();
    if (!key || !value) return false;
    cache.committeeNameToRoleId[key] = value;
    save();
    return true;
}

export function getCommitteeRoleId(committeeName) {
    const key = normalizeCommitteeName(committeeName);
    if (!key) return null;
    return cache.committeeNameToRoleId[key] || null;
}

export function getAllCommitteeMappings() {
    return { ...cache.committeeNameToRoleId };
}

export function removeCommitteeMapping(committeeName) {
    const key = normalizeCommitteeName(committeeName);
    if (!key || !cache.committeeNameToRoleId[key]) return false;
    delete cache.committeeNameToRoleId[key];
    save();
    return true;
}

export function getCommitteeRoleIds() {
    return [...new Set(Object.values(cache.committeeNameToRoleId).filter(Boolean))];
}

export function rememberStatusMapping(statusName, roleId) {
    const key = String(statusName || '').trim();
    const value = String(roleId || '').trim();
    if (!key || !value) return false;
    cache.statusNameToRoleId[key] = value;
    save();
    return true;
}

export function getStatusRoleId(statusName) {
    const key = String(statusName || '').trim();
    if (!key) return null;
    return cache.statusNameToRoleId[key] || null;
}

export function getAllStatusMappings() {
    return { ...cache.statusNameToRoleId };
}

export function removeStatusMapping(statusName) {
    const key = String(statusName || '').trim();
    if (!key || !cache.statusNameToRoleId[key]) return false;
    delete cache.statusNameToRoleId[key];
    save();
    return true;
}

export function rememberEcouncilRole(roleId) {
    const value = String(roleId || '').trim();
    if (!value) return false;
    cache.ecouncilRoleId = value;
    save();
    return true;
}

export function getEcouncilRoleId() {
    return cache.ecouncilRoleId || '';
}

export function removeEcouncilRole() {
    if (!cache.ecouncilRoleId) return false;
    cache.ecouncilRoleId = '';
    save();
    return true;
}

// Committee Head (single shared role for any member who chairs >=1 committee)
export function rememberCommitteeHeadRole(roleId) {
    const value = String(roleId || '').trim();
    if (!value) return false;
    cache.committeeHeadRoleId = value;
    save();
    return true;
}

export function getCommitteeHeadRoleId() {
    return cache.committeeHeadRoleId || '';
}

export function removeCommitteeHeadRole() {
    if (!cache.committeeHeadRoleId) return false;
    cache.committeeHeadRoleId = '';
    save();
    return true;
}

export function getManagedRoleIds() {
    return [
        ...getCommitteeRoleIds(),
        cache.committeeHeadRoleId,
        ...Object.values(cache.statusNameToRoleId).filter(Boolean),
        cache.ecouncilRoleId,
    ].filter(Boolean);
}

export function markBootstrapCompleted() {
    cache.bootstrapCompleted = true;
    save();
}

export function isBootstrapCompleted() {
    return Boolean(cache.bootstrapCompleted);
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
