// Theta Tau Onboarding Bot — Single-file (discord.js v14)
// -------------------------------------------------------
// What this file does in a nutshell:
// • On member join: add Pending role, create private verify channel.
// • 3-step modal flow collects profile + links + invitation email.
// • Posts Welcome Card (dark red), re-uploads PFP so it persists, avatar fallback.
// • Removes Pending; auto-assigns role based on Status (Active/Alumni/PNM).
// • Sends Invitation API POST { email, secret } + admin alert embed pinging Admin role.
// • Every 2 hours: GET pending invites; if any, posts an admin report embed.
//
// Setup:
//   npm i discord.js dotenv
//   Node 18+ (uses global fetch)
//   Fill .env as shown in the message above.

import 'dotenv/config';
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
    StringSelectMenuBuilder,
    TextInputBuilder,
    TextInputStyle,
} from 'discord.js';
import { Buffer } from 'node:buffer';

// ------------ ENV ------------
const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const MOD_ROLE_ID = process.env.MOD_ROLE_ID;
const PENDING_ROLE_ID = process.env.PENDING_ROLE_ID;
const CATEGORY_ID = process.env.CATEGORY_ID;
const WELCOME_CARDS_CHANNEL_ID = process.env.WELCOME_CARDS_CHANNEL_ID;

const ACTIVE_ROLE_ID = process.env.ACTIVE_ROLE_ID || '';
const ALUMNI_ROLE_ID = process.env.ALUMNI_ROLE_ID || '';
const PNM_ROLE_ID = process.env.PNM_ROLE_ID || '';

const ADMIN_CHANNEL_ID = process.env.ADMIN_CHANNEL_ID || '';
const ADMIN_ROLE_ID = process.env.ADMIN_ROLE_ID || '';

const INVITE_API_URL = process.env.INVITE_API_URL || '';
const INVITE_API_SECRET = process.env.INVITE_API_SECRET || '';
const PENDING_CHECK_URL = process.env.PENDING_CHECK_URL || '';

if (!TOKEN || !GUILD_ID || !MOD_ROLE_ID || !PENDING_ROLE_ID || !WELCOME_CARDS_CHANNEL_ID) {
    console.error('Missing one or more required env vars. Check .env.');
    process.exit(1);
}

// ------------ Client ------------
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel, Partials.GuildMember, Partials.Message],
});

// In-memory state during verification
const verifyState = new Map(); // userId -> { step, data, channelId, awaitingUpload? }

function channelNameFor(member) {
    const base = member.user.username.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 20);
    return `verify-${base}-${member.user.discriminator ?? member.user.id.slice(-4)}`;
}

async function ensureCategory(guild) {
    if (!CATEGORY_ID) return null;
    return guild.channels.cache.get(CATEGORY_ID) ?? guild.channels.fetch(CATEGORY_ID).catch(() => null);
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

function continueRow(nextStep, userId) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`verify:open:${nextStep}:${userId}`).setStyle(ButtonStyle.Primary)
            .setLabel(nextStep === 'step2' ? 'Continue to Step 2' : 'Continue to Step 3')
    );
}

function reviewRow(userId) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`verify:back:${userId}`).setStyle(ButtonStyle.Secondary).setLabel('Back'),
        new ButtonBuilder().setCustomId(`verify:submit:${userId}`).setStyle(ButtonStyle.Success).setLabel('Submit')
    );
}

// ------------ Modals ------------
function modalStep1(userId) {
    const modal = new ModalBuilder().setCustomId(`verify:step1:${userId}`).setTitle('Step 1 — Basics');
    const name = new TextInputBuilder().setCustomId('fullName').setLabel('Your Full Name').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(64);
    const dob = new TextInputBuilder().setCustomId('dob').setLabel('DOB (YYYY-MM-DD)').setStyle(TextInputStyle.Short).setRequired(true);
    const major = new TextInputBuilder().setCustomId('majors').setLabel('Major(s)').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(200);
    const minor = new TextInputBuilder().setCustomId('minors').setLabel('Minor(s) (or N/A)').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(200);
    const grad = new TextInputBuilder().setCustomId('gradYear').setLabel('Expected Graduation Year').setStyle(TextInputStyle.Short).setRequired(true);
    modal.addComponents(
        new ActionRowBuilder().addComponents(name),
        new ActionRowBuilder().addComponents(dob),
        new ActionRowBuilder().addComponents(major),
        new ActionRowBuilder().addComponents(minor),
        new ActionRowBuilder().addComponents(grad),
    );
    return modal;
}

function modalStep2(userId) {
    const modal = new ModalBuilder().setCustomId(`verify:step2:${userId}`).setTitle('Step 2 — Membership');
    const roll = new TextInputBuilder().setCustomId('rollNumber').setLabel('Roll Number').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(32);
    const status = new TextInputBuilder().setCustomId('status').setLabel('Status (Active / Alumni)').setStyle(TextInputStyle.Short).setRequired(true);
    const family = new TextInputBuilder().setCustomId('familyLine').setLabel('Family Line (Wiley, Rosie, Chi, etc.)').setStyle(TextInputStyle.Short).setRequired(true);
    const instagram = new TextInputBuilder().setCustomId('instagram').setLabel('Instagram @ or URL (or N/A)').setStyle(TextInputStyle.Short).setRequired(false);
    const snapchat = new TextInputBuilder().setCustomId('snapchat').setLabel('Snapchat @ (or N/A)').setStyle(TextInputStyle.Short).setRequired(false);
    modal.addComponents(
        new ActionRowBuilder().addComponents(roll),
        new ActionRowBuilder().addComponents(status),
        new ActionRowBuilder().addComponents(family),
        new ActionRowBuilder().addComponents(instagram),
        new ActionRowBuilder().addComponents(snapchat),
    );
    return modal;
}

function modalStep3(userId) {
    const modal = new ModalBuilder().setCustomId(`verify:step3:${userId}`).setTitle('Step 3 — Links & Photo');
    const linkedin = new TextInputBuilder().setCustomId('linkedin').setLabel('LinkedIn URL (or N/A)').setStyle(TextInputStyle.Short).setRequired(false);
    const github = new TextInputBuilder().setCustomId('github').setLabel('GitHub URL (or N/A)').setStyle(TextInputStyle.Short).setRequired(false);
    const pfp = new TextInputBuilder().setCustomId('pfp').setLabel('Profile Picture URL (or type "upload")').setStyle(TextInputStyle.Short).setRequired(true);
    const confirm = new TextInputBuilder().setCustomId('confirm').setLabel('Type "I confirm" to continue').setStyle(TextInputStyle.Short).setRequired(true);
    const inviteEmail = new TextInputBuilder().setCustomId('inviteEmail').setLabel('Invitation Email (optional)').setStyle(TextInputStyle.Short).setRequired(false);
    modal.addComponents(
        new ActionRowBuilder().addComponents(linkedin),
        new ActionRowBuilder().addComponents(github),
        new ActionRowBuilder().addComponents(pfp),
        new ActionRowBuilder().addComponents(confirm),
        new ActionRowBuilder().addComponents(inviteEmail),
    );
    return modal;
}

// ------------ Welcome Card ------------
function buildWelcomeEmbed(member, data) {
    const color = 0x8c1d40; // Theta Tau dark red
    const e = new EmbedBuilder()
        .setColor(color)
        .setTitle(`${data.fullName}`)
        .setDescription('🎉 New Member Onboarding Card')
        .addFields(
            { name: 'Age', value: calcAgeSafe(data.dob) ?? '—', inline: true },
            { name: 'Year', value: guessYear(data.gradYear) ?? '—', inline: true },
            { name: 'Major(s)', value: data.majors || '—' },
            { name: 'Minor(s)', value: data.minors || '—' },
            { name: 'Birthday', value: data.dob || '—', inline: true },
            { name: 'Family Line', value: data.familyLine || '—', inline: true },
            { name: 'Status', value: data.status || '—', inline: true },
            { name: 'Roll #', value: data.rollNumber || '—', inline: true },
            { name: 'Instagram', value: fmtLink(data.instagram), inline: true },
            { name: 'Snapchat', value: data.snapchat || '—', inline: true },
            { name: 'LinkedIn', value: fmtLink(data.linkedin), inline: true },
            { name: 'GitHub', value: fmtLink(data.github), inline: true },
        )
        .setFooter({ text: `Expected Graduation: ${data.gradYear || '—'}` })
        .setTimestamp();
    return e; // thumbnail set at send-time
}

function fmtLink(v) {
    if (!v) return '—';
    if (String(v).toLowerCase() === 'n/a') return '—';
    if (/^https?:\/\//i.test(v)) return v;
    if (v.startsWith('@')) return v;
    return v;
}

function calcAgeSafe(dobStr) {
    try {
        const d = new Date(dobStr);
        if (isNaN(d)) return null;
        const diff = Date.now() - d.getTime();
        const age = Math.floor(diff / (365.25 * 24 * 3600 * 1000));
        return String(age);
    } catch { return null; }
}

function guessYear(gradYear) {
    const y = parseInt(gradYear, 10);
    if (!isNaN(y)) return `Class of ${y}`;
    return null;
}

function resolveStatusRoleId(status) {
    if (!status) return null;
    const s = String(status).toLowerCase().trim();
    if (/(^|\b)alum(|ni|nus)?(\b|$)/.test(s)) return ALUMNI_ROLE_ID || null;
    if (/(^|\b)active(\b|$)/.test(s)) return ACTIVE_ROLE_ID || null;
    if (/(^|\b)(pnm|interest|prospect|new|pledge)(\b|$)/.test(s)) return PNM_ROLE_ID || null;
    return null;
}

// ------------ Onboarding DM ------------
async function sendOnboarding(member) {
    const info = new EmbedBuilder()
        .setColor(0x8c1d40)
        .setTitle('Welcome! Here’s how to get set up')
        .setDescription([
            '• **Pick your roles below** to unlock relevant channels.',
            '• **Discord**: quick chats, announcements, events, family channels.',
            '• **Google Drive**: bylaws, meeting slides, docs, historical resources.',
            '• Pinned messages often have links to forms, sign-ups, and FAQs.',
        ].join('\n'));
    await member.send({ content: 'Welcome to the server! 🎉', embeds: [info] }).catch(() => { });
}

// ------------ Invitations API helpers ------------
function isValidEmail(s) {
    if (!s) return false;
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s).trim());
}

async function sendInvitationAndNotifyAdmin(email, guild, member) {
    if (!INVITE_API_URL || !isValidEmail(email)) return null;

    let ok = false;
    let payload = null;
    try {
        const res = await fetch(INVITE_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, secret: INVITE_API_SECRET }),
        });
        payload = await res.json().catch(() => ({}));
        ok = res.ok;
    } catch (e) {
        payload = { error: String(e) };
        ok = false;
    }

    try {
        if (!ADMIN_CHANNEL_ID) return { ok, payload };
        const adminChan = await guild.channels.fetch(ADMIN_CHANNEL_ID).catch(() => null);
        if (!adminChan) return { ok, payload };

        const title = ok ? '🎟️ Invitation Created' : '⚠️ Invitation Failed';
        const color = ok ? 0x22c55e : 0xe11d48;

        const fields = [];
        if (payload?.id) fields.push({ name: 'ID', value: String(payload.id), inline: false });
        if (payload?.emailAddress || email) fields.push({ name: 'Email', value: String(payload?.emailAddress || email), inline: true });
        if (payload?.status) fields.push({ name: 'Status', value: String(payload.status), inline: true });
        if (payload?.createdAt) fields.push({ name: 'Created', value: new Date(Number(payload.createdAt)).toLocaleString(), inline: true });
        if (payload?.updatedAt) fields.push({ name: 'Updated', value: new Date(Number(payload.updatedAt)).toLocaleString(), inline: true });
        if (payload?.publicMetadata && Object.keys(payload.publicMetadata).length) {
            fields.push({ name: 'Metadata', value: '```json\n' + JSON.stringify(payload.publicMetadata, null, 2) + '\n```' });
        }
        if (payload?.error && !ok) fields.push({ name: 'Error', value: String(payload.error) });

        const embed = new EmbedBuilder()
            .setColor(color)
            .setTitle(title)
            .setDescription(member ? `User: <@${member.id}>` : undefined)
            .addFields(fields)
            .setTimestamp();

        const mention = ADMIN_ROLE_ID ? `<@&${ADMIN_ROLE_ID}>` : '';
        await adminChan.send({
            content: `${mention} ${ok ? 'New person has received an invitation.' : 'Invitation attempt reported.'}`.trim(),
            embeds: [embed],
        });
    } catch { }

    return { ok, payload };
}

function buildPendingCheckUrl() {
    try {
        if (PENDING_CHECK_URL) {
            const u = new URL(PENDING_CHECK_URL);
            if (INVITE_API_SECRET) u.searchParams.set('secret', INVITE_API_SECRET);
            return u.toString();
        }
        if (!INVITE_API_URL) return '';
        const u = new URL(INVITE_API_URL);
        u.pathname = '/api/members/pending';
        if (INVITE_API_SECRET) u.searchParams.set('secret', INVITE_API_SECRET);
        return u.toString();
    } catch { return ''; }
}

async function pollPendingInvitesAndNotify() {
    try {
        const url = buildPendingCheckUrl();
        if (!url || !ADMIN_CHANNEL_ID) return;

        const res = await fetch(url);
        let data = null;
        try { data = await res.json(); } catch { data = null; }

        // Flexible shapes: array | {data: []} | {list: []} | number
        let count = 0;
        let items = [];
        if (Array.isArray(data)) { count = data.length; items = data; }
        else if (data && Array.isArray(data.data)) { count = data.data.length; items = data.data; }
        else if (data && Array.isArray(data.list)) { count = data.list.length; items = data.list; }
        else if (typeof data === 'number') { count = data; }

        if (count > 0) {
            const guild = await client.guilds.fetch(GUILD_ID);
            const chan = await guild.channels.fetch(ADMIN_CHANNEL_ID).catch(() => null);
            if (!chan) return;

            const embed = new EmbedBuilder()
                .setColor(0xffc627)
                .setTitle('⏰ Pending Invitations Check')
                .setDescription(`There ${count === 1 ? 'is' : 'are'} **${count}** pending invitation${count === 1 ? '' : 's'}.`)
                .addFields(
                    items.slice(0, 10).map((it, i) => ({
                        name: `#${i + 1}`,
                        value: formatPendingItem(it),
                        inline: false
                    }))
                )
                .setTimestamp();


            const mention = ADMIN_ROLE_ID ? `<@&${ADMIN_ROLE_ID}>` : '';
            await chan.send({ content: `${mention} Pending invitation report`, embeds: [embed] });
        }
    } catch (e) {
        console.error('Pending poll error:', e);
    }
}

function formatPendingItem(it) {
    if (typeof it === 'string') return it;

    const name = [it.fName, it.lName].filter(Boolean).join(' ') || '—';
    const roll = it.rollNo ?? '—';
    const year = it.gradYear ?? '—';
    const status = it.status ?? '—';
    const email = it.email || it.emailAddress || (it.user && it.user.email) || '—';
    const majors = Array.isArray(it.majors) ? it.majors.join(', ') : (it.major || '—');
    const family = it.familyLine || '—';
    const hometown = it.hometown || '';
    const submitted = it.submittedAt || it.createdAt || it.updatedAt;
    const submittedStr = submitted ? new Date(submitted).toLocaleString() : '—';
    const id = it._id || it.id || '—';

    return [
        `**Name:** ${name}`,
        `**Roll #:** ${roll} | **Year:** ${year}`,
        `**Status:** ${status}`,
        `**Email:** ${email}`,
        `**Majors:** ${majors}`,
        `**Family:** ${family}${hometown ? ` | **Hometown:** ${hometown}` : ''}`,
        `Submitted: ${submittedStr}`,
        `ID: \`${id}\``,
    ].join('\n');
}


function schedulePendingChecker() {
    // run once on boot, then every 2 hours
    pollPendingInvitesAndNotify();
    setInterval(pollPendingInvitesAndNotify, 10_000); // 10s

}

// ------------ Events ------------
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
            .setColor(0xffc627)
            .setTitle('Welcome! Let’s get you verified')
            .setDescription('Click **Get Started** to fill out a short form. Mods can help if you get stuck.');

        await channel.send({
            content: `<@${member.id}>`,
            embeds: [intro],
            components: [getStartedRow(member.id)],
        });

        verifyState.set(member.id, { step: 0, data: {}, channelId: channel.id });
    } catch (err) {
        console.error('Error in GuildMemberAdd:', err);
    }
});

client.on(Events.InteractionCreate, async (interaction) => {
    try {
        if (interaction.isButton()) {
            const parts = interaction.customId.split(':');
            const ns = parts[0];
            const action = parts[1];

            if (ns === 'verify') {
                if (action === 'start') {
                    const userId = parts[2];
                    if (userId !== interaction.user.id)
                        return interaction.reply({ content: 'This button is not for you.', ephemeral: true });
                    await interaction.showModal(modalStep1(userId));
                    return;
                }

                if (action === 'back') {
                    const userId = parts[2];
                    if (userId !== interaction.user.id)
                        return interaction.reply({ content: 'This button is not for you.', ephemeral: true });
                    return interaction.reply({ content: 'Use the **Continue** button below to reopen the previous step.', ephemeral: true });
                }

                if (action === 'open') {
                    const step = parts[2];
                    const userId = parts[3];
                    if (userId !== interaction.user.id)
                        return interaction.reply({ content: 'This button is not for you.', ephemeral: true });
                    if (step === 'step2') return interaction.showModal(modalStep2(userId));
                    if (step === 'step3') return interaction.showModal(modalStep3(userId));
                    return;
                }

                if (action === 'submit') {
                    const userId = parts[2];
                    if (userId !== interaction.user.id)
                        return interaction.reply({ content: 'This button is not for you.', ephemeral: true });

                    const state = verifyState.get(userId);
                    if (!state || !state.data || !state.data.fullName)
                        return interaction.reply({ content: 'Your session expired. Click **Get Started** again.', ephemeral: true });

                    // prevent 3s timeout
                    await interaction.deferReply({ ephemeral: true }).catch(() => { });

                    const guild = interaction.guild ?? (await client.guilds.fetch(GUILD_ID));
                    const welcomeChan = await guild.channels.fetch(WELCOME_CARDS_CHANNEL_ID);
                    const member = await guild.members.fetch(userId);

                    const embed = buildWelcomeEmbed(member, state.data);

                    // PFP: try buffer reupload; fallback to avatar
                    let files = [];
                    let thumbnailSet = false;
                    const rawUrl = state.data.pfpUrl && state.data.pfpUrl.trim();
                    if (rawUrl && rawUrl.toLowerCase() !== 'n/a' && /^https?:\/\//i.test(rawUrl)) {
                        try {
                            const res = await fetch(rawUrl);
                            if (res.ok) {
                                const buf = Buffer.from(await res.arrayBuffer());
                                files = [{ attachment: buf, name: 'pfp.png' }];
                                embed.setThumbnail('attachment://pfp.png');
                                thumbnailSet = true;
                            }
                        } catch { }
                    }
                    if (!thumbnailSet) {
                        embed.setThumbnail(member.user.displayAvatarURL({ extension: 'png', size: 256 }));
                    }

                    await welcomeChan.send({ embeds: [embed], files });

                    await member.roles.remove(PENDING_ROLE_ID).catch(() => { });
                    const statusRoleId = resolveStatusRoleId(state.data.status);
                    if (statusRoleId) await member.roles.add(statusRoleId).catch(() => { });

                    // Invitation API (optional)
                    if (state.data.inviteEmail && isValidEmail(state.data.inviteEmail)) {
                        await sendInvitationAndNotifyAdmin(state.data.inviteEmail, guild, member);
                    }

                    await interaction.editReply({ content: 'Submitted! 🎉 Check DMs for onboarding and enjoy the server!' });
                    await sendOnboarding(member);

                    // delete temp channel after 10s
                    setTimeout(async () => {
                        try {
                            const tmp = await guild.channels.fetch(state.channelId).catch(() => null);
                            if (tmp) await tmp.delete('Verification completed');
                        } catch { }
                    }, 10_000);

                    verifyState.delete(userId);
                    return;
                }
            }
        }

        if (interaction.isStringSelectMenu()) {
            const [ns, action, userId] = interaction.customId.split(':');
            if (ns === 'roles' && action === 'pick') {
                if (userId !== interaction.user.id)
                    return interaction.reply({ content: 'This menu is not for you.', ephemeral: true });

                // map select values to your real role IDs (optional/unused by default)
                const roleMap = new Map([
                    ['role_active', ACTIVE_ROLE_ID],
                    ['role_alumni', ALUMNI_ROLE_ID],
                    ['role_pnm', PNM_ROLE_ID],
                ]);

                const member = await interaction.guild.members.fetch(userId);
                const desired = new Set(interaction.values);
                for (const [key, roleId] of roleMap) {
                    if (!roleId) continue;
                    if (desired.has(key)) await member.roles.add(roleId).catch(() => { });
                    else await member.roles.remove(roleId).catch(() => { });
                }
                await interaction.reply({ content: 'Roles updated!', ephemeral: true });
                return;
            }
        }
    } catch (err) {
        console.error('Interaction error:', err);
        if (interaction.isRepliable()) {
            try { await interaction.reply({ content: 'Something went wrong. Please try again.', ephemeral: true }); } catch { }
        }
    }
});

client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isModalSubmit()) return;
    try {
        const [ns, step, userId] = interaction.customId.split(':');
        if (ns !== 'verify' || userId !== interaction.user.id) return;

        const state = verifyState.get(userId) ?? { data: {}, step: 0 };

        if (step === 'step1') {
            state.data.fullName = interaction.fields.getTextInputValue('fullName').trim();
            state.data.dob = interaction.fields.getTextInputValue('dob').trim();
            state.data.majors = interaction.fields.getTextInputValue('majors').trim();
            state.data.minors = interaction.fields.getTextInputValue('minors').trim();
            state.data.gradYear = interaction.fields.getTextInputValue('gradYear').trim();
            state.step = 1;
            verifyState.set(userId, state);
            await interaction.reply({ content: 'Got it! Click below to continue to Step 2.', components: [continueRow('step2', userId)], ephemeral: true });
            return;
        }

        if (step === 'step2') {
            state.data.rollNumber = interaction.fields.getTextInputValue('rollNumber').trim();
            state.data.status = interaction.fields.getTextInputValue('status').trim();
            state.data.familyLine = interaction.fields.getTextInputValue('familyLine').trim();
            state.data.instagram = interaction.fields.getTextInputValue('instagram').trim();
            state.data.snapchat = interaction.fields.getTextInputValue('snapchat').trim();
            state.step = 2;
            verifyState.set(userId, state);
            await interaction.reply({ content: 'Great! Click below to open the final step.', components: [continueRow('step3', userId)], ephemeral: true });
            return;
        }

        if (step === 'step3') {
            const confirm = interaction.fields.getTextInputValue('confirm').trim().toLowerCase();
            if (confirm !== 'i confirm') {
                return interaction.reply({ content: 'Please type **I confirm** to continue.', ephemeral: true });
            }
            state.data.linkedin = interaction.fields.getTextInputValue('linkedin').trim();
            state.data.github = interaction.fields.getTextInputValue('github').trim();
            const pfp = interaction.fields.getTextInputValue('pfp').trim();
            state.data.inviteEmail = interaction.fields.getTextInputValue('inviteEmail').trim();

            if (pfp.toLowerCase() === 'upload') {
                state.awaitingUpload = true;
                verifyState.set(userId, state);
                await interaction.reply({ content: 'Please upload your profile picture **as the next message** in this channel.', ephemeral: true });
            } else {
                state.data.pfpUrl = pfp;
                verifyState.set(userId, state);
                await interaction.reply({ content: 'Almost done! Review message posted below.', ephemeral: true });
                await showReview(interaction, state.data);
            }
            return;
        }
    } catch (err) {
        console.error('Modal error:', err);
        try { await interaction.reply({ content: 'Something went wrong with the form. Try again.', ephemeral: true }); } catch { }
    }
});

async function showReview(interaction, data) {
    const review = new EmbedBuilder()
        .setColor(0x22c55e)
        .setTitle('Review your info')
        .setDescription('Look everything over. If it looks good, click **Submit**!')
        .addFields(
            { name: 'Name', value: data.fullName },
            { name: 'DOB', value: data.dob },
            { name: 'Major(s)', value: data.majors },
            { name: 'Minor(s)', value: data.minors },
            { name: 'Grad Year', value: data.gradYear },
            { name: 'Roll #', value: data.rollNumber },
            { name: 'Status', value: data.status },
            { name: 'Family Line', value: data.familyLine },
            { name: 'Instagram', value: data.instagram || '—' },
            { name: 'Snapchat', value: data.snapchat || '—' },
            { name: 'LinkedIn', value: data.linkedin || '—' },
            { name: 'GitHub', value: data.github || '—' },
            { name: 'Invitation Email', value: data.inviteEmail || '—' },
        );
    if (data.pfpUrl) review.setThumbnail(data.pfpUrl);
    await interaction.channel.send({ content: `<@${interaction.user.id}>`, embeds: [review], components: [reviewRow(interaction.user.id)] });
}

// Accept one attachment as the profile picture when awaitingUpload=true
client.on(Events.MessageCreate, async (msg) => {
    try {
        if (!msg.guild || msg.author.bot) return;
        const state = verifyState.get(msg.author.id);
        if (!state || !state.awaitingUpload) return;
        if (msg.channel.id !== state.channelId) return;

        const attach = msg.attachments.first();
        if (!attach) return;

        state.data.pfpUrl = attach.url;
        state.awaitingUpload = false;
        verifyState.set(msg.author.id, state);

        await msg.reply('Thanks! Got your profile picture.');
        await showReview({ channel: msg.channel, user: msg.author }, state.data);
    } catch (err) {
        console.error('Attachment catch error:', err);
    }
});

client.login(TOKEN);
