import { Telegraf } from "telegraf";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";

// ========= ENV =========
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error("Missing BOT_TOKEN");

const SITE_BASE = String(process.env.SITE_BASE || "").replace(/\/+$/, "");
if (!SITE_BASE) throw new Error("Missing SITE_BASE (e.g. https://rave.onl)");

const ADMIN_IDS = String(process.env.ADMIN_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const TG_CHANNEL_ID = process.env.TG_CHANNEL_ID || ""; // optional

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// ========= HELPERS =========
function isAdmin(ctx) {
  const id = String(ctx.from?.id || "");
  return ADMIN_IDS.includes(id);
}

function genToken(len = 10) {
  return crypto
    .randomBytes(16)
    .toString("base64url")
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(0, len);
}

async function logToChannel(text) {
  if (!TG_CHANNEL_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TG_CHANNEL_ID,
        text,
        disable_web_page_preview: true,
      }),
    });
  } catch (_) {}
}

function kbForToken(token, showAdminButton) {
  if (!showAdminButton) return undefined;
  return {
    reply_markup: {
      inline_keyboard: [[{ text: "🗑 Удалить ссылку (админ)", callback_data: `del|${token}` }]],
    },
  };
}

function parseLoginKey(line) {
  const s = String(line || "");
  const parts = s.split(":");
  if (parts.length >= 2) {
    const login = parts.shift();
    const key = parts.join(":");
    return { login, key };
  }
  return { login: `user_${Date.now()}`, key: s };
}

// ========= SUPABASE QUERIES =========
async function poolCount() {
  const { count, error } = await supabase
    .from("pool_items")
    .select("*", { count: "exact", head: true })
    .eq("used", false);

  if (error) throw error;
  return count || 0;
}

async function popPoolItemWithRetry(userId, username, tries = 5) {
  for (let i = 0; i < tries; i++) {
    const { data: rows, error: selErr } = await supabase
      .from("pool_items")
      .select("id,value")
      .eq("used", false)
      .order("id", { ascending: true })
      .limit(1);

    if (selErr) throw selErr;
    if (!rows || rows.length === 0) return null;

    const item = rows[0];

    // атомарность через условие used=false
    const { data: upd, error: updErr } = await supabase
      .from("pool_items")
      .update({
        used: true,
        used_at: new Date().toISOString(),
        used_by_id: String(userId || ""),
        used_by_username: String(username || ""),
      })
      .eq("id", item.id)
      .eq("used", false)
      .select("id,value")
      .limit(1);

    if (updErr) throw updErr;
    if (upd && upd.length > 0) return upd[0];
    // иначе кто-то успел взять — повторяем
  }
  return null;
}

async function insertPoolItems(lines) {
  const rows = lines.map((v) => ({ value: v }));
  // батчим по 500
  const chunkSize = 500;
  let inserted = 0;

  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const { error } = await supabase.from("pool_items").insert(chunk);
    if (error) throw error;
    inserted += chunk.length;
  }
  return inserted;
}

async function insertTokenRecord(rec) {
  const { error } = await supabase.from("tokens").insert(rec);
  if (error) throw error;
}

async function getTokenRecord(token) {
  const { data, error } = await supabase
    .from("tokens")
    .select("*")
    .eq("token", token)
    .limit(1);

  if (error) throw error;
  return data?.[0] || null;
}

async function revokeToken(token, by) {
  const patch = {
    revoked: true,
    revoked_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from("tokens")
    .update(patch)
    .eq("token", token)
    .select("*")
    .limit(1);

  if (error) throw error;
  return data?.[0] || null;
}

async function lastTokens(limit = 10) {
  const { data, error } = await supabase
    .from("tokens")
    .select("token,login,issued_to_id,issued_to_username,created_at,revoked,revoked_at")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data || [];
}

// ========= BOT =========
const bot = new Telegraf(BOT_TOKEN);

// Команды в меню "/": public
async function setupCommands() {
  // публичные
  await bot.telegram.setMyCommands(
    [
      { command: "start", description: "Статус и сколько доступов в пуле" },
      { command: "link", description: "Получить персональную ссылку" },
    ],
    { scope: { type: "default" } }
  );

  // админские (видны только админу, в его личном чате с ботом)
  const adminCmds = [
    { command: "stock", description: "Сколько доступов в пуле" },
    { command: "upload", description: "Загрузить доступы (текст или .txt)" },
    { command: "list", description: "Последние токены + кто получил" },
    { command: "info", description: "Инфо по токену: /info <token>" },
    { command: "revoke", description: "Отключить токен: /revoke <token>" },
  ];

  for (const id of ADMIN_IDS) {
    const chat_id = Number(id);
    if (!Number.isFinite(chat_id)) continue;
    await bot.telegram.setMyCommands(adminCmds, { scope: { type: "chat", chat_id } });
  }
}

async function issueLinkForUser(ctx) {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "-";

  const item = await popPoolItemWithRetry(userId, username);
  if (!item) {
    await ctx.reply("Сейчас нет доступов. Подождите — админ пополнит список, и попробуйте /link позже.");
    await logToChannel(
      `[EMPTY]\nuser=@${username}\nid=${userId || "-"}\ntime=${new Date().toISOString()}`
    );
    return;
  }

  const { login, key } = parseLoginKey(item.value);
  const token = genToken(10);
  const link = `${SITE_BASE}/${token}`;

  await insertTokenRecord({
    token,
    login,
    key,
    issued_to_id: String(userId || ""),
    issued_to_username: String(username || ""),
    revoked: false,
  });

  await ctx.reply(`Ваша ссылка:\n\n${link}`);

  await logToChannel(
    `[ISSUED]\ntoken=${token}\nlink=${link}\nlogin=${login}\nuser=@${username}\nid=${userId || "-"}\ntime=${new Date().toISOString()}`
  );
}

async function handleDelete(ctx, token) {
  if (!isAdmin(ctx)) {
    return ctx.answerCbQuery("Нет доступа.", { show_alert: true });
  }

  const rec = await revokeToken(token, ctx.from?.id).catch(() => null);
  if (!rec) return ctx.answerCbQuery("Токен не найден.", { show_alert: true });

  await logToChannel(
    `[DELETE]\nadmin=@${ctx.from?.username || "-"}\nid=${ctx.from?.id || "-"}\ntoken=${token}\nlink=${SITE_BASE}/${token}\ntime=${new Date().toISOString()}`
  );

  return ctx.answerCbQuery("Ссылка отключена.", { show_alert: true });
}

// ===== PUBLIC =====
bot.start(async (ctx) => {
  try {
    const n = await poolCount();
    await ctx.reply(
      `Привет!\n\n` +
      `Доступов в пуле: ${n}\n\n` +
      `Чтобы получить ссылку — нажми /link`
    );
  } catch (e) {
    await logToChannel(`[ERROR]\nwhere=start\nerr=${String(e?.message || e)}\ntime=${new Date().toISOString()}`);
    await ctx.reply("Ошибка. Попробуйте позже.");
  }
});

bot.command("link", async (ctx) => {
  try {
    await issueLinkForUser(ctx);
  } catch (e) {
    await logToChannel(`[ERROR]\nwhere=link\nerr=${String(e?.message || e)}\ntime=${new Date().toISOString()}`);
    await ctx.reply("Ошибка. Попробуйте позже.");
  }
});

// callback delete
bot.on("callback_query", async (ctx) => {
  try {
    const data = String(ctx.callbackQuery?.data || "");
    const [op, token] = data.split("|");
    if (op === "del" && token) return await handleDelete(ctx, token);
    return ctx.answerCbQuery();
  } catch {
    return ctx.answerCbQuery("Ошибка. Попробуйте ещё раз.", { show_alert: true });
  }
});

// ===== ADMIN =====
bot.command("stock", async (ctx) => {
  if (!isAdmin(ctx)) return;
  try {
    const n = await poolCount();
    await ctx.reply(`В пуле доступов: ${n}`);
    await logToChannel(`[STOCK]\nadmin=@${ctx.from?.username || "-"}\nid=${ctx.from?.id || "-"}\ncount=${n}\ntime=${new Date().toISOString()}`);
  } catch (e) {
    await logToChannel(`[ERROR]\nwhere=stock\nerr=${String(e?.message || e)}\ntime=${new Date().toISOString()}`);
    await ctx.reply("Ошибка. Попробуйте позже.");
  }
});

bot.command("revoke", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const token = String(ctx.message?.text || "").split(/\s+/)[1] || "";
  if (!token) return ctx.reply("Использование: /revoke <token>");

  try {
    const rec = await revokeToken(token, ctx.from?.id);
    if (!rec) return ctx.reply("Токен не найден.");

    await ctx.reply(`Ок. Ссылка отключена:\n${SITE_BASE}/${token}`);
    await logToChannel(
      `[REVOKE]\nadmin=@${ctx.from?.username || "-"}\nid=${ctx.from?.id || "-"}\ntoken=${token}\nlink=${SITE_BASE}/${token}\ntime=${new Date().toISOString()}`
    );
  } catch (e) {
    await logToChannel(`[ERROR]\nwhere=revoke\nerr=${String(e?.message || e)}\ntime=${new Date().toISOString()}`);
    await ctx.reply("Ошибка. Попробуйте позже.");
  }
});

bot.command("info", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const token = String(ctx.message?.text || "").split(/\s+/)[1] || "";
  if (!token) return ctx.reply("Использование: /info <token>");

  try {
    const rec = await getTokenRecord(token);
    if (!rec) return ctx.reply("Токен не найден.");

    const status = rec.revoked ? "REVOKED" : "ACTIVE";
    const link = `${SITE_BASE}/${token}`;
    const user = rec.issued_to_username ? `@${rec.issued_to_username}` : "-";
    const uid = rec.issued_to_id || "-";

    await ctx.reply(
      `token: ${token}` +
        `\nlink: ${link}` +
        `\nstatus: ${status}` +
        `\nlogin: ${rec.login || "-"}` +
        `\nuser: ${user} (${uid})` +
        `\ncreated: ${new Date(rec.created_at).toISOString()}` +
        (rec.revoked_at ? `\nrevoked_at: ${new Date(rec.revoked_at).toISOString()}` : "") +
        `\n\nУдалить: кнопка 🗑 или /revoke ${token}`,
      kbForToken(token, true)
    );

    await logToChannel(
      `[INFO]\nadmin=@${ctx.from?.username || "-"}\nid=${ctx.from?.id || "-"}\ntoken=${token}\nstatus=${status}\nuser=${user}\nuid=${uid}\nlink=${link}\ntime=${new Date().toISOString()}`
    );
  } catch (e) {
    await logToChannel(`[ERROR]\nwhere=info\nerr=${String(e?.message || e)}\ntime=${new Date().toISOString()}`);
    await ctx.reply("Ошибка. Попробуйте позже.");
  }
});

bot.command("list", async (ctx) => {
  if (!isAdmin(ctx)) return;

  try {
    const items = await lastTokens(10);
    if (!items.length) return ctx.reply("Список пуст.");

    const rows = items.map((r) => {
      const token = r.token;
      const link = `${SITE_BASE}/${token}`;
      const user = r.issued_to_username ? `@${r.issued_to_username}` : "-";
      const uid = r.issued_to_id || "-";
      const status = r.revoked ? "REVOKED" : "ACTIVE";
      return `${token} — ${user} (${uid}) — ${status}\n${link}`;
    });

    await ctx.reply(
      `Последние токены:\n\n` +
        rows.join("\n\n") +
        `\n\nУдалить ссылку:\n` +
        `• /revoke <token>\n` +
        `• или /info <token> → 🗑`
    );

    await logToChannel(
      `[LIST]\nadmin=@${ctx.from?.username || "-"}\nid=${ctx.from?.id || "-"}\ncount=${items.length}\ntime=${new Date().toISOString()}`
    );
  } catch (e) {
    await logToChannel(`[ERROR]\nwhere=list\nerr=${String(e?.message || e)}\ntime=${new Date().toISOString()}`);
    await ctx.reply("Ошибка. Попробуйте позже.");
  }
});

bot.command("upload", async (ctx) => {
  if (!isAdmin(ctx)) return;

  try {
    const msg = ctx.message;

    // если документ .txt
    if (msg?.document) {
      const fileId = msg.document.file_id;
      const file = await ctx.telegram.getFile(fileId);
      const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
      const text = await (await fetch(fileUrl)).text();
      const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

      if (!lines.length) return ctx.reply("Файл пустой.");

      const inserted = await insertPoolItems(lines);
      const n = await poolCount();

      await ctx.reply(`Загружено: ${inserted}\nТеперь в пуле: ${n}`);
      await logToChannel(
        `[UPLOAD]\nadmin=@${ctx.from?.username || "-"}\nid=${ctx.from?.id || "-"}\ncount=${inserted}\npool_now=${n}\ntime=${new Date().toISOString()}`
      );
      return;
    }

    // иначе текст после /upload
    const text = String(msg?.text || "");
    const body = text.replace(/^\/upload(@\w+)?\s*/i, "");
    const lines = body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

    if (!lines.length) {
      return ctx.reply("Пришли /upload и далее строки login:key (каждая с новой строки) или отправь .txt файлом.");
    }

    const inserted = await insertPoolItems(lines);
    const n = await poolCount();

    await ctx.reply(`Загружено: ${inserted}\nТеперь в пуле: ${n}`);
    await logToChannel(
      `[UPLOAD]\nadmin=@${ctx.from?.username || "-"}\nid=${ctx.from?.id || "-"}\ncount=${inserted}\npool_now=${n}\ntime=${new Date().toISOString()}`
    );
  } catch (e) {
    await logToChannel(`[ERROR]\nwhere=upload\nerr=${String(e?.message || e)}\ntime=${new Date().toISOString()}`);
    await ctx.reply("Ошибка. Попробуйте позже.");
  }
});

bot.catch(async (err, ctx) => {
  console.error("Bot error", err);
  await logToChannel(`[ERROR]\nwhere=bot.catch\nerr=${String(err?.message || err)}\ntime=${new Date().toISOString()}`);
  try { await ctx.reply("Ошибка. Попробуйте позже."); } catch (_) {}
});

// запуск
await setupCommands();
await bot.launch();
console.log("Bot started");

// graceful shutdown
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
