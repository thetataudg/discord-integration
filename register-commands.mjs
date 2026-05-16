import 'dotenv/config';
import { REST, Routes, SlashCommandBuilder } from 'discord.js';

const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const CLIENT_ID = process.env.DISCORD_APP_ID || process.env.CLIENT_ID || '';

if (!TOKEN || !GUILD_ID || !CLIENT_ID) {
    console.error('Missing required env vars: DISCORD_TOKEN, GUILD_ID, DISCORD_APP_ID or CLIENT_ID');
    process.exit(1);
}

function buildRoleMapCommand(name) {
    return new SlashCommandBuilder()
        .setName(name)
        .setDescription('Map chapter roles to Discord roles')
        .addSubcommand((subcommand) =>
            subcommand
                .setName('map')
                .setDescription('Interactively map discovered committee names to roles')
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName('committee')
                .setDescription('Interactively map discovered committee names to roles')
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName('status')
                .setDescription('Interactively map discovered status values to roles')
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName('ecouncil')
                .setDescription('Map ECouncil members to a role')
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName('list')
                .setDescription('List the current committee, status, and ECouncil mappings')
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName('remove')
                .setDescription('Remove a mapping by name')
                .addStringOption((option) =>
                    option
                        .setName('name')
                        .setDescription('Committee, status, or ECouncil name to remove')
                        .setRequired(true)
                )
        );
}

const commands = [
    buildRoleMapCommand('role-map').toJSON(),
    buildRoleMapCommand('committee-map').toJSON(),
    new SlashCommandBuilder()
        .setName('sync')
        .setDescription('Manually trigger a full role reconciliation')
        .toJSON(),
    new SlashCommandBuilder()
        .setName('whois')
        .setDescription('Look up a chapter record for a Discord member')
        .addUserOption((option) =>
            option
                .setName('user')
                .setDescription('Discord member to look up')
                .setRequired(true)
        )
        .toJSON(),
    new SlashCommandBuilder()
        .setName('lookup')
        .setDescription('Look up a chapter member by email or roll number')
        .addStringOption((option) =>
            option
                .setName('query')
                .setDescription('Email address or roll number')
                .setRequired(true)
        )
        .toJSON(),
    new SlashCommandBuilder()
        .setName('bootstrap')
        .setDescription('Bootstrap existing guild members into the store and role map')
        .toJSON(),
];

const rest = new REST({ version: '10' }).setToken(TOKEN);

async function main() {
    try {
        await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
        console.log(`Registered ${commands.length} guild command(s) for ${GUILD_ID}.`);
    } catch (error) {
        console.error('Command registration failed:', error);
        process.exit(1);
    }
}

main();
