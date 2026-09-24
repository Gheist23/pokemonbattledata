// Registers the bot's slash commands with Discord. Run once, and again
// whenever functions/api/discord/_commands.js changes.
//
//   $env:DISCORD_APP_ID    = "..."        # Application ID, developer portal
//   $env:DISCORD_BOT_TOKEN = "..."        # Bot token, Bot tab -> Reset Token
//   node tools/register-discord-commands.mjs --dry-run
//   node tools/register-discord-commands.mjs --guild <server id>   # instant
//   node tools/register-discord-commands.mjs                       # global
//
// Guild commands appear in that one server immediately and are the way to try
// a change; global commands reach every server the bot is in and Discord may
// take up to an hour to roll them out. Registering globally replaces the whole
// global list, so this file is the list.
//
// The token is read from the environment and never written down: it is not
// printed, not echoed into an error, and not read from .dev.vars or any other
// file in the repo. That matters here in particular because tools/ is uploaded
// with the site (tools/deploy.mjs parks only .claude, .dev.vars, the licence
// key and tests/), so anything committed into this folder is public.
//
// Nothing else in the site imports this; it talks only to Discord.

import { COMMANDS } from "../functions/api/discord/_commands.js";

const API = "https://discord.com/api/v10";

function parseArgs(argv) {
  const options = { dryRun: false, guild: "", list: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--list") options.list = true;
    else if (arg === "--guild") { options.guild = String(argv[index + 1] || "").trim(); index += 1; }
    else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
const appId = String(process.env.DISCORD_APP_ID || "").trim();
const token = String(process.env.DISCORD_BOT_TOKEN || "").trim();

if (options.dryRun) {
  console.log(JSON.stringify(COMMANDS, null, 2));
  console.log(`\n${COMMANDS.length} commands: ${COMMANDS.map((command) => `/${command.name}`).join(" ")}`);
  process.exit(0);
}

const missing = [!appId && "DISCORD_APP_ID", !token && "DISCORD_BOT_TOKEN"].filter(Boolean);
if (missing.length) {
  console.error(`Set ${missing.join(" and ")} in the environment first. Use --dry-run to see the commands without them.`);
  process.exit(1);
}

const url = options.guild
  ? `${API}/applications/${appId}/guilds/${options.guild}/commands`
  : `${API}/applications/${appId}/commands`;
const scope = options.guild ? `guild ${options.guild}` : "globally";

/** One call, retried while Discord asks us to slow down. */
async function call(method, body) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await fetch(url, {
      method,
      headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.status === 429) {
      const retry = Number((await response.json().catch(() => ({}))).retry_after || 1);
      console.log(`Rate limited, waiting ${retry}s`);
      await new Promise((resolve) => setTimeout(resolve, Math.min(30, Math.max(1, retry)) * 1000));
      continue;
    }
    const text = await response.text();
    if (!response.ok) {
      // Discord's error body names the offending command and field; it never
      // contains the token, but scrub it anyway so a paste is always safe.
      throw new Error(`${method} ${response.status}: ${text.split(token).join("<token>").slice(0, 2000)}`);
    }
    return text ? JSON.parse(text) : null;
  }
  throw new Error("Still rate limited after three tries.");
}

try {
  if (options.list) {
    const existing = await call("GET");
    console.log(`${existing.length} command(s) registered ${scope}:`);
    for (const command of existing) console.log(`  /${command.name} - ${command.description}`);
    process.exit(0);
  }

  const registered = await call("PUT", COMMANDS);
  console.log(`Registered ${registered.length} command(s) ${scope}:`);
  for (const command of registered) console.log(`  /${command.name}`);
  if (!options.guild) console.log("Global commands can take up to an hour to appear in every server.");
} catch (error) {
  console.error(String(error.message || error));
  process.exit(1);
}
