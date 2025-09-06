// Theta Tau Onboarding Bot — Email‑first Flow (discord.js v14, ESM)
// ----------------------------------------------------------------
// Process implemented:
// 1) On member join → create private verify channel (member + admins/mods), give Pending role.
// 2) Send "Get Started" button → opens a modal asking for **email only**.
// 3) On submit → POST { email, secret } to INVITE_API_URL, send admin embed, and
//    in the temp channel post a 3‑step image guide (if STEP_IMAGE_* envs are set).
// 4) Background poll (every PENDING_POLL_MS) GETs PENDING_CHECK_URL (or derived from INVITE_API_URL)
//    and posts an admin embed listing pending requests **with Approve / Reject buttons**.
// 5) Approve/Reject buttons send PATCH to `${APPROVAL_API_BASE}/${rollNo}/` with
//    { action: 'approve' | 'reject', secret }. If rejected → DM user (if known) & kick.
// 6) If approved → GET MEMBERS_API_URL, find the member by rollNo (fallback to newest by createdAt),
//    ping user in their temp channel to upload a profile picture; when they upload, build a Welcome
//    embed from API data + photo and post to #welcome-cards; assign roles by Status and isECouncil.
// 7) The bot ties Discord user ↔ email via the modal; we keep in‑memory maps: email→{userId,channelId}.
//    (For production, persist these maps to a DB.)
//
// Requirements:
// - Node.js 18+ (uses global fetch)
// - npm i discord.js dotenv
// - Bot Privileged Intent: SERVER MEMBERS INTENT
// - Recommended permissions: Manage Channels, Manage Roles, View Channels, Send Messages,
//   Read Message History, Attach Files, Embed Links, Kick Members.
//
// .env example:
//   DISCORD_TOKEN=your_bot_token
//   GUILD_ID=123...
//   MOD_ROLE_ID=123...                        # role that can see the verify channels (mods/admins)
//   ADMIN_ROLE_ID=123...                      # role to ping in admin channel
//   PENDING_ROLE_ID=123...
//   ECOUNCIL_ROLE_ID=123...                   # optional — assigned if isECouncil === true
//   CATEGORY_ID=123...                        # optional — category for verify channels
//   WELCOME_CARDS_CHANNEL_ID=123...
//   INVITE_API_URL=https://thetatau-dg.org/api/members/invitations
//   INVITE_API_SECRET=super_secret
//   PENDING_CHECK_URL=https://thetatau-dg.org/api/members/pending   # optional override
//   APPROVAL_API_BASE=https://thetatau-dg.org/api/members/pending
//   MEMBERS_API_URL=https://thetatau-dg.org/api/members
//   PENDING_POLL_MS=10000                      # 10s for testing; increase in prod
//   STEP_IMAGE_1=https://example.com/step1.png
//   STEP_IMAGE_2=https://example.com/step2.png
//   STEP_IMAGE_3=https://example.com/step3.png
//
// Run: node index.mjs

import 'dotenv/config';
import axios from 'axios';

import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelType,
    Client,
    EmbedBuilder,
    Events,
    GatewayIntentBits,
    ModalBuilder,
    Partials,
    PermissionsBitField,
    TextInputBuilder,
    TextInputStyle,
} from 'discord.js';
import { Buffer } from 'node:buffer';

// ---------------- ENV ----------------
const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const MOD_ROLE_ID = process.env.MOD_ROLE_ID; // who can see verify channels
const ADMIN_ROLE_ID = process.env.ADMIN_ROLE_ID || '';
const PENDING_ROLE_ID = process.env.PENDING_ROLE_ID;
const ECOUNCIL_ROLE_ID = process.env.ECOUNCIL_ROLE_ID || '';
const CATEGORY_ID = process.env.CATEGORY_ID || '';
const WELCOME_CARDS_CHANNEL_ID = process.env.WELCOME_CARDS_CHANNEL_ID;

const INVITE_API_URL = process.env.INVITE_API_URL || '';
const INVITE_API_SECRET = process.env.INVITE_API_SECRET || '';
const PENDING_CHECK_URL = process.env.PENDING_CHECK_URL || '';
const APPROVAL_API_BASE = process.env.APPROVAL_API_BASE || 'https://thetatau-dg.org/api/members/pending';
const MEMBERS_API_URL = process.env.MEMBERS_API_URL || 'https://thetatau-dg.org/api/members';
const PENDING_POLL_MS = parseInt(process.env.PENDING_POLL_MS || '10000', 10);

const STEP_IMAGE_1 = process.env.STEP_IMAGE_1 || '';
const STEP_IMAGE_2 = process.env.STEP_IMAGE_2 || '';
const STEP_IMAGE_3 = process.env.STEP_IMAGE_3 || '';

if (!TOKEN || !GUILD_ID || !MOD_ROLE_ID || !PENDING_ROLE_ID || !WELCOME_CARDS_CHANNEL_ID || !INVITE_API_URL) {
    console.error('Missing required env vars. Check the header comments.');
    process.exit(1);
}

function maskSecret(jsonStr) {
    // replaces the secret value with **** keeping only last 4 chars
    return String(jsonStr).replace(
        /("secret"\s*:\s*")([^"]*)(")/,
        (_, a, b, c) => a + (b ? b.replace(/.(?=.{4})/g, '•') : '') + c
    );
}


// -------------- Client --------------
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel, Partials.GuildMember, Partials.Message],
});

// -------------- In‑memory state --------------
// Link Discord users to emails & their verify channel
const emailToUser = new Map(); // email -> { userId, channelId }
const userToEmail = new Map(); // userId -> email
const awaitingPfp = new Map(); // userId -> { apiMember, channelId }
let lastPendingDigest = '';

// -------------- Helpers --------------
const THEME_RED = 0x8c1d40; // Theta Tau dark red
const THEME_GOLD = 0xffc627;

function isValidEmail(s) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '').trim());
}

function nameFor(member) {
    return member?.user?.username || 'member';
}

function channelNameFor(member) {
    const base = nameFor(member).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 20);
    return `verify-${base}-${(member.user.discriminator || member.user.id).slice(-4)}`;
}

async function ensureCategory(guild) {
    if (!CATEGORY_ID) return null;
    return guild.channels.cache.get(CATEGORY_ID) || (await guild.channels.fetch(CATEGORY_ID).catch(() => null));
}

async function createPrivateChannel(member) {
    const guild = member.guild;
    const category = await ensureCategory(guild);
    const name = channelNameFor(member);

    const overwrites = [
        { id: guild.roles.everyone, deny: [PermissionsBitField.Flags.ViewChannel] },
        { id: member.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.AttachFiles] },
        { id: MOD_ROLE_ID, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] },
    ];

    return guild.channels.create({
        name,
        type: ChannelType.GuildText,
        parent: category?.id,
        permissionOverwrites: overwrites,
        reason: 'Verification channel',
    });
}

function getStartedRow(userId) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`verify:start:${userId}`).setStyle(ButtonStyle.Primary).setLabel('Get Started')
    );
}

function approveRejectRow(rollNo, email) {
    const safeRoll = String(rollNo || 'unknown');
    const safeEmail = (email && String(email).trim()) ? String(email).trim() : 'none';
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`pending:approve:${safeRoll}:${safeEmail}`).setStyle(ButtonStyle.Success).setLabel('Approve ✅'),
        new ButtonBuilder().setCustomId(`pending:reject:${safeRoll}:${safeEmail}`).setStyle(ButtonStyle.Danger).setLabel('Reject ❌'),
    );
}

function emailModal(userId) {
    const modal = new ModalBuilder().setCustomId(`verify:email:${userId}`).setTitle('Start Verification');
    const email = new TextInputBuilder().setCustomId('email').setLabel('School/Chapter Email').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('you@example.edu');
    modal.addComponents(new ActionRowBuilder().addComponents(email));
    return modal;
}

function stepsEmbeds() {
    const blocks = [];
    if (STEP_IMAGE_1) {
        blocks.push(new EmbedBuilder().setColor(THEME_GOLD).setTitle('Step 1 — Check your email').setDescription('We sent you an invitation to register.').setImage(STEP_IMAGE_1));
    }
    if (STEP_IMAGE_2) {
        blocks.push(new EmbedBuilder().setColor(THEME_GOLD).setTitle('Step 2 — Complete registration').setDescription('Fill out your basic details on the site.').setImage(STEP_IMAGE_2));
    }
    if (STEP_IMAGE_3) {
        blocks.push(new EmbedBuilder().setColor(THEME_GOLD).setTitle('Step 3 — Wait for admin approval').setDescription('Once approved, come back here to upload your profile picture.').setImage(STEP_IMAGE_3));
    }
    return blocks;
}

function buildInviteAdminEmbed(email, payload, ok, member) {
    const fields = [];
    if (payload?.id) fields.push({ name: 'ID', value: String(payload.id), inline: false });
    if (payload?.emailAddress || email) fields.push({ name: 'Email', value: String(payload?.emailAddress || email), inline: true });
    if (payload?.status) fields.push({ name: 'Status', value: String(payload.status), inline: true });
    if (payload?.createdAt) fields.push({ name: 'Created', value: new Date(Number(payload.createdAt)).toLocaleString(), inline: true });
    if (payload?.updatedAt) fields.push({ name: 'Updated', value: new Date(Number(payload.updatedAt)).toLocaleString(), inline: true });

    return new EmbedBuilder()
        .setColor(ok ? 0x22c55e : 0xe11d48)
        .setTitle(ok ? '🎟️ Invitation Created' : '⚠️ Invitation Failed')
        .setDescription(member ? `User: <@${member.id}>` : undefined)
        .addFields(fields)
        .setTimestamp();
}

function formatPendingItem(it) {
    if (typeof it === 'string') return it;
    const name = [it.fName, it.lName].filter(Boolean).join(' ') || '—';
    const roll = it.rollNo ?? it.rollNumber ?? '—';
    const year = it.gradYear ?? '—';
    const status = it.status ?? 'pending';
    const email = it.email || it.emailAddress || (it.user && it.user.email) || '—';
    const majors = Array.isArray(it.majors) ? it.majors.join(', ') : (it.major || '—');
    const family = it.familyLine || '—';
    const submitted = it.submittedAt || it.createdAt || it.updatedAt;
    const submittedStr = submitted ? new Date(submitted).toLocaleString() : '—';
    const id = it._id || it.id || '—';
    return [
        `**Name:** ${name}`,
        `**Roll #:** ${roll} | **Year:** ${year}`,
        `**Status:** ${status}`,
        `**Email:** ${email}`,
        `**Majors:** ${majors}`,
        `**Family:** ${family}`,
        `Submitted: ${submittedStr}`,
        `ID: \`${id}\``,
    ].join('\n');
}

function buildWelcomeEmbedFromApi(member, api) {
    const fullName = [api.fName, api.lName].filter(Boolean).join(' ') || member.user.username;
    const e = new EmbedBuilder()
        .setColor(THEME_RED)
        .setTitle(fullName)
        .setDescription('🎉 New Member Onboarding Card')
        .addFields(
            { name: 'Roll #', value: String(api.rollNo || '—'), inline: true },
            { name: 'Status', value: String(api.status || '—'), inline: true },
            { name: 'Family Line', value: String(api.familyLine || '—'), inline: true },
            { name: 'Grad Year', value: String(api.gradYear || '—'), inline: true },
            { name: 'Major(s)', value: Array.isArray(api.majors) ? api.majors.join(', ') : String(api.major || '—') },
            { name: 'Hometown', value: String(api.hometown || '—'), inline: true },
            { name: 'ECouncil', value: api.isECouncil ? 'Yes' : 'No', inline: true },
            { name: 'GitHub', value: api.socialLinks?.github || '—', inline: true },
            { name: 'LinkedIn', value: api.socialLinks?.linkedin || '—', inline: true },
        )
        .setFooter({ text: `Created: ${api.createdAt ? new Date(api.createdAt).toLocaleString() : '—'}` })
        .setTimestamp();
    return e;
}

function statusRoleIdFrom(api) {
    const s = String(api.status || '').toLowerCase();
    if (/alum/.test(s)) return process.env.ALUMNI_ROLE_ID || '';
    if (/active/.test(s)) return process.env.ACTIVE_ROLE_ID || '';
    if (/(pnm|interest|prospect|new|pledge)/.test(s)) return process.env.PNM_ROLE_ID || '';
    return '';
}

function buildPendingCheckUrl() {
    try {
        if (PENDING_CHECK_URL) {
            const u = new URL(PENDING_CHECK_URL);
            if (INVITE_API_SECRET) u.searchParams.set('secret', INVITE_API_SECRET);
            return u.toString();
        }
        const u = new URL(INVITE_API_URL);
        u.pathname = '/api/members/pending';
        if (INVITE_API_SECRET) u.searchParams.set('secret', INVITE_API_SECRET);
        return u.toString();
    } catch {
        return '';
    }
}

async function postStepsGuide(tempChannel) {
    const embeds = stepsEmbeds();
    if (!embeds.length) return;
    for (const e of embeds) {
        await tempChannel.send({ embeds: [e] }).catch(() => { });
    }
}

// ---------------- API calls ----------------
async function postInvitation(email) {
    const res = await fetch(INVITE_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, secret: INVITE_API_SECRET }),
    });
    let payload = null;
    try { payload = await res.json(); } catch { payload = null; }
    return { ok: res.ok, payload };
}

// PATCH /api/members/pending/:rollNo/  { action, secret }
async function patchApproval(rollNo, action) {
    const url = `${APPROVAL_API_BASE.replace(/\/$/, '')}/${encodeURIComponent(String(rollNo))}/`;

    const body = {
        action: action === 'approve' ? 'approve' : 'reject',
        secret: INVITE_API_SECRET,
    };

    // ---- DEBUG LOGS ----
    console.log('--- PATCH /pending/:rollNo ---');
    console.log('URL :', url);
    console.log('HEAD:', { 'Content-Type': 'application/json' });
    // mask secret in logs
    const masked = JSON.stringify(body).replace(
        /("secret"\s*:\s*")([^"]*)(")/,
        (_, a, b, c) => a + (b ? b.replace(/.(?=.{4})/g, '•') : '') + c
    );
    console.log('BODY:', masked);
    // --------------------

    const res = await axios.patch(url, body, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000,
        // If your host needs TLS SNI tweaks or a proxy, you can configure here
    });

    console.log('STATUS:', res.status);
    console.log('RESP  :', res.data);

    return { ok: res.status >= 200 && res.status < 300, payload: res.data };
}

async function safePatchApproval(rollNo, action) {
    try {
        return await patchApproval(rollNo, action);
    } catch (e) {
        if (String(e?.code) === 'UND_ERR_REQ_CONTENT_LENGTH_MISMATCH') {
            await new Promise(r => setTimeout(r, 200));
            return await patchApproval(rollNo, action);
        }
        throw e;
    }
}


async function getPending() {
    const base =
        PENDING_CHECK_URL && PENDING_CHECK_URL.trim()
            ? PENDING_CHECK_URL.trim()
            : (() => {
                const u = new URL(INVITE_API_URL);
                u.pathname = '/api/members/pending';
                u.search = '';
                return u.toString();
            })();

    const url = new URL(base);
    if (INVITE_API_SECRET) url.searchParams.set('secret', INVITE_API_SECRET);

    const res = await fetch(url.toString(), { method: 'GET' });
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.data)) return data.data;
    if (data && Array.isArray(data.list)) return data.list;
    return [];
}

async function getMembers() {
    const res = await fetch(MEMBERS_API_URL);
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    return Array.isArray(data) ? data : (data?.data || []);
}

// ---------------- Events ----------------
client.once(Events.ClientReady, (c) => {
    console.log(`✅ Logged in as ${c.user.tag}`);
    schedulePendingChecker();
});

client.on(Events.GuildMemberAdd, async (member) => {
    try {
        if (member.guild.id !== GUILD_ID) return;

        await member.roles.add(PENDING_ROLE_ID).catch(() => { });
        const channel = await createPrivateChannel(member);

        const intro = new EmbedBuilder()
            .setColor(THEME_GOLD)
            .setTitle('Welcome! Let\'s get you verified')
            .setDescription('Click **Get Started** to enter your email. We\'ll send you an invitation and instructions.');

        await channel.send({
            content: `<@${member.id}>`,
            embeds: [intro],
            components: [getStartedRow(member.id)],
        });
    } catch (err) {
        console.error('GuildMemberAdd error:', err);
    }
});

client.on(Events.InteractionCreate, async (interaction) => {
    try {
        // Buttons (Start / Approve / Reject)
        if (interaction.isButton()) {
            const parts = interaction.customId.split(':');
            const ns = parts[0];
            const action = parts[1];

            // Start → open email modal
            if (ns === 'verify' && action === 'start') {
                const userId = parts[2];
                if (userId !== interaction.user.id) {
                    return interaction.reply({ content: 'This button is not for you.', ephemeral: true });
                }
                return interaction.showModal(emailModal(userId));
            }

            // Admin approve/reject
            if (ns === 'pending' && (action === 'approve' || action === 'reject')) {
                // Only allow admins/mods
                const member = await interaction.guild.members.fetch(interaction.user.id);
                const hasAdminRole = ADMIN_ROLE_ID && member.roles.cache.has(ADMIN_ROLE_ID);
                const hasPerm = hasAdminRole || member.permissions.has(PermissionsBitField.Flags.ManageGuild);
                if (!hasPerm) return interaction.reply({ content: 'You lack permission to do this.', ephemeral: true });

                const rollNo = parts[2];
                const email = parts[3] && parts[3] !== 'none' ? parts[3] : null;
                await interaction.deferReply({ ephemeral: true });

                const { ok, payload } = await patchApproval(rollNo, action);
                if (!ok) {
                    await interaction.editReply(`API ${action} failed for roll #${rollNo}.`);
                    return;
                }

                // If rejected → DM + kick if we know the user
                if (action === 'reject') {
                    const link = email && emailToUser.get(email);
                    if (link) {
                        try {
                            const user = await client.users.fetch(link.userId);
                            await user.send('Your profile request was rejected by an admin. If you believe this is an error, email **regent@thetatau-dg.org**.');
                            const gm = await interaction.guild.members.fetch(link.userId).catch(() => null);
                            if (gm) await gm.kick('Verification rejected by admin');
                        } catch { }
                    }
                    await interaction.editReply(`Rejected roll #${rollNo}.`);
                    return;
                }

                // Approved → fetch members, find by rollNo → ask for PFP in their temp channel
                const members = await getMembers();
                let apiMember = members.find(m => String(m.rollNo) === String(rollNo));
                if (!apiMember) {
                    // fallback newest by createdAt
                    apiMember = [...members].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
                }

                // locate the user via email mapping, prefer the email we have on the button
                let link = email ? emailToUser.get(email) : null;
                if (!link && apiMember) {
                    const apiEmail = apiMember.email || apiMember.emailAddress || (apiMember.user && apiMember.user.email);
                    if (apiEmail) link = emailToUser.get(apiEmail);
                }

                if (!link) {
                    await interaction.editReply(`Approved roll #${rollNo}. I couldn't locate the Discord user via email mapping.`);
                    return;
                }

                awaitingPfp.set(link.userId, { apiMember, channelId: link.channelId });
                const tempChan = await interaction.guild.channels.fetch(link.channelId).catch(() => null);
                if (tempChan) {
                    await tempChan.send({ content: `<@${link.userId}> Approved ✅ — please upload your **profile picture** as the next message in this channel.` });
                }
                await interaction.editReply(`Approved roll #${rollNo}. Asked the user for their profile picture.`);
                return;
            }
        }

        // Modal submit (email)
        if (interaction.isModalSubmit()) {
            const [ns, kind, userId] = interaction.customId.split(':');
            if (ns === 'verify' && kind === 'email') {
                if (userId !== interaction.user.id) return;
                const email = interaction.fields.getTextInputValue('email').trim();
                if (!isValidEmail(email)) {
                    return interaction.reply({ content: 'Please enter a valid email.', ephemeral: true });
                }
                // Remember mapping
                userToEmail.set(interaction.user.id, email);
                // Create / ensure their channel id
                const channelId = interaction.channel?.id || null;
                if (channelId) emailToUser.set(email, { userId: interaction.user.id, channelId });

                await interaction.deferReply({ ephemeral: true });
                const { ok, payload } = await postInvitation(email);

                // Admin embed
                try {
                    const guild = interaction.guild ?? (await client.guilds.fetch(GUILD_ID));
                    const adminChan = ADMIN_ROLE_ID && process.env.ADMIN_CHANNEL_ID
                        ? await guild.channels.fetch(process.env.ADMIN_CHANNEL_ID).catch(() => null)
                        : null;
                    if (adminChan) {
                        const embed = buildInviteAdminEmbed(email, payload, ok, interaction.member);
                        const mention = ADMIN_ROLE_ID ? `<@&${ADMIN_ROLE_ID}>` : '';
                        await adminChan.send({ content: `${mention} New invitation submitted`, embeds: [embed] });
                    }
                } catch { }

                // Steps guide to temp channel
                await postStepsGuide(interaction.channel);
                await interaction.editReply(ok ? 'Invite sent! Check your email and follow the steps above.' : 'There was an issue sending your invite. Please contact a mod.');
            }
        }
    } catch (err) {
        console.error('Interaction error:', err);
        if (interaction.isRepliable()) {
            try { await interaction.reply({ content: 'Something went wrong. Try again.', ephemeral: true }); } catch { }
        }
    }
});

// Catch profile picture after approval
client.on(Events.MessageCreate, async (msg) => {
    try {
        if (!msg.guild || msg.author.bot) return;
        const wait = awaitingPfp.get(msg.author.id);
        if (!wait) return;
        if (msg.channel.id !== wait.channelId) return;

        const attach = msg.attachments.first();
        if (!attach) return; // ignore non-attachments

        // Build welcome embed from API + photo
        const gm = await msg.guild.members.fetch(msg.author.id);
        const embed = buildWelcomeEmbedFromApi(gm, wait.apiMember);

        // Try to buffer the image so it persists
        let files = []; let thumbnailSet = false;
        try {
            const res = await fetch(attach.url);
            if (res.ok) {
                const buf = Buffer.from(await res.arrayBuffer());
                files = [{ attachment: buf, name: 'pfp.png' }];
                embed.setThumbnail('attachment://pfp.png');
                thumbnailSet = true;
            }
        } catch { }
        if (!thumbnailSet) {
            embed.setThumbnail(gm.user.displayAvatarURL({ extension: 'png', size: 256 }));
        }

        const welcome = await msg.guild.channels.fetch(WELCOME_CARDS_CHANNEL_ID).catch(() => null);
        if (welcome) await welcome.send({ embeds: [embed], files }).catch(() => { });

        // Role assignments
        const statusRoleId = statusRoleIdFrom(wait.apiMember);
        await gm.roles.remove(PENDING_ROLE_ID).catch(() => { });
        if (statusRoleId) await gm.roles.add(statusRoleId).catch(() => { });
        if (wait.apiMember?.isECouncil && ECOUNCIL_ROLE_ID) await gm.roles.add(ECOUNCIL_ROLE_ID).catch(() => { });

        awaitingPfp.delete(msg.author.id);
        await msg.reply('Thanks! Your welcome card has been posted.').catch(() => { });
    } catch (err) {
        console.error('PFP handling error:', err);
    }
});

// ---------------- Pending poll ----------------
function digestPending(items) {
    try {
        return items.map(it => String(it.rollNo || it._id || it.id || it.email || it.emailAddress || '')).sort().join('|');
    } catch { return ''; }
}

async function pollPendingInvitesAndNotify() {
    try {
        const items = await getPending();
        if (!items || !items.length) return;

        // avoid reposting the same list every tick
        const digest = digestPending(items);
        if (digest === lastPendingDigest) return;
        lastPendingDigest = digest;

        const guild = await client.guilds.fetch(GUILD_ID);
        const adminChan = process.env.ADMIN_CHANNEL_ID
            ? await guild.channels.fetch(process.env.ADMIN_CHANNEL_ID).catch(() => null)
            : null;
        if (!adminChan) return;

        const mention = ADMIN_ROLE_ID ? `<@&${ADMIN_ROLE_ID}> ` : '';
        await adminChan.send({
            content: `${mention}Pending invitations update — **${items.length}** waiting.`,
        });

        // one embed + one row of buttons per user
        for (const it of items) {
            const displayName =
                [it.fName, it.lName].filter(Boolean).join(' ') ||
                it.email ||
                it.emailAddress ||
                'Pending Member';

            const embed = new EmbedBuilder()
                .setColor(THEME_GOLD)
                .setTitle(`⏳ Pending — ${displayName}`)
                .setDescription(formatPendingItem(it))
                .setFooter({ text: `Roll # ${it.rollNo ?? '—'}` })
                .setTimestamp();

            const row = approveRejectRow(it.rollNo ?? 'unknown', it.email || it.emailAddress);

            await adminChan.send({ embeds: [embed], components: [row] });
        }
    } catch (e) {
        console.error('Pending poll error:', e);
    }
}


function schedulePendingChecker() {
    pollPendingInvitesAndNotify();
    setInterval(pollPendingInvitesAndNotify, PENDING_POLL_MS);
}

// ---------------- Login ----------------
client.login(TOKEN);
