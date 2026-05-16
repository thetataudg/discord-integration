// index.mjs
import 'dotenv/config';
import axios from 'axios';
import https from 'node:https';
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
    RoleSelectMenuBuilder,
    TextInputBuilder,
    TextInputStyle,
} from 'discord.js';
import { Buffer } from 'node:buffer';
import {
    initStore,
    rememberEmail,
    getByEmail,
    getByPendingId,
    getByDbId,
    linkPendingToInvite,
    findRecentInviteMapping,
    rememberCommitteeMapping,
    getAllCommitteeMappings,
    removeCommitteeMapping,
    getCommitteeRoleIds,
    rememberStatusMapping,
    getAllStatusMappings,
    removeStatusMapping,
    rememberEcouncilRole,
    getEcouncilRoleId,
    removeEcouncilRole,
    getManagedRoleIds,
    rememberDbId,
    markBootstrapCompleted,
    isBootstrapCompleted,
    getStatusRoleId,
} from './store.js';

// ---------------- ENV ----------------
const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const MOD_ROLE_ID = process.env.MOD_ROLE_ID; // who can see verify channels
const ADMIN_ROLE_ID = process.env.ADMIN_ROLE_ID || '';
const PENDING_ROLE_ID = process.env.PENDING_ROLE_ID;
const ECOUNCIL_ROLE_ID = process.env.ECOUNCIL_ROLE_ID || '';
const CATEGORY_ID = process.env.CATEGORY_ID || '';
const WELCOME_CARDS_CHANNEL_ID = process.env.WELCOME_CARDS_CHANNEL_ID;

const APPROVAL_API_SECRET = process.env.APPROVAL_API_SECRET || '';
const INVITE_API_URL = process.env.INVITE_API_URL || '';
const INVITE_API_SECRET = process.env.INVITE_API_SECRET || '';
const PENDING_CHECK_URL = process.env.PENDING_CHECK_URL || '';
const APPROVAL_API_BASE =
    process.env.APPROVAL_API_BASE || 'https://thetatau-dg.org/api/members/pending';
const MEMBERS_API_URL =
    process.env.MEMBERS_API_URL || 'https://thetatau-dg.org/api/members';
const PENDING_POLL_MS = parseInt(process.env.PENDING_POLL_MS || '1800000', 10);
const ROLE_SYNC_INTERVAL_MS = parseInt(process.env.ROLE_SYNC_INTERVAL_MS || '3600000', 10);

// New/optional envs
// Optional role defaults. The store-backed role-map command is the source of truth,
// but these defaults remain available as fallbacks for legacy deployments.
const DEFAULT_VERIFIED_ROLE_ID = process.env.DEFAULT_VERIFIED_ROLE_ID || '';
const DELETE_VERIFY_CHANNEL_AFTER_MS = parseInt(
    process.env.DELETE_VERIFY_CHANNEL_AFTER_MS || '15000',
    10
);
const RULES_CHANNEL_ID = process.env.RULES_CHANNEL_ID || '';
const VERIFY_CHANNEL_ID = process.env.VERIFY_CHANNEL_ID || '';
const INFO_CHANNEL_ID = process.env.INFO_CHANNEL_ID || '';
const GENERAL_CHANNEL_ID = process.env.GENERAL_CHANNEL_ID || '';
const WELCOME_BANNER_URL = process.env.WELCOME_BANNER_URL || '';

const STEP_IMAGE_1 = process.env.STEP_IMAGE_1 || '';
const STEP_IMAGE_2 = process.env.STEP_IMAGE_2 || '';
const STEP_IMAGE_3 = process.env.STEP_IMAGE_3 || '';

if (
    !TOKEN ||
    !GUILD_ID ||
    !MOD_ROLE_ID ||
    !PENDING_ROLE_ID ||
    !WELCOME_CARDS_CHANNEL_ID ||
    !INVITE_API_URL ||
    !APPROVAL_API_SECRET
) {
    console.error('Missing required env vars. Check the header comments.');
    process.exit(1);
}

// -------------- HTTP agent (optional keep-alive) --------------
const httpsAgent = new https.Agent({ keepAlive: true });

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

// -------------- In-memory state --------------
const awaitingPfp = new Map(); // userId -> { apiMember, channelId }
const committeeMapSessions = new Map(); // sessionId -> { userId, kind, items, index }
let lastPendingDigest = '';
let roleSyncInProgress = false;

// -------------- Helpers --------------
const THEME_RED = 0x8c1d40; // Theta Tau dark red
const THEME_GOLD = 0xffc627;

function mask(s) {
    if (!s) return '(empty)';
    return s.replace(/.(?=.{4})/g, '•');
}
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
    return (
        guild.channels.cache.get(CATEGORY_ID) ||
        (await guild.channels.fetch(CATEGORY_ID).catch(() => null))
    );
}
async function createPrivateChannel(member) {
    const guild = member.guild;
    const category = await ensureCategory(guild);
    const name = channelNameFor(member);

    const overwrites = [
        { id: guild.roles.everyone, deny: [PermissionsBitField.Flags.ViewChannel] },
        {
            id: member.id,
            allow: [
                PermissionsBitField.Flags.ViewChannel,
                PermissionsBitField.Flags.SendMessages,
                PermissionsBitField.Flags.ReadMessageHistory,
                PermissionsBitField.Flags.AttachFiles,
            ],
        },
        {
            id: MOD_ROLE_ID,
            allow: [
                PermissionsBitField.Flags.ViewChannel,
                PermissionsBitField.Flags.SendMessages,
                PermissionsBitField.Flags.ReadMessageHistory,
            ],
        },
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
        new ButtonBuilder()
            .setCustomId(`verify:start:${userId}`)
            .setStyle(ButtonStyle.Primary)
            .setLabel('Get Started')
    );
}

// Buttons carry DB id (pending/user id), not rollNo
function approveRejectRow(userId, email) {
    const safeId = String(userId || 'unknown');
    const safeEmail = email && String(email).trim() ? String(email).trim() : 'none';
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`pending:approve:${safeId}:${safeEmail}`)
            .setStyle(ButtonStyle.Success)
            .setLabel('Approve'),
        new ButtonBuilder()
            .setCustomId(`pending:reject:${safeId}:${safeEmail}`)
            .setStyle(ButtonStyle.Danger)
            .setLabel('Reject')
    );
}
function approveRejectRowDisabled(userId, email) {
    const safeId = String(userId || 'unknown');
    const safeEmail = email && String(email).trim() ? String(email).trim() : 'none';
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`pending:approve:${safeId}:${safeEmail}`)
            .setStyle(ButtonStyle.Success)
            .setLabel('Approve')
            .setDisabled(true),
        new ButtonBuilder()
            .setCustomId(`pending:reject:${safeId}:${safeEmail}`)
            .setStyle(ButtonStyle.Danger)
            .setLabel('Reject')
            .setDisabled(true)
    );
}

function committeeMappingSummaryLines() {
    const mappings = getAllCommitteeMappings();
    return Object.entries(mappings)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([committee, roleId]) => `• Committee: ${committee} -> <@&${roleId}>`);
}

function statusMappingSummaryLines() {
    const mappings = getAllStatusMappings();
    return Object.entries(mappings)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([status, roleId]) => `• Status: ${status} -> <@&${roleId}>`);
}

function ecouncilMappingSummaryLines() {
    const roleId = getEcouncilRoleId();
    return roleId ? [`• ECouncil -> <@&${roleId}>`] : [];
}

function allManagedMappingLines() {
    return [
        ...committeeMappingSummaryLines(),
        ...statusMappingSummaryLines(),
        ...ecouncilMappingSummaryLines(),
    ];
}

function chunkLines(lines, maxChars = 900) {
    const chunks = [];
    let current = [];
    let currentLength = 0;
    for (const line of lines) {
        const lineLength = line.length + 1;
        if (current.length && currentLength + lineLength > maxChars) {
            chunks.push(current.join('\n'));
            current = [line];
            currentLength = lineLength;
        } else {
            current.push(line);
            currentLength += lineLength;
        }
    }
    if (current.length) chunks.push(current.join('\n'));
    return chunks;
}

function hasManagePermission(member) {
    return Boolean(
        member &&
            (member.permissions?.has(PermissionsBitField.Flags.ManageGuild) ||
                (ADMIN_ROLE_ID && member.roles?.cache?.has(ADMIN_ROLE_ID)))
    );
}

function mappingKindLabel(kind) {
    if (kind === 'status') return 'status';
    if (kind === 'ecouncil') return 'ECouncil';
    return 'committee';
}

function mappingItemsForKind(kind, members = []) {
    if (kind === 'committee') return [];
    if (kind === 'status') {
        const statuses = new Set();
        for (const member of members) {
            const status = String(member?.status || '').trim();
            if (status) statuses.add(status);
        }
        return [...statuses].sort((a, b) => a.localeCompare(b));
    }
    if (kind === 'ecouncil') return ['ECouncil'];
    return [];
}

function sessionTitleForKind(kind) {
    if (kind === 'status') return 'Status Role Mapping';
    if (kind === 'ecouncil') return 'ECouncil Role Mapping';
    return 'Committee Role Mapping';
}

function itemLabelForKind(kind, item) {
    if (kind === 'status') return `status **${item}**`;
    if (kind === 'ecouncil') return 'ECouncil';
    return `committee **${item}**`;
}

function buildMappingSummaryEmbed() {
    const lines = allManagedMappingLines();
    return new EmbedBuilder()
        .setColor(THEME_GOLD)
        .setTitle('Current Role Mappings')
        .setDescription(lines.length ? lines.join('\n') : 'No role mappings have been saved yet.');
}

async function fetchCommitteeAssignmentsForRollNo(rollNo) {
    const url = `https://thetatau-dg.org/api/committees/public-member/${encodeURIComponent(String(rollNo))}`;
    const res = await fetch(url);
    let data = null;
    try {
        data = await res.json();
    } catch {
        data = null;
    }
    return {
        headCommittees: Array.isArray(data?.headCommittees) ? data.headCommittees : [],
        memberCommittees: Array.isArray(data?.memberCommittees) ? data.memberCommittees : [],
    };
}

async function fetchMembersApi() {
    const res = await fetch(MEMBERS_API_URL).catch(() => null);
    if (!res) return [];
    let data = null;
    try {
        data = await res.json();
    } catch {
        data = null;
    }
    return Array.isArray(data) ? data : data?.data || [];
}

function normalizeCommitteeSet(values) {
    return new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean));
}

async function discoverCommitteeNamesFromMembers() {
    const members = await fetchMembersApi();
    const activeMembers = members.filter((member) => String(member.status || '').toLowerCase() === 'active');
    const collected = new Set();

    await Promise.all(
        activeMembers
            .filter((member) => member.rollNo !== undefined && member.rollNo !== null && String(member.rollNo).trim() !== '')
            .map(async (member) => {
                const payload = await fetchCommitteeAssignmentsForRollNo(member.rollNo).catch(() => null);
                for (const committee of [...(payload?.headCommittees || []), ...(payload?.memberCommittees || [])]) {
                    const name = String(committee || '').trim();
                    if (name) collected.add(name);
                }
            })
    );

    return [...collected].sort((a, b) => a.localeCompare(b));
}

async function discoverStatusNamesFromMembers() {
    const members = await fetchMembersApi();
    return [...new Set(members.map((member) => String(member.status || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function buildMappingSessionEmbed(session) {
    const current = session.items[session.index];
    return new EmbedBuilder()
        .setColor(THEME_GOLD)
        .setTitle(sessionTitleForKind(session.kind))
        .setDescription(
            current
                ? [
                      `Map ${itemLabelForKind(session.kind, current)} to an existing Discord role.`,
                      '',
                      `Progress: ${session.index + 1}/${session.items.length}`,
                  ].join('\n')
                : `No ${mappingKindLabel(session.kind)} values left to map.`
        )
        .setFooter({ text: 'Select a role, skip this item, or finish the session.' });
}

function buildMappingSessionComponents(sessionId, session) {
    const current = session.items[session.index];
    if (!current) return [];
    return [
        new ActionRowBuilder().addComponents(
            new RoleSelectMenuBuilder()
                .setCustomId(`role-map:role:${sessionId}`)
                .setPlaceholder(`Select a role for ${current}`)
                .setMinValues(1)
                .setMaxValues(1)
        ),
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`role-map:skip:${sessionId}`)
                .setStyle(ButtonStyle.Secondary)
                .setLabel('Skip'),
            new ButtonBuilder()
                .setCustomId(`role-map:done:${sessionId}`)
                .setStyle(ButtonStyle.Primary)
                .setLabel('Finish')
        ),
    ];
}

function finishMappingSession(sessionId) {
    committeeMapSessions.delete(sessionId);
}

async function renderMappingSession(interaction, sessionId) {
    const session = committeeMapSessions.get(sessionId);
    if (!session) {
        return interaction.update({ content: 'This mapping session has ended.', components: [], embeds: [] });
    }

    const current = session.items[session.index];
    if (!current) {
        finishMappingSession(sessionId);
        return interaction.update({
            content: `${mappingKindLabel(session.kind)} mapping session finished.`,
            embeds: [],
            components: [],
        });
    }

    return interaction.update({
        content: undefined,
        embeds: [buildMappingSessionEmbed(session)],
        components: buildMappingSessionComponents(sessionId, session),
    });
}

async function startMappingSession(interaction, kind) {
    if (!hasManagePermission(interaction.member)) {
        return interaction.reply({ content: 'You lack permission to do this.', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });
    let items = [];
    if (kind === 'committee') {
        const discovered = await discoverCommitteeNamesFromMembers();
        const mapped = new Set(Object.keys(getAllCommitteeMappings()));
        items = discovered.filter((name) => !mapped.has(name));
    } else if (kind === 'status') {
        const discovered = await discoverStatusNamesFromMembers();
        const mapped = new Set(Object.keys(getAllStatusMappings()));
        items = discovered.filter((name) => !mapped.has(name));
    } else if (kind === 'ecouncil') {
        items = getEcouncilRoleId() ? [] : ['ECouncil'];
    }

    if (!items.length) {
        return interaction.editReply(`All discovered ${mappingKindLabel(kind)} values are already mapped.`);
    }

    const sessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    committeeMapSessions.set(sessionId, {
        userId: interaction.user.id,
        kind,
        items,
        index: 0,
    });

    await interaction.editReply({
        content: 'Use the controls below to map role bindings.',
        embeds: [buildMappingSessionEmbed(committeeMapSessions.get(sessionId))],
        components: buildMappingSessionComponents(sessionId, committeeMapSessions.get(sessionId)),
    });
}

async function handleRoleMapList(interaction) {
    if (!hasManagePermission(interaction.member)) {
        return interaction.reply({ content: 'You lack permission to do this.', ephemeral: true });
    }

    const lines = allManagedMappingLines();
    if (!lines.length) {
        return interaction.reply({ content: 'No role mappings have been saved yet.', ephemeral: true });
    }

    const embeds = chunkLines(lines).map((chunk, index) =>
        new EmbedBuilder()
            .setColor(THEME_GOLD)
            .setTitle(index === 0 ? 'Current Role Mappings' : 'Current Role Mappings Continued')
            .setDescription(chunk)
    );

    return interaction.reply({ embeds, ephemeral: true });
}

async function handleRoleMapRemove(interaction) {
    if (!hasManagePermission(interaction.member)) {
        return interaction.reply({ content: 'You lack permission to do this.', ephemeral: true });
    }

    const name = interaction.options.getString('name', true).trim();
    const committeeRemoved = removeCommitteeMapping(name);
    const statusRemoved = removeStatusMapping(name);
    const ecouncilRemoved = name.toLowerCase() === 'ecouncil' ? removeEcouncilRole() : false;
    const removed = committeeRemoved || statusRemoved || ecouncilRemoved;

    return interaction.reply({
        content: removed ? `Removed the mapping for **${name}**.` : `No mapping was found for **${name}**.`,
        ephemeral: true,
    });
}

async function handleRoleMapCommand(interaction) {
    const subcommand = interaction.options.getSubcommand(false);
    if (!subcommand || subcommand === 'committee' || subcommand === 'map') return startMappingSession(interaction, 'committee');
    if (subcommand === 'status') return startMappingSession(interaction, 'status');
    if (subcommand === 'ecouncil') return startMappingSession(interaction, 'ecouncil');
    if (subcommand === 'list') return handleRoleMapList(interaction);
    if (subcommand === 'remove') return handleRoleMapRemove(interaction);
}

function emailModal(userId) {
    const modal = new ModalBuilder().setCustomId(`verify:email:${userId}`).setTitle('Start Verification');
    const email = new TextInputBuilder()
        .setCustomId('email')
        .setLabel('School/Chapter Email')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder('you@example.edu');
    modal.addComponents(new ActionRowBuilder().addComponents(email));
    return modal;
}

function stepsEmbeds() {
    const blocks = [];
    if (STEP_IMAGE_1) {
        blocks.push(
            new EmbedBuilder()
                .setColor(THEME_GOLD)
                .setTitle('Step 1 - Check your email')
                .setDescription('We sent you an invitation to register.')
                .setImage(STEP_IMAGE_1)
        );
    }
    if (STEP_IMAGE_2) {
        blocks.push(
            new EmbedBuilder()
                .setColor(THEME_GOLD)
                .setTitle('Step 2 - Complete registration')
                .setDescription('Fill out your basic details on the site.')
                .setImage(STEP_IMAGE_2)
        );
    }
    if (STEP_IMAGE_3) {
        blocks.push(
            new EmbedBuilder()
                .setColor(THEME_GOLD)
                .setTitle('Step 3 - Wait for admin approval')
                .setDescription('Once approved, come back here to upload your profile picture.')
                .setImage(STEP_IMAGE_3)
        );
    }
    return blocks;
}

function buildInviteAdminEmbed(email, payload, ok, member) {
    const fields = [];
    if (payload?.id || payload?._id)
        fields.push({ name: 'ID', value: String(payload.id || payload._id), inline: false });
    if (payload?.emailAddress || email)
        fields.push({ name: 'Email', value: String(payload?.emailAddress || email), inline: true });
    if (payload?.status) fields.push({ name: 'Status', value: String(payload.status), inline: true });
    if (payload?.createdAt)
        fields.push({
            name: 'Created',
            value: new Date(Number(payload.createdAt) || Date.parse(payload.createdAt)).toLocaleString(),
            inline: true,
        });
    if (payload?.updatedAt)
        fields.push({
            name: 'Updated',
            value: new Date(Number(payload.updatedAt) || Date.parse(payload.updatedAt)).toLocaleString(),
            inline: true,
        });

    return new EmbedBuilder()
        .setColor(ok ? 0x22c55e : 0xe11d48)
        .setTitle(ok ? '🎟️ Invitation Created' : '⚠️ Invitation Failed')
        .setDescription(member ? `User: <@${member.id}>` : undefined)
        .addFields(fields)
        .setTimestamp();
}

function formatPendingItem(it) {
    if (typeof it === 'string') return it;
    const name = [it.fName, it.lName].filter(Boolean).join(' ') || '-';
    const roll = it.rollNo ?? it.rollNumber ?? '-';
    const year = it.gradYear ?? '-';
    const status = it.status ?? 'pending';
    const email = it.email || it.emailAddress || (it.user && it.user.email) || '-';
    const majors = Array.isArray(it.majors) ? it.majors.join(', ') : it.major || '-';
    const family = it.familyLine || '-';
    const submitted = it.submittedAt || it.createdAt || it.updatedAt;
    const submittedStr = submitted ? new Date(submitted).toLocaleString() : '-';
    const id = it._id || it.id || '-';
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

// Friendlier welcome embed
function buildWelcomeEmbedFromApi(member, api) {
    const fullName =
        [api.fName, api.lName].filter(Boolean).join(' ') ||
        member.user.globalName ||
        member.user.username;

    const rulesCh = RULES_CHANNEL_ID ? `<#${RULES_CHANNEL_ID}>` : '#rules';
    const verifyCh = VERIFY_CHANNEL_ID ? `<#${VERIFY_CHANNEL_ID}>` : '#verify';
    const infoCh = INFO_CHANNEL_ID ? `<#${INFO_CHANNEL_ID}>` : '';
    const generalCh = GENERAL_CHANNEL_ID ? `<#${GENERAL_CHANNEL_ID}>` : '#general';

    const majorsStr = Array.isArray(api.majors) ? api.majors.join(', ') : api.major || '-';

    const e = new EmbedBuilder()
        .setColor(THEME_RED)
        .setAuthor({
            name: `Welcome to ${member.guild.name}!`,
            iconURL: member.guild.iconURL({ size: 256 }) ?? undefined,
        })
        .setTitle(`✨ Welcome, ${fullName}!`)
        .setDescription(
            [
                `Hey <@${member.id}> - we're excited to have you in **${member.guild.name}**!`,
                '',
                `**Start here:**`,
                `• Read ${rulesCh}`,
                `• If prompted, finish verification in ${verifyCh}`,
                `• Say hi in ${generalCh}`,
                infoCh ? `• Check ${infoCh} for helpful links/resources` : null,
            ]
                .filter(Boolean)
                .join('\n')
        )
        .addFields(
            {
                name: 'Quick Facts',
                value: [`**Status:** ${String(api.status || '-')}`, `**Grad Year:** ${String(api.gradYear || '-')}`, `**Major(s):** ${majorsStr}`].join('\n'),
                inline: true,
            },
            {
                name: 'Chapter',
                value: [`**Roll #:** ${String(api.rollNo || '-')}`, `**Family Line:** ${String(api.familyLine || '-')}`, `**ECouncil:** ${api.isECouncil ? 'Yes' : 'No'}`].join('\n'),
                inline: true,
            },
            {
                name: 'Links',
                value: [`**GitHub:** ${api.socialLinks?.github || '-'}`, `**LinkedIn:** ${api.socialLinks?.linkedin || '-'}`, `**Hometown:** ${String(api.hometown || '-')}`].join('\n'),
                inline: false,
            }
        )
        .setFooter({
            text: `Created: ${api.createdAt ? new Date(api.createdAt).toLocaleString() : '-'}  •  ⚙️ ΘΘ`,
        })
        .setTimestamp();

    if (WELCOME_BANNER_URL) e.setImage(WELCOME_BANNER_URL);
    return e;
}

function statusRoleIdFrom(api) {
    return getStatusRoleId(api?.status) || '';
}

function managedStatusRoleIds() {
    return Object.values(getAllStatusMappings()).filter(Boolean);
}

async function fetchCommitteeMemberships(rollNo) {
    if (rollNo === undefined || rollNo === null || String(rollNo).trim() === '') {
        return { headCommittees: [], memberCommittees: [] };
    }

    const url = `https://thetatau-dg.org/api/committees/public-member/${encodeURIComponent(String(rollNo))}`;
    const res = await fetch(url).catch(() => null);
    if (!res) return { headCommittees: [], memberCommittees: [] };

    let data = null;
    try {
        data = await res.json();
    } catch {
        data = null;
    }

    return {
        headCommittees: Array.isArray(data?.headCommittees) ? data.headCommittees : [],
        memberCommittees: Array.isArray(data?.memberCommittees) ? data.memberCommittees : [],
    };
}

async function syncMemberRoles(guildMember, apiMember) {
    const changes = { added: [], removed: [] };
    if (!guildMember || !apiMember) return changes;

    const currentRoles = guildMember.roles?.cache || new Map();
    const committeeMappings = getAllCommitteeMappings();
    const committeeRoleIds = new Set(getCommitteeRoleIds());
    const desiredCommitteeRoleIds = new Set();

    const [committeePayload, statusRoleId] = await Promise.all([
        fetchCommitteeMemberships(apiMember.rollNo).catch(() => ({ headCommittees: [], memberCommittees: [] })),
        Promise.resolve(statusRoleIdFrom(apiMember)),
    ]);

    for (const committee of [...committeePayload.headCommittees, ...committeePayload.memberCommittees]) {
        const roleId = committeeMappings[String(committee || '').trim()];
        if (roleId) desiredCommitteeRoleIds.add(roleId);
    }

    for (const roleId of committeeRoleIds) {
        const hasRole = currentRoles.has(roleId);
        const shouldHaveRole = desiredCommitteeRoleIds.has(roleId);
        if (shouldHaveRole && !hasRole) {
            await guildMember.roles.add(roleId).catch(() => {});
            changes.added.push(roleId);
        }
        if (!shouldHaveRole && hasRole) {
            await guildMember.roles.remove(roleId).catch(() => {});
            changes.removed.push(roleId);
        }
    }

    const currentStatusRoleIds = managedStatusRoleIds();
    const desiredStatusRoleId = statusRoleId || '';
    if (desiredStatusRoleId) {
        for (const roleId of currentStatusRoleIds) {
            if (roleId !== desiredStatusRoleId && currentRoles.has(roleId)) {
                await guildMember.roles.remove(roleId).catch(() => {});
                changes.removed.push(roleId);
            }
        }
        if (!currentRoles.has(desiredStatusRoleId)) {
            await guildMember.roles.add(desiredStatusRoleId).catch(() => {});
            changes.added.push(desiredStatusRoleId);
        }
    }

    const ecouncilRoleId = getEcouncilRoleId();
    if (apiMember.isECouncil && ecouncilRoleId) {
        if (!currentRoles.has(ecouncilRoleId)) {
            await guildMember.roles.add(ecouncilRoleId).catch(() => {});
            changes.added.push(ecouncilRoleId);
        }
    } else if (ecouncilRoleId && currentRoles.has(ecouncilRoleId)) {
        await guildMember.roles.remove(ecouncilRoleId).catch(() => {});
        changes.removed.push(ecouncilRoleId);
    }

    return changes;
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
        u.search = '';
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
    try {
        payload = await res.json();
    } catch {
        payload = null;
    }
    return { ok: res.ok, payload };
}

// NOTE: uses userId (DB id) path, not roll number
async function patchApproval(userId, action) {
    const base = (process.env.APPROVAL_API_BASE ||
        'https://thetatau-dg.org/api/members/pending'
    ).replace(/\/$/, '');
    const url = `${base}/${encodeURIComponent(String(userId))}/`;

    const secret = String(process.env.APPROVAL_API_SECRET || '').trim();
    const body = { action: action === 'approve' ? 'approve' : 'reject', secret };

    console.log('--- PATCH /pending/:userID ---');
    console.log('URL :', url);
    console.log('HEAD:', { 'Content-Type': 'application/json' });
    console.log('BODY:', JSON.stringify({ ...body, secret: mask(secret) }));

    const res = await axios.patch(url, body, {
        httpsAgent,
        headers: { 'Content-Type': 'application/json' },
        validateStatus: () => true, // capture 4xx/5xx bodies
        timeout: 10000,
    });

    console.log('STATUS:', res.status);
    console.log('RESP  :', res.data);
    return { ok: res.status >= 200 && res.status < 300, payload: res.data };
}
async function safePatchApproval(userId, action) {
    try {
        return await patchApproval(userId, action);
    } catch (e) {
        if (String(e?.code) === 'UND_ERR_REQ_CONTENT_LENGTH_MISMATCH') {
            await new Promise((r) => setTimeout(r, 200));
            return await patchApproval(userId, action);
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
    try {
        data = await res.json();
    } catch {
        data = null;
    }
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.data)) return data.data;
    if (data && Array.isArray(data.list)) return data.list;
    return [];
}
async function getMembers() {
    return fetchMembersApi();
}

function committeeNamesFromPayload(payload) {
    return [...new Set([...(payload?.headCommittees || []), ...(payload?.memberCommittees || [])].map((value) => String(value || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function buildMemberRecordEmbed(apiMember, committeePayload) {
    const committees = committeeNamesFromPayload(committeePayload);
    const fullName = [apiMember.fName, apiMember.lName].filter(Boolean).join(' ') || '-';
    return new EmbedBuilder()
        .setColor(THEME_GOLD)
        .setTitle(fullName)
        .addFields(
            { name: 'Roll #', value: String(apiMember.rollNo || '-'), inline: true },
            { name: 'Status', value: String(apiMember.status || '-'), inline: true },
            { name: 'Grad Year', value: String(apiMember.gradYear || '-'), inline: true },
            { name: 'ECouncil Position', value: String(apiMember.ecouncilPosition || '-'), inline: true },
            {
                name: 'Major',
                value: Array.isArray(apiMember.majors) ? apiMember.majors.join(', ') : String(apiMember.major || '-'),
                inline: false,
            },
            { name: 'Committees', value: committees.length ? committees.join(', ') : '-', inline: false }
        )
        .setFooter({ text: apiMember.email || apiMember.emailAddress || '' })
        .setTimestamp();
}

async function runFullRoleSync(guild, members = null) {
    const apiMembers = members || await fetchMembersApi();
    const summary = {
        total: apiMembers.length,
        matched: 0,
        skipped: 0,
        addedRoles: 0,
        removedRoles: 0,
        missingInGuild: 0,
        usedDiscordId: 0,
        usedDbId: 0,
    };

    for (const apiMember of apiMembers) {
        let guildMember = null;
        if (apiMember.discordId) {
            guildMember = await guild.members.fetch(apiMember.discordId).catch(() => null);
            if (guildMember) summary.usedDiscordId += 1;
        }
        if (!guildMember) {
            const stored = getByDbId(apiMember._id);
            if (stored?.userId) {
                guildMember = await guild.members.fetch(stored.userId).catch(() => null);
                if (guildMember) summary.usedDbId += 1;
            }
        }

        if (!guildMember) {
            summary.skipped += 1;
            summary.missingInGuild += 1;
            continue;
        }

        const changes = await syncMemberRoles(guildMember, apiMember).catch(() => ({ added: [], removed: [] }));
        summary.matched += 1;
        summary.addedRoles += changes.added.length;
        summary.removedRoles += changes.removed.length;
    }

    return summary;
}

function logRoleSyncSummary(summary, source) {
    console.log(`[role-sync:${source}] ${JSON.stringify(summary)}`);
}

async function handleSyncCommand(interaction) {
    if (!hasManagePermission(interaction.member)) {
        return interaction.reply({ content: 'You lack permission to do this.', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });
    const guild = interaction.guild ?? (await client.guilds.fetch(GUILD_ID));
    const summary = await runFullRoleSync(guild);
    logRoleSyncSummary(summary, 'manual');
    return interaction.editReply(
        `Synced ${summary.matched}/${summary.total} members. Added ${summary.addedRoles} role assignments and removed ${summary.removedRoles}. Skipped ${summary.skipped}.`
    );
}

async function handleWhoisCommand(interaction) {
    const user = interaction.options.getUser('user', true);
    await interaction.deferReply({ ephemeral: true });

    const members = await fetchMembersApi();
    const stored = getByUserId(user.id);
    const storedEmail = String(stored?.email || '').trim().toLowerCase();
    const apiMember = members.find((member) => String(member.discordId || '').trim() === String(user.id)) ||
        (storedEmail ? members.find((member) => String(member.email || member.emailAddress || '').trim().toLowerCase() === storedEmail) : null);

    if (!apiMember) {
        return interaction.editReply(`No chapter record found for ${user.tag}.`);
    }

    const committeePayload = await fetchCommitteeAssignmentsForRollNo(apiMember.rollNo).catch(() => ({ headCommittees: [], memberCommittees: [] }));
    return interaction.editReply({ embeds: [buildMemberRecordEmbed(apiMember, committeePayload)] });
}

async function handleLookupCommand(interaction) {
    const query = interaction.options.getString('query', true).trim();
    await interaction.deferReply({ ephemeral: true });

    const members = await fetchMembersApi();
    const normalized = query.toLowerCase();
    const apiMember = members.find((member) => String(member.email || member.emailAddress || '').trim().toLowerCase() === normalized)
        || members.find((member) => String(member.rollNo || '').trim().toLowerCase() === normalized)
        || members.find((member) => String(member.email || member.emailAddress || '').trim().toLowerCase().includes(normalized))
        || members.find((member) => String(member.rollNo || '').trim().toLowerCase().includes(normalized));

    if (!apiMember) {
        return interaction.editReply(`No chapter record matched **${query}**.`);
    }

    const committeePayload = await fetchCommitteeAssignmentsForRollNo(apiMember.rollNo).catch(() => ({ headCommittees: [], memberCommittees: [] }));
    return interaction.editReply({ embeds: [buildMemberRecordEmbed(apiMember, committeePayload)] });
}

async function handleBootstrapCommand(interaction) {
    if (!hasManagePermission(interaction.member)) {
        return interaction.reply({ content: 'You lack permission to do this.', ephemeral: true });
    }
    if (isBootstrapCompleted()) {
        return interaction.reply({ content: 'Bootstrap has already been run once.', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });
    const guild = interaction.guild ?? (await client.guilds.fetch(GUILD_ID));
    const members = await fetchMembersApi();
    const guildMembers = await guild.members.fetch();
    const apiByDiscordId = new Map(members.filter((member) => member.discordId).map((member) => [String(member.discordId), member]));
    const apiByEmail = new Map(members.filter((member) => member.email || member.emailAddress).map((member) => [String(member.email || member.emailAddress).trim().toLowerCase(), member]));

    const summary = { matched: 0, skipped: 0, skippedBot: 0, skippedNoApiRecord: 0, usedDiscordId: 0, usedEmail: 0, savedDbIds: 0 };

    for (const guildMember of guildMembers.values()) {
        if (guildMember.user.bot) {
            summary.skipped += 1;
            summary.skippedBot += 1;
            continue;
        }

        let apiMember = apiByDiscordId.get(guildMember.id) || null;
        if (apiMember) {
            summary.usedDiscordId += 1;
        }
        if (!apiMember) {
            const stored = getByUserId(guildMember.id);
            const storedEmail = String(stored?.email || '').trim().toLowerCase();
            if (storedEmail) {
                apiMember = apiByEmail.get(storedEmail) || null;
                if (apiMember) summary.usedEmail += 1;
            }
        }

        if (!apiMember) {
            summary.skipped += 1;
            summary.skippedNoApiRecord += 1;
            continue;
        }

        rememberDbId(apiMember._id, { userId: guildMember.id, email: apiMember.email || apiMember.emailAddress || '', channelId: null });
        summary.savedDbIds += 1;

        await syncMemberRoles(guildMember, apiMember).catch(() => {});
        summary.matched += 1;
    }

    markBootstrapCompleted();
    return interaction.editReply(
        `Bootstrap complete. Matched ${summary.matched}, skipped ${summary.skipped} (bots: ${summary.skippedBot}, missing API record: ${summary.skippedNoApiRecord}). Saved ${summary.savedDbIds} DB-id links.`
    );
}

// ---------------- Events ----------------
client.once(Events.ClientReady, (c) => {
    console.log(`✅ Logged in as ${c.user.tag}`);
    schedulePendingChecker();
    scheduleRoleSyncChecker();
});

client.on(Events.GuildMemberAdd, async (member) => {
    try {
        if (member.guild.id !== GUILD_ID) return;

        await member.roles.add(PENDING_ROLE_ID).catch(() => { });
        const channel = await createPrivateChannel(member);
        const prior = getByUserId(member.id);

        const intro = new EmbedBuilder()
            .setColor(THEME_GOLD)
            .setTitle(prior ? 'Welcome back!' : "Welcome! Let's get you verified")
            .setDescription(
                prior
                    ? `You previously verified with **${prior.email}**. A mod can help restore access or continue onboarding.`
                    : 'Click **Get Started** to enter your email. We’ll send you an invitation and instructions.'
            );

        await channel.send({
            content: `<@${member.id}>`,
            embeds: [intro],
            components: prior ? [] : [getStartedRow(member.id)],
        });
    } catch (err) {
        console.error('GuildMemberAdd error:', err);
    }
});

client.on(Events.InteractionCreate, async (interaction) => {
    try {
        if (interaction.isChatInputCommand()) {
            if (interaction.commandName === 'sync') return handleSyncCommand(interaction);
            if (interaction.commandName === 'whois') return handleWhoisCommand(interaction);
            if (interaction.commandName === 'lookup') return handleLookupCommand(interaction);
            if (interaction.commandName === 'bootstrap') return handleBootstrapCommand(interaction);
        }

        if (interaction.isChatInputCommand() && (interaction.commandName === 'role-map' || interaction.commandName === 'committee-map')) {
            return handleRoleMapCommand(interaction);
        }

        if (interaction.isRoleSelectMenu()) {
            const parts = interaction.customId.split(':');
            if (parts[0] === 'role-map' && parts[1] === 'role') {
                const sessionId = parts[2];
                const session = committeeMapSessions.get(sessionId);
                if (!session) {
                    return interaction.update({ content: 'This mapping session has ended.', components: [], embeds: [] });
                }
                if (interaction.user.id !== session.userId) {
                    return interaction.reply({ content: 'This mapping session is not yours.', ephemeral: true });
                }

                const current = session.items[session.index];
                const roleId = interaction.values?.[0];
                if (current && roleId) {
                    if (session.kind === 'committee') rememberCommitteeMapping(current, roleId);
                    if (session.kind === 'status') rememberStatusMapping(current, roleId);
                    if (session.kind === 'ecouncil') rememberEcouncilRole(roleId);
                }

                session.index += 1;
                if (session.index >= session.items.length) {
                    finishMappingSession(sessionId);
                    return interaction.update({
                        content: `${mappingKindLabel(session.kind)} mapping session finished.`,
                        embeds: [],
                        components: [],
                    });
                }

                return renderMappingSession(interaction, sessionId);
            }
        }

        if (interaction.isButton()) {
            const parts = interaction.customId.split(':');
            if (parts[0] === 'role-map' && (parts[1] === 'skip' || parts[1] === 'done')) {
                const sessionId = parts[2];
                const session = committeeMapSessions.get(sessionId);
                if (!session) {
                    return interaction.update({ content: 'This mapping session has ended.', components: [], embeds: [] });
                }
                if (interaction.user.id !== session.userId) {
                    return interaction.reply({ content: 'This mapping session is not yours.', ephemeral: true });
                }

                if (parts[1] === 'done') {
                    if (session.kind === 'ecouncil' && !getEcouncilRoleId()) {
                        return interaction.update({ content: 'Select a role before finishing the ECouncil mapping session.', components: buildMappingSessionComponents(sessionId, session), embeds: [buildMappingSessionEmbed(session)] });
                    }
                    finishMappingSession(sessionId);
                    return interaction.update({
                        content: `${mappingKindLabel(session.kind)} mapping session finished.`,
                        embeds: [],
                        components: [],
                    });
                }

                session.index += 1;
                if (session.index >= session.items.length) {
                    finishMappingSession(sessionId);
                    return interaction.update({
                        content: `${mappingKindLabel(session.kind)} mapping session finished.`,
                        embeds: [],
                        components: [],
                    });
                }

                return renderMappingSession(interaction, sessionId);
            }
        }

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
                const hasPerm =
                    hasAdminRole || member.permissions.has(PermissionsBitField.Flags.ManageGuild);
                if (!hasPerm)
                    return interaction.reply({ content: 'You lack permission to do this.', ephemeral: true });

                const pendingId = parts[2]; // DB id
                const emailFromButton = parts[3] && parts[3] !== 'none' ? parts[3] : null;

                // PUBLIC reply (non-ephemeral)
                await interaction.deferReply();

                const { ok } = await patchApproval(pendingId, action);
                if (!ok) {
                    await interaction.editReply(`API ${action} failed for user ID ${pendingId}.`);
                    return;
                }

                // Try to resolve the Discord user/channel by our store
                let link =
                    getByPendingId(pendingId) || (emailFromButton ? getByEmail(emailFromButton) : null);

                if (action === 'approve' && link) {
                    rememberDbId(pendingId, {
                        userId: link.userId,
                        email: link.email || emailFromButton || '',
                        channelId: link.channelId || null,
                    });
                }

                if (action === 'reject') {
                    // Disable buttons on the message so nobody double-clicks
                    try {
                        const disabled = approveRejectRowDisabled(pendingId, emailFromButton);
                        await interaction.message.edit({ components: [disabled] }).catch(() => { });
                    } catch { }

                    // DM + kick + delete verify channel
                    if (link) {
                        try {
                            const user = await client.users.fetch(link.userId);
                            await user.send(
                                'Your profile request was rejected by an admin. If you believe this is an error, email **regent@thetatau-dg.org**.'
                            );
                            const gm = await interaction.guild.members.fetch(link.userId).catch(() => null);
                            if (gm) await gm.kick('Verification rejected by admin');
                        } catch { }
                        if (link.channelId) {
                            const ch = await interaction.guild.channels.fetch(link.channelId).catch(() => null);
                            if (ch) {
                                try {
                                    await ch.send('This verification was rejected. This channel will be deleted.');
                                } catch { }
                                setTimeout(() => ch.delete('Verification rejected').catch(() => { }), 5000);
                            }
                        }
                    }

                    await interaction.editReply(`Rejected user ID ${pendingId} by <@${interaction.user.id}>.`);
                    return;
                }

                // Approved → (optional) fetch members list to enrich the welcome card later
                let apiMember = null;
                try {
                    const members = await getMembers();
                    apiMember =
                        members.find((m) => String(m._id || m.id) === String(pendingId)) ||
                        [...members].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
                } catch { }

                // Disable buttons on the message so nobody double-clicks
                try {
                    const disabled = approveRejectRowDisabled(pendingId, emailFromButton);
                    await interaction.message.edit({ components: [disabled] }).catch(() => { });
                } catch { }

                // Ask the user for their profile picture in their temp channel (if we know it)
                if (link?.channelId) {
                    awaitingPfp.set(link.userId, { apiMember: apiMember || {}, channelId: link.channelId });
                    const tempChan = await interaction.guild.channels.fetch(link.channelId).catch(() => null);
                    if (tempChan) {
                        await tempChan.send({
                            content: `<@${link.userId}> Approved - please upload your **profile picture** as the next message in this channel.`,
                        });
                    }
                    await interaction.editReply(
                        `Approved user ID ${pendingId} by <@${interaction.user.id}>. Asked the user for their profile picture.`
                    );
                } else {
                    await interaction.editReply(
                        `Approved user ID ${pendingId} by <@${interaction.user.id}>. I couldn’t locate the Discord user via saved mapping.`
                    );
                }
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

                if (getByEmail(email)) {
                    return interaction.reply({
                        content: 'That email is already registered. Please contact a mod if you need help.',
                        ephemeral: true,
                    });
                }

                const channelId = interaction.channel?.id || null;

                await interaction.deferReply({ ephemeral: true });
                const { ok, payload } = await postInvitation(email);

                // Persist: email <-> discord user, and the invite id returned
                rememberEmail({
                    userId: interaction.user.id,
                    email,
                    channelId,
                    inviteId: payload?.id || null,
                });

                // Admin embed (optional)
                try {
                    const guild = interaction.guild ?? (await client.guilds.fetch(GUILD_ID));
                    const adminChan =
                        ADMIN_ROLE_ID && process.env.ADMIN_CHANNEL_ID
                            ? await guild.channels.fetch(process.env.ADMIN_CHANNEL_ID).catch(() => null)
                            : null;
                    if (adminChan) {
                        const embed = buildInviteAdminEmbed(email, payload, ok, interaction.member);
                        const mention = ADMIN_ROLE_ID ? `<@&${ADMIN_ROLE_ID}>` : '';
                        await adminChan.send({ content: `${mention} New invitation submitted`, embeds: [embed] });
                    }
                } catch { }

                // Steps guide to temp channel
                if (interaction.channel) {
                    await postStepsGuide(interaction.channel);
                }
                await interaction.editReply(
                    ok
                        ? 'Invite sent! Check your email and follow the steps above.'
                        : 'There was an issue sending your invite. Please contact a mod.'
                );
            }
        }
    } catch (err) {
        console.error('Interaction error:', err);
        if (interaction.isRepliable()) {
            try {
                await interaction.reply({ content: 'Something went wrong. Try again.', ephemeral: true });
            } catch { }
        }
    }
});

// Catch profile picture after approval
client.on(Events.MessageCreate, async (msg) => {
    try {
        if (!msg.guild || msg.author.bot) return;
        const wait = awaitingPfp.get(msg.author.id);
        if (!wait) return;
        const expectedChannel = wait.channelId
            ? msg.guild.channels.cache.get(wait.channelId) || await msg.guild.channels.fetch(wait.channelId).catch(() => null)
            : null;
        if (!expectedChannel) {
            awaitingPfp.delete(msg.author.id);
            return;
        }
        if (msg.channel.id !== expectedChannel.id) return;

        const attach = msg.attachments.first();
        if (!attach) return; // ignore non-attachments

        // Build welcome embed from API + photo
        const gm = await msg.guild.members.fetch(msg.author.id);
        const embed =
            wait.apiMember && Object.keys(wait.apiMember).length
                ? buildWelcomeEmbedFromApi(gm, wait.apiMember)
                : new EmbedBuilder().setColor(THEME_RED).setTitle(gm.user.username).setDescription('🎉 New Member Onboarding Card').setTimestamp();

        // Try to buffer the image so it persists
        let files = [];
        let thumbnailSet = false;
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

        // Role assignments (remove pending, add status role or default)
        await gm.roles.remove(PENDING_ROLE_ID).catch(() => { });
        const roleChanges = await syncMemberRoles(gm, wait.apiMember || {});
        let appliedRole = roleChanges.added.some((roleId) => managedStatusRoleIds().includes(roleId));
        if (!appliedRole && DEFAULT_VERIFIED_ROLE_ID) {
            await gm.roles.add(DEFAULT_VERIFIED_ROLE_ID).catch(() => { });
            appliedRole = true;
        }

        awaitingPfp.delete(msg.author.id);
        await msg
            .reply(`Thanks! Your welcome card has been posted.${appliedRole ? ' You now have your member role.' : ''}`)
            .catch(() => { });

        // Auto-close the verify channel
        if (Number.isFinite(DELETE_VERIFY_CHANNEL_AFTER_MS) && DELETE_VERIFY_CHANNEL_AFTER_MS >= 0) {
            try {
                const secs = Math.max(0, Math.round(DELETE_VERIFY_CHANNEL_AFTER_MS / 1000));
                await msg.channel
                    .send(`All set! This channel will close in ${secs}s.`)
                    .catch(() => { });
            } catch { }
            setTimeout(() => {
                msg.channel.delete('Verification complete').catch(() => { });
            }, Math.max(0, DELETE_VERIFY_CHANNEL_AFTER_MS));
        }
    } catch (err) {
        console.error('PFP handling error:', err);
    }
});

// ---------------- Pending poll ----------------
function digestPending(items) {
    try {
        return items
            .map((it) => String(it._id || it.id || it.rollNo || it.email || it.emailAddress || ''))
            .sort()
            .join('|');
    } catch {
        return '';
    }
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
            content: `${mention}Pending invitations update - **${items.length}** waiting.`,
        });

        // one embed + one row of buttons per user
        for (const it of items) {
            const pendingId = it._id || it.id;
            const ts = Date.parse(it.submittedAt || it.createdAt || it.updatedAt || '') || undefined;

            // Auto-link pending DB id to most recent invite mapping (±30 min window)
            if (pendingId && ts && !getByPendingId(pendingId)) {
                const guess = findRecentInviteMapping(ts, 30 * 60 * 1000);
                if (guess?.inviteId) {
                    linkPendingToInvite(pendingId, guess.inviteId);
                }
            }

            const displayName =
                [it.fName, it.lName].filter(Boolean).join(' ') ||
                it.email ||
                it.emailAddress ||
                'Pending Member';

            const embed = new EmbedBuilder()
                .setColor(THEME_GOLD)
                .setTitle(`⏳ Pending - ${displayName}`)
                .setDescription(formatPendingItem(it))
                .setFooter({
                    text: `ID ${pendingId || '-'}${it.rollNo ? ` • Roll # ${it.rollNo}` : ''}`,
                })
                .setTimestamp();

            // Buttons carry DB id + best-guess email for convenience
            const row = approveRejectRow(pendingId || 'unknown', it.email || it.emailAddress);

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

async function runScheduledRoleSync(source = 'interval') {
    if (roleSyncInProgress) return;
    roleSyncInProgress = true;
    try {
        const guild = await client.guilds.fetch(GUILD_ID);
        const summary = await runFullRoleSync(guild);
        logRoleSyncSummary(summary, source);
    } catch (err) {
        console.error(`[role-sync:${source}] error:`, err);
    } finally {
        roleSyncInProgress = false;
    }
}

function scheduleRoleSyncChecker() {
    runScheduledRoleSync('startup');
    if (Number.isFinite(ROLE_SYNC_INTERVAL_MS) && ROLE_SYNC_INTERVAL_MS > 0) {
        setInterval(() => {
            runScheduledRoleSync('interval');
        }, ROLE_SYNC_INTERVAL_MS);
    }
}

// ---------------- Boot ----------------
async function main() {
    await initStore(); // load persisted mappings
    await client.login(TOKEN);
}
main();
