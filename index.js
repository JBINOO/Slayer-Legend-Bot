require('dotenv').config();

const fs = require('node:fs/promises');
const path = require('node:path');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
} = require('discord.js');

const token = process.env.DISCORD_TOKEN;
const guildId = process.env.GUILD_ID;
const DATA_PATH = path.join(__dirname, 'data', 'dragon-valley.json');
const DAYS = [1, 2, 3, 4, 5, 6];
const STATUSES = {
  Pending: 'Pending',
  Done: 'Done',
  Missed: 'Missed',
};
const STATUS_EMOJI = {
  Pending: '🟡',
  Done: '🟢',
  Missed: '🔴',
};
const BUTTON_STATUS = {
  btn_done: STATUSES.Done,
  btn_pending: STATUSES.Pending,
  btn_missed: STATUSES.Missed,
};

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

const commands = [
  new SlashCommandBuilder()
    .setName('dv-status')
    .setDescription('Show the Dragon Valley roster and attack status')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('dv-add-member')
    .setDescription('Add an in-game name to the Dragon Valley roster (officers only)')
    .addStringOption((option) =>
      option
        .setName('ign')
        .setDescription('In-game name to add to the roster')
        .setRequired(true)
        .setMinLength(1)
        .setMaxLength(32),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .toJSON(),
  new SlashCommandBuilder()
    .setName('dv-remove-member')
    .setDescription('Remove an in-game name from the Dragon Valley roster (officers only)')
    .addStringOption((option) =>
      option
        .setName('ign')
        .setDescription('In-game name to remove from the roster')
        .setRequired(true)
        .setMinLength(1)
        .setMaxLength(32),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .toJSON(),
  new SlashCommandBuilder()
    .setName('dv-setday')
    .setDescription('Set the active Dragon Valley day (officers only)')
    .addIntegerOption((option) =>
      option
        .setName('day_number')
        .setDescription('Active day to track (1-6)')
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(6),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .toJSON(),
  new SlashCommandBuilder()
    .setName('dv-reset')
    .setDescription('Reset all member statuses and return to Day 1 (officers only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .toJSON(),
];

function createEmptyDayStatus() {
  return DAYS.reduce((status, day) => {
    status[String(day)] = STATUSES.Pending;
    return status;
  }, {});
}

function defaultData() {
  return {
    activeDay: 1,
    members: [],
    statusBoard: null,
  };
}

async function loadData() {
  try {
    const raw = await fs.readFile(DATA_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      activeDay: DAYS.includes(Number(parsed.activeDay)) ? Number(parsed.activeDay) : 1,
      members: Array.isArray(parsed.members) ? parsed.members.map(normalizeMember) : [],
      statusBoard: normalizeStatusBoard(parsed.statusBoard),
    };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const data = defaultData();
    await saveData(data);
    return data;
  }
}

function normalizeStatusBoard(board) {
  if (!board?.channelId || !board?.messageId) return null;
  return {
    channelId: String(board.channelId),
    messageId: String(board.messageId),
  };
}

function normalizeMember(member) {
  const status = createEmptyDayStatus();
  const name = String(member?.name ?? member?.ign ?? '').trim();

  if (typeof member?.status === 'string' && Object.values(STATUSES).includes(member.status)) {
    for (const day of DAYS) {
      status[String(day)] = member.status;
    }
  } else if (member?.status && typeof member.status === 'object') {
    for (const day of DAYS) {
      const value = member.status[String(day)] ?? member.status[day];
      status[String(day)] = Object.values(STATUSES).includes(value) ? value : STATUSES.Pending;
    }
  }

  return {
    id: member?.id ? String(member.id) : null,
    name,
    ign: name,
    discordId: member?.discordId ? String(member.discordId) : null,
    status,
  };
}

async function saveData(data) {
  await fs.mkdir(path.dirname(DATA_PATH), { recursive: true });
  await fs.writeFile(DATA_PATH, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function getDayStatus(member, day) {
  return member.status[String(day)] ?? STATUSES.Pending;
}

function isOfficer(interaction) {
  const permissions = interaction.memberPermissions;
  if (permissions?.has(PermissionFlagsBits.Administrator) || permissions?.has(PermissionFlagsBits.ManageGuild)) {
    return true;
  }

  return Boolean(
    interaction.member?.roles?.cache?.some((role) => /^officers?$/i.test(role.name)),
  );
}

function findMemberForUser(data, interaction) {
  const userId = interaction.user.id;
  const byDiscordId = data.members.find((member) => member.discordId === userId);
  if (byDiscordId) return byDiscordId;

  const candidates = [
    interaction.member?.displayName,
    interaction.user.globalName,
    interaction.user.username,
  ]
    .filter(Boolean)
    .map((name) => name.toLowerCase());

  return data.members.find((member) => candidates.includes(member.name.toLowerCase()));
}

function buildStatusEmbed(data) {
  const activeDay = data.activeDay;
  const lines = data.members.length
    ? data.members.map((member, index) => {
        const current = getDayStatus(member, activeDay);
        const week = DAYS.map((day) => STATUS_EMOJI[getDayStatus(member, day)]).join(' ');
        return `${index + 1}. **${member.name}** — ${STATUS_EMOJI[current]} ${current}\nD1-D6: ${week}`;
      })
    : ['_No members on the roster yet. Officers can add IGNs with `/dv-add-member`._'];

  const counts = data.members.reduce(
    (acc, member) => {
      acc[getDayStatus(member, activeDay)] += 1;
      return acc;
    },
    { Pending: 0, Done: 0, Missed: 0 },
  );

  return new EmbedBuilder()
    .setTitle('Dragon Valley Tracker')
    .setDescription(`Active day: **Day ${activeDay} / 6**\n\n${lines.join('\n')}`)
    .setColor(0x8b0000)
    .addFields(
      { name: 'Done', value: String(counts.Done), inline: true },
      { name: 'Pending', value: String(counts.Pending), inline: true },
      { name: 'Missed', value: String(counts.Missed), inline: true },
    )
    .setTimestamp()
    .setFooter({ text: 'Slayer Tracker • Match your server nickname to your IGN to update status' });
}

function buildStatusComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('btn_done')
        .setLabel('Mark Done')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId('btn_pending')
        .setLabel('Mark Pending')
        .setEmoji('🟡')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('btn_missed')
        .setLabel('Mark Missed')
        .setStyle(ButtonStyle.Danger),
    ),
  ];
}

function buildStatusMessage(data) {
  return {
    embeds: [buildStatusEmbed(data)],
    components: buildStatusComponents(),
  };
}

async function rememberStatusBoard(interaction, data) {
  const message = await interaction.fetchReply();
  data.statusBoard = {
    channelId: message.channelId,
    messageId: message.id,
  };
  await saveData(data);
}

async function refreshStatusBoard(data) {
  const board = data.statusBoard;
  if (!board?.channelId || !board?.messageId) return false;

  try {
    const channel = await client.channels.fetch(board.channelId);
    if (!channel?.isTextBased()) return false;

    const message = await channel.messages.fetch(board.messageId);
    await message.edit(buildStatusMessage(data));
    return true;
  } catch {
    data.statusBoard = null;
    await saveData(data);
    return false;
  }
}

async function registerGuildCommands(applicationId, targetGuildId) {
  const rest = new REST({ version: '10' }).setToken(token);

  await rest.put(Routes.applicationGuildCommands(applicationId, targetGuildId), {
    body: commands,
  });
}

async function registerCommandsForGuilds(readyClient) {
  const applicationId = readyClient.user.id;
  const targetGuildIds = guildId
    ? [guildId]
    : readyClient.guilds.cache.map((guild) => guild.id);

  if (targetGuildIds.length === 0) {
    console.warn('No guilds available to register slash commands. Invite the bot to a server first.');
    return;
  }

  for (const targetGuildId of targetGuildIds) {
    await registerGuildCommands(applicationId, targetGuildId);
    const guildName = readyClient.guilds.cache.get(targetGuildId)?.name ?? targetGuildId;
    console.log(`Registered guild slash commands for ${guildName}`);
  }
}

async function handleDvStatus(interaction) {
  const data = await loadData();
  await interaction.reply(buildStatusMessage(data));
  await rememberStatusBoard(interaction, data);
}

async function denyIfNotOfficer(interaction, action) {
  if (isOfficer(interaction)) return false;

  await interaction.reply({
    content: `Only officers can ${action}.`,
    flags: MessageFlags.Ephemeral,
  });
  return true;
}

async function handleDvAddMember(interaction) {
  if (await denyIfNotOfficer(interaction, 'add members to the Dragon Valley roster')) return;

  const ign = interaction.options.getString('ign', true).trim();
  if (!ign) {
    await interaction.reply({
      content: 'Please provide a valid in-game name.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const data = await loadData();
  const exists = data.members.some((member) => member.name.toLowerCase() === ign.toLowerCase());
  if (exists) {
    await interaction.reply({
      content: `**${ign}** is already on the Dragon Valley roster.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  data.members.push({
    id: String(data.members.length + 1),
    name: ign,
    ign,
    discordId: null,
    status: createEmptyDayStatus(),
  });
  data.members.sort((a, b) => a.name.localeCompare(b.name));
  await saveData(data);

  await interaction.reply({
    content: `Added **${ign}** to the Dragon Valley roster.`,
    flags: MessageFlags.Ephemeral,
  });
  await refreshStatusBoard(data);
}

async function handleDvRemoveMember(interaction) {
  if (await denyIfNotOfficer(interaction, 'remove members from the Dragon Valley roster')) return;

  const ign = interaction.options.getString('ign', true).trim();
  if (!ign) {
    await interaction.reply({
      content: 'Please provide a valid in-game name.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const data = await loadData();
  const index = data.members.findIndex((member) => {
    const names = [member.name, member.ign].filter(Boolean).map((value) => value.toLowerCase());
    return names.includes(ign.toLowerCase());
  });

  if (index === -1) {
    await interaction.reply({
      content: `**${ign}** was not found on the Dragon Valley roster.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const [removed] = data.members.splice(index, 1);
  await saveData(data);

  const removedName = removed.name || removed.ign || ign;
  const refreshed = await refreshStatusBoard(data);
  const payload = {
    content: `Removed **${removedName}** from the roster.`,
  };

  if (!refreshed) {
    Object.assign(payload, buildStatusMessage(data));
  }

  await interaction.reply(payload);
  if (!refreshed) await rememberStatusBoard(interaction, data);
}

async function handleDvSetDay(interaction) {
  if (await denyIfNotOfficer(interaction, 'change the active Dragon Valley day')) return;

  const dayNumber = interaction.options.getInteger('day_number', true);
  if (!DAYS.includes(dayNumber)) {
    await interaction.reply({
      content: 'Day number must be between 1 and 6.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const data = await loadData();
  data.activeDay = dayNumber;
  await saveData(data);

  const refreshed = await refreshStatusBoard(data);
  const payload = {
    content: `Active day set to **Day ${dayNumber}**. Button updates now apply to this day.`,
  };

  if (!refreshed) {
    Object.assign(payload, buildStatusMessage(data));
  }

  await interaction.reply(payload);
  if (!refreshed) await rememberStatusBoard(interaction, data);
}

async function handleDvReset(interaction) {
  if (await denyIfNotOfficer(interaction, 'reset the Dragon Valley roster')) return;

  const data = await loadData();
  data.activeDay = 1;
  data.members = data.members.map((member) => ({
    ...member,
    status: createEmptyDayStatus(),
  }));
  await saveData(data);

  const refreshed = await refreshStatusBoard(data);
  const payload = {
    content: 'Roster reset for a new raid week. All D1–D6 statuses are Pending and the active day is **Day 1**.',
  };

  if (!refreshed) {
    Object.assign(payload, buildStatusMessage(data));
  }

  await interaction.reply(payload);
  if (!refreshed) await rememberStatusBoard(interaction, data);
}

async function handleStatusButton(interaction) {
  const nextStatus = BUTTON_STATUS[interaction.customId];
  if (!nextStatus) return;

  const data = await loadData();
  const member = findMemberForUser(data, interaction);

  if (!member) {
    await interaction.reply({
      content: 'You are not on the Dragon Valley roster. Ask an officer to add your IGN with `/dv-add-member`, and make sure your server nickname matches that IGN.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  member.discordId = interaction.user.id;
  member.status[String(data.activeDay)] = nextStatus;
  await saveData(data);

  await interaction.update(buildStatusMessage(data));
}

client.once(Events.ClientReady, async (readyClient) => {
  console.log('Slayer Tracker is Online!');

  try {
    await loadData();
    await registerCommandsForGuilds(readyClient);
  } catch (error) {
    console.error('Failed to start command registration or load tracker data:', error);
  }
});

client.on(Events.GuildCreate, async (guild) => {
  try {
    await registerGuildCommands(client.user.id, guild.id);
    console.log(`Registered guild slash commands for ${guild.name}`);
  } catch (error) {
    console.error(`Failed to register slash commands for ${guild.name}:`, error);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'dv-status') {
        await handleDvStatus(interaction);
        return;
      }

      if (interaction.commandName === 'dv-add-member') {
        await handleDvAddMember(interaction);
        return;
      }

      if (interaction.commandName === 'dv-remove-member') {
        await handleDvRemoveMember(interaction);
        return;
      }

      if (interaction.commandName === 'dv-setday') {
        await handleDvSetDay(interaction);
        return;
      }

      if (interaction.commandName === 'dv-reset') {
        await handleDvReset(interaction);
      }

      return;
    }

    if (interaction.isButton()) {
      await handleStatusButton(interaction);
    }
  } catch (error) {
    console.error('Failed to handle interaction:', error);

    const message = { content: 'Something went wrong while updating Dragon Valley tracking.', flags: MessageFlags.Ephemeral };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(message).catch(() => {});
    } else {
      await interaction.reply(message).catch(() => {});
    }
  }
});

client.login(token);
