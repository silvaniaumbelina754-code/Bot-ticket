/**
 * ==============================================================================
 *   TICKET BOT — VERSÃO CONSOLIDADA (SINGLE FILE)
 *   Desenvolvido para fácil deploy no Render ou similares
 *   Funcionalidades: Slash Commands, Select Menu, Botões, Logs, Transcrição
 * ==============================================================================
 */

require("dotenv").config();
const { 
  Client, GatewayIntentBits, Partials, Collection, EmbedBuilder, 
  ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle, 
  ChannelType, REST, Routes, AttachmentBuilder 
} = require("discord.js");
const fs = require("fs-extra");
const path = require("path");

// ------------------------------------------------------------------------------
//   CONFIGURAÇÕES (Personalize aqui)
// ------------------------------------------------------------------------------
const config = {
  painel: {
    titulo: "🎫 Central de Atendimento",
    descricao: "Selecione o tipo de atendimento abaixo para abrir um ticket.",
    cor: "#5865F2",           // Cor principal (Hex)
    banner: "",               // URL da imagem de banner (opcional)
    thumbnail: "",            // URL da thumbnail (opcional)
    tipo_componente: "select" // "select" para Select Menu | "button" para Botões
  },
  tipos_ticket: [
    { id: "suporte", label: "🛠️ Suporte Geral", desc: "Dúvidas e ajuda técnica", emoji: "🛠️", cor: "#5865F2", msg: "Descreva seu problema abaixo.", estilo: "Primary" },
    { id: "reembolso", label: "💸 Reembolso", desc: "Solicite estorno de compras", emoji: "💸", cor: "#ED4245", msg: "Informe o ID da compra e o motivo.", estilo: "Danger" },
    { id: "duvidas", label: "❓ Dúvidas", desc: "Tire suas dúvidas", emoji: "❓", cor: "#FEE75C", msg: "Como podemos te ajudar?", estilo: "Secondary" }
  ],
  canais: {
    categoria_abertos: "",   // ID da categoria para tickets abertos
    categoria_fechados: "",  // ID da categoria para tickets fechados
    canal_logs: "",          // ID do canal para logs de ações
    canal_transcricoes: "",  // ID do canal para arquivos de transcrição
    prefixo: "ticket"        // Prefixo do canal: ticket-usuario
  },
  cargos: {
    suporte: [],             // IDs dos cargos que gerenciam tickets
    admin: []                // IDs dos cargos que usam /setup
  },
  limites: {
    max_por_user: 1,         // Máximo de tickets por usuário
    deletar_ao_fechar: false // true = deleta o canal | false = move para fechados
  },
  mensagens: {
    ja_aberto: "❌ Você já possui um ticket aberto: {canal}",
    criado: "✅ Seu ticket foi criado: {canal}",
    fechado: "🔒 Ticket fechado por {usuario}.",
    sem_permissao: "❌ Você não tem permissão para isso."
  }
};

// ------------------------------------------------------------------------------
//   CLIENTE E INICIALIZAÇÃO
// ------------------------------------------------------------------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, 
    GatewayIntentBits.GuildMembers, GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel, Partials.Message, Partials.GuildMember]
});

const DB_PATH = "./data/tickets.json";
fs.ensureDirSync("./data");
if (!fs.existsSync(DB_PATH)) fs.writeJsonSync(DB_PATH, { tickets: {}, contador: 0 });

// ------------------------------------------------------------------------------
//   UTILITÁRIOS (Database, Logs, Transcrição, Permissões)
// ------------------------------------------------------------------------------
const db = {
  ler: () => fs.readJsonSync(DB_PATH),
  salvar: (data) => fs.writeJsonSync(DB_PATH, data, { spaces: 2 }),
  getTicket: (id) => db.ler().tickets[id],
  setTicket: (id, campos) => {
    const data = db.ler();
    data.tickets[id] = { ...data.tickets[id], ...campos };
    db.salvar(data);
  },
  delTicket: (id) => {
    const data = db.ler();
    delete data.tickets[id];
    db.salvar(data);
  },
  prox: () => {
    const data = db.ler();
    data.contador++;
    db.salvar(data);
    return data.contador;
  }
};

const perms = {
  isStaff: (m) => m.permissions.has("Administrator") || m.roles.cache.some(r => config.cargos.suporte.includes(r.id) || config.cargos.admin.includes(r.id)),
  isAdmin: (m) => m.permissions.has("Administrator") || m.roles.cache.some(r => config.cargos.admin.includes(r.id)),
  canalOpts: (guild, userId) => {
    const ow = [
      { id: guild.roles.everyone.id, deny: ["ViewChannel"] },
      { id: userId, allow: ["ViewChannel", "SendMessages", "ReadMessageHistory", "AttachFiles", "EmbedLinks"] }
    ];
    [...config.cargos.suporte, ...config.cargos.admin].forEach(id => ow.push({ id, allow: ["ViewChannel", "SendMessages", "ManageMessages"] }));
    return ow;
  }
};

async function log(acao, ticket, user, extra = "") {
  if (!config.canais.canal_logs) return;
  const canal = client.channels.cache.get(config.canais.canal_logs);
  if (!canal) return;
  const embed = new EmbedBuilder()
    .setTitle(`Log: ${acao}`)
    .addFields(
      { name: "Ticket", value: `#${ticket.numero}`, inline: true },
      { name: "Usuário", value: `<@${user.id}>`, inline: true },
      { name: "Detalhes", value: extra || "Nenhum" }
    )
    .setTimestamp().setColor(acao === "Aberto" ? "#57F287" : "#ED4245");
  canal.send({ embeds: [embed] }).catch(() => {});
}

async function transcricao(canal, ticket) {
  const msgs = await canal.messages.fetch({ limit: 100 });
  let html = `<html><body style="background:#36393f;color:#dcddde;font-family:sans-serif;"><h1>Ticket #${ticket.numero}</h1>`;
  msgs.reverse().forEach(m => {
    html += `<p><b>${m.author.tag}:</b> ${m.content}</p>`;
  });
  html += `</body></html>`;
  const file = `./data/transcricao-${ticket.numero}.html`;
  fs.writeFileSync(file, html);
  return file;
}

// ------------------------------------------------------------------------------
//   LÓGICA DE INTERAÇÃO (Botões e Selects)
// ------------------------------------------------------------------------------
async function handleInteracao(interaction) {
  const { customId, user, guild } = interaction;

  // ABERTURA DE TICKET
  if (customId === "ticket_select" || customId.startsWith("btn_open_")) {
    const tipoId = customId === "ticket_select" ? interaction.values[0] : customId.replace("btn_open_", "");
    const tipo = config.tipos_ticket.find(t => t.id === tipoId);
    
    const abertos = Object.values(db.ler().tickets).filter(t => t.userId === user.id && t.status === "aberto");
    if (abertos.length >= config.limites.max_por_user) {
      return interaction.reply({ content: config.mensagens.ja_aberto.replace("{canal}", `<#${abertos[0].id}>`), ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });
    const num = db.prox();
    const cName = `${config.canais.prefixo}-${user.username}-${String(num).padStart(4, "0")}`;
    
    const canal = await guild.channels.create({
      name: cName,
      type: ChannelType.GuildText,
      parent: config.canais.categoria_abertos || null,
      permissionOverwrites: perms.canalOpts(guild, user.id)
    });

    db.setTicket(canal.id, { id: canal.id, userId: user.id, numero: num, status: "aberto", tipo: tipo.label });

    const embed = new EmbedBuilder()
      .setTitle(`${tipo.emoji} ${tipo.label} — #${String(num).padStart(4, "0")}`)
      .setDescription(tipo.msg)
      .setColor(tipo.cor)
      .addFields({ name: "Dono", value: `<@${user.id}>`, inline: true });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`close_${canal.id}`).setLabel("Fechar").setStyle(ButtonStyle.Danger).setEmoji("🔒"),
      new ButtonBuilder().setCustomId(`claim_${canal.id}`).setLabel("Reivindicar").setStyle(ButtonStyle.Success).setEmoji("✋")
    );

    await canal.send({ content: `<@${user.id}> | Suporte`, embeds: [embed], components: [row] });
    interaction.editReply(config.mensagens.criado.replace("{canal}", `<#${canal.id}>`));
    log("Aberto", { numero: num }, user, `Tipo: ${tipo.label}`);
  }

  // FECHAMENTO
  if (customId.startsWith("close_")) {
    const cId = customId.replace("close_", "");
    const ticket = db.getTicket(cId);
    if (!ticket) return;

    if (!perms.isStaff(interaction.member) && ticket.userId !== user.id) {
      return interaction.reply({ content: config.mensagens.sem_permissao, ephemeral: true });
    }

    await interaction.reply({ content: "🔒 Fechando ticket...", ephemeral: true });
    
    const canal = guild.channels.cache.get(cId);
    if (canal) {
      const file = await transcricao(canal, ticket);
      if (config.canais.canal_transcricoes) {
        const cTrans = guild.channels.cache.get(config.canais.canal_transcricoes);
        if (cTrans) cTrans.send({ content: `Transcrição #${ticket.numero}`, files: [new AttachmentBuilder(file)] });
      }

      if (config.limites.deletar_ao_fechar) {
        setTimeout(() => { canal.delete().catch(() => {}); db.delTicket(cId); }, 5000);
      } else {
        db.setTicket(cId, { status: "fechado" });
        await canal.permissionOverwrites.edit(ticket.userId, { ViewChannel: false });
        if (config.canais.categoria_fechados) canal.setParent(config.canais.categoria_fechados).catch(() => {});
        canal.send({ embeds: [new EmbedBuilder().setColor("#ED4245").setDescription(config.mensagens.fechado.replace("{usuario}", `<@${user.id}>`))] });
      }
      log("Fechado", ticket, user);
    }
  }

  // REIVINDICAR
  if (customId.startsWith("claim_")) {
    if (!perms.isStaff(interaction.member)) return interaction.reply({ content: config.mensagens.sem_permissao, ephemeral: true });
    interaction.reply({ embeds: [new EmbedBuilder().setColor("#FEE75C").setDescription(`✋ Ticket reivindicado por <@${user.id}>`)] });
  }
}

// ------------------------------------------------------------------------------
//   COMANDOS SLASH E EVENTOS
// ------------------------------------------------------------------------------
client.on("ready", async () => {
  console.log(`✅ Bot online como ${client.user.tag}`);
  
  const commands = [
    {
      name: "setup",
      description: "Envia o painel de tickets",
      default_member_permissions: "8" // Administrator
    },
    {
      name: "add",
      description: "Adiciona um usuário ao ticket",
      options: [{ name: "user", type: 6, description: "Usuário", required: true }]
    }
  ];

  const rest = new REST({ version: "10" }).setToken(process.env.TOKEN);
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log("✅ Slash Commands registrados!");
  } catch (e) { console.error(e); }
});

client.on("interactionCreate", async (interaction) => {
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === "setup") {
      if (!perms.isAdmin(interaction.member)) return interaction.reply({ content: config.mensagens.sem_permissao, ephemeral: true });
      
      const embed = new EmbedBuilder()
        .setTitle(config.painel.titulo)
        .setDescription(config.painel.descricao)
        .setColor(config.painel.cor);
      
      let row;
      if (config.painel.tipo_componente === "select") {
        row = new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder().setCustomId("ticket_select").setPlaceholder("Selecione uma opção").addOptions(
            config.tipos_ticket.map(t => ({ label: t.label, value: t.id, description: t.desc, emoji: t.emoji }))
          )
        );
      } else {
        row = new ActionRowBuilder().addComponents(
          config.tipos_ticket.map(t => new ButtonBuilder().setCustomId(`btn_open_${t.id}`).setLabel(t.label).setStyle(ButtonStyle[t.estilo] || ButtonStyle.Primary).setEmoji(t.emoji))
        );
      }
      
      await interaction.channel.send({ embeds: [embed], components: [row] });
      return interaction.reply({ content: "✅ Painel enviado!", ephemeral: true });
    }

    if (interaction.commandName === "add") {
      if (!perms.isStaff(interaction.member)) return interaction.reply({ content: config.mensagens.sem_permissao, ephemeral: true });
      const target = interaction.options.getUser("user");
      await interaction.channel.permissionOverwrites.edit(target.id, { ViewChannel: true, SendMessages: true });
      return interaction.reply({ content: `✅ <@${target.id}> adicionado!` });
    }
  }

  if (interaction.isButton() || interaction.isStringSelectMenu()) {
    handleInteracao(interaction).catch(e => console.error(e));
  }
});

// Rota básica para o Render não dar erro de porta (opcional)
const http = require("http");
http.createServer((req, res) => { res.write("Bot is running!"); res.end(); }).listen(process.env.PORT || 8080);

client.login(process.env.TOKEN);
