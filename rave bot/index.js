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

async function tgLog(text) {
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

async function dbLog({ type, message, actor_id, actor_username, token }) {
  try {
    await supabase.from("logs").insert({
      type,
      message,
      actor_id: actor_id ? String(actor_id) : null,
      actor_username: actor_username ? String(actor_username) : null,
      token: token ? String(token) : null,
    });
  } catch (_) {}
}

async function logAll(payload) {
  // payload: {type, message, actor_id, actor_username, token}
  const text =
    `[${payload.type}]` +
    (payload.token ? `\ntoken=${payload.token}` : "") +
    (payload.actor_username ? `\nuser=@${payload.actor_username}` : "") +
    (payload.actor_id ? `\nid=${payload.actor_id}` : "") +
    `\n${payload.message}` +
    `\ntime=${new Date().toISOString()}`;

  await tgLog(text);
  await dbLog(payload);
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

async function popPoolItemWithRetry(userId, username, tries = 7) {
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

    // атомарно: берём только если used=false
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
  }
  return null;
}

async function insertPoolItems(lines) {
  const rows = lines.map((v) => ({ value: v }));
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

async function revokeToken(token) {
  const { data, error } = await supabase
    .from("tokens")
    .update({ revoked: true, revoked_at: new Date().toISOString() })
    .eq("token", token)
    .select("*")
    .limit(1);

  if (error) throw error;
  return data?.[0] || null;
}

async function lastTokens(limit = 10, onlyActive = false) {
  let q = supabase
    .from("tokens")
    .select("token,login,issued_to_id,issued_to_username,created_at,revoked,revoked_at,access_count,last_access_at")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (onlyActive) q = q.eq("revoked", false);

  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

async function tokensByUser(queryText, limit = 20) {
  // ищем по username или id
  const q = String(queryText || "").trim().replace(/^@/, "");
  if (!q) return [];

  const { data, error } = await supabase
    .from("tokens")
    .select("token,login,issued_to_id,issued_to_username,created_at,revoked,access_count,last_access_at")
    .or(`issued_to_username.ilike.%${q}%,issued_to_id.ilike.%${q}%`)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data || [];
}

// ========= BOT =========
const bot = new Telegraf(BOT_TOKEN);

// команды в меню "/"
async function setupCommands() {
  // публичные
  await bot.telegram.setMyCommands(
    [
      { command: "start", description: "Статус и сколько доступов осталось" },
      { command: "link", description: "Получить персональную ссылку" },
    ],
    { scope: { type: "default" } }
  );

  // админские (видны только админам)
  const adminCmds = [
    { command: "stock", description: "Сколько доступов в пуле" },
    { command: "upload", description: "Загрузить доступы (текст или .txt)" },
    { command: "active", description: "Последние активные токены" },
    { command: "list", description: "Последние токены (включая revoked)" },
    { command: "search", description: "Найти токены по юзеру: /search @name или id" },
    { command: "info", description: "Инфо по токену: /info <token>" },
    { command: "revoke", description: "Отключить токен: /revoke <token>" },
    { command: "logs", description: "Последние логи: /logs или /logs <тип>" },
  ];

  for (const id of ADMIN_IDS) {
    const chat_id = Number(id);
    if (!Number.isFinite(chat_id)) continue;
    await bot.telegram.setMyCommands(adminCmds, { scope: { type: "chat", chat_id } });
  }
}

// публичная ссылка — ведёт на Netlify function роут /t/<token>
function tokenLink(token) {
  return `${SITE_BASE}/t/${token}`;
}

// ===== PUBLIC =====
bot.start(async (ctx) => {
  try {
    const n = await poolCount();
    await ctx.reply(
      `Готово.\n\nДоступов в пуле: ${n}\n\nЧтобы получить ссылку — нажми /link`
    );
  } catch (e) {
    await logAll({
      type: "ERROR",
      message: `where=start\nerr=${String(e?.message || e)}`,
      actor_id: ctx.from?.id,
      actor_username: ctx.from?.username,
    });
    await ctx.reply("Ошибка. Попробуйте позже.");
  }
});

bot.command("link", async (ctx) => {
  try {
    const userId = ctx.from?.id;
    const username = ctx.from?.username || "-";

    const item = await popPoolItemWithRetry(userId, username);
    if (!item) {
      await ctx.reply("Сейчас нет доступов. Подождите — админ пополнит пул.");
      await logAll({
        type: "EMPTY",
        message: "pool empty",
        actor_id: userId,
        actor_username: username,
      });
      return;
    }

    const { login, key } = parseLoginKey(item.value);
    const token = genToken(10);

    await insertTokenRecord({
      token,
      login,
      key,
      issued_to_id: String(userId || ""),
      issued_to_username: String(username || ""),
      revoked: false,
    });

    const link = tokenLink(token);

    await ctx.reply(`Ваша ссылка:\n\n${link}`);

    await logAll({
      type: "ISSUED",
      message: `link=${link}\nlogin=${login}`,
      actor_id: userId,
      actor_username: username,
      token,
    });
  } catch (e) {
    await logAll({
      type: "ERROR",
      message: `where=link\nerr=${String(e?.message || e)}`,
      actor_id: ctx.from?.id,
      actor_username: ctx.from?.username,
    });
    await ctx.reply("Ошибка. Попробуйте позже.");
  }
});

// callback delete — только админу
bot.on("callback_query", async (ctx) => {
  try {
    const data = String(ctx.callbackQuery?.data || "");
    const [op, token] = data.split("|");
    if (op !== "del" || !token) return ctx.answerCbQuery();

    if (!isAdmin(ctx)) return ctx.answerCbQuery("Нет доступа.", { show_alert: true });

    const rec = await revokeToken(token);
    if (!rec) return ctx.answerCbQuery("Токен не найден.", { show_alert: true });

    await logAll({
      type: "DELETE",
      message: `revoked via button\nlink=${tokenLink(token)}`,
      actor_id: ctx.from?.id,
      actor_username: ctx.from?.username,
      token,
    });

    return ctx.answerCbQuery("Ссылка отключена.", { show_alert: true });
  } catch (e) {
    await logAll({
      type: "ERROR",
      message: `where=callback_query\nerr=${String(e?.message || e)}`,
      actor_id: ctx.from?.id,
      actor_username: ctx.from?.username,
    });
    return ctx.answerCbQuery("Ошибка.", { show_alert: true });
  }
});

// ===== ADMIN =====
bot.command("stock", async (ctx) => {
  if (!isAdmin(ctx)) return;
  try {
    const n = await poolCount();
    await ctx.reply(`В пуле доступов: ${n}`);
    await logAll({
      type: "STOCK",
      message: `count=${n}`,
      actor_id: ctx.from?.id,
      actor_username: ctx.from?.username,
    });
  } catch (e) {
    await logAll({
      type: "ERROR",
      message: `where=stock\nerr=${String(e?.message || e)}`,
      actor_id: ctx.from?.id,
      actor_username: ctx.from?.username,
    });
    await ctx.reply("Ошибка. Попробуйте позже.");
  }
});

bot.command("upload", async (ctx) => {
  if (!isAdmin(ctx)) return;

  try {
    const msg = ctx.message;

    // .txt
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

      await logAll({
        type: "UPLOAD",
        message: `count=${inserted}\npool_now=${n}`,
        actor_id: ctx.from?.id,
        actor_username: ctx.from?.username,
      });
      return;
    }

    // текст
    const text = String(msg?.text || "");
    const body = text.replace(/^\/upload(@\w+)?\s*/i, "");
    const lines = body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

    if (!lines.length) {
      return ctx.reply("Пришли /upload и далее строки login:key (каждая с новой строки) или отправь .txt файлом.");
    }

    const inserted = await insertPoolItems(lines);
    const n = await poolCount();
    await ctx.reply(`Загружено: ${inserted}\nТеперь в пуле: ${n}`);

    await logAll({
      type: "UPLOAD",
      message: `count=${inserted}\npool_now=${n}`,
      actor_id: ctx.from?.id,
      actor_username: ctx.from?.username,
    });
  } catch (e) {
    await logAll({
      type: "ERROR",
      message: `where=upload\nerr=${String(e?.message || e)}`,
      actor_id: ctx.from?.id,
      actor_username: ctx.from?.username,
    });
    await ctx.reply("Ошибка. Попробуйте позже.");
  }
});

bot.command("revoke", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const token = String(ctx.message?.text || "").split(/\s+/)[1] || "";
  if (!token) return ctx.reply("Использование: /revoke <token>");

  try {
    const rec = await revokeToken(token);
    if (!rec) return ctx.reply("Токен не найден.");

    await ctx.reply(`Ок. Ссылка отключена:\n${tokenLink(token)}`);

    await logAll({
      type: "REVOKE",
      message: `link=${tokenLink(token)}`,
      actor_id: ctx.from?.id,
      actor_username: ctx.from?.username,
      token,
    });
  } catch (e) {
    await logAll({
      type: "ERROR",
      message: `where=revoke\nerr=${String(e?.message || e)}`,
      actor_id: ctx.from?.id,
      actor_username: ctx.from?.username,
    });
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
    const user = rec.issued_to_username ? `@${rec.issued_to_username}` : "-";
    const uid = rec.issued_to_id || "-";
    const link = tokenLink(token);

    // кнопку удаления показываем ТОЛЬКО админу
    const extra = {
      reply_markup: {
        inline_keyboard: [[{ text: "🗑 Отключить (админ)", callback_data: `del|${token}` }]],
      },
    };

    await ctx.reply(
      `token: ${token}` +
        `\nlink: ${link}` +
        `\nstatus: ${status}` +
        `\nlogin: ${rec.login || "-"}` +
        `\nuser: ${user} (${uid})` +
        `\ncreated: ${new Date(rec.created_at).toISOString()}` +
        `\naccess_count: ${rec.access_count || 0}` +
        (rec.last_access_at ? `\nlast_access: ${new Date(rec.last_access_at).toISOString()}` : "") +
        (rec.revoked_at ? `\nrevoked_at: ${new Date(rec.revoked_at).toISOString()}` : "") +
        `\n\nУдалить: 🗑 или /revoke ${token}`,
      extra
    );

    await logAll({
      type: "INFO",
      message: `status=${status}\nuser=${user} (${uid})\nlink=${link}`,
      actor_id: ctx.from?.id,
      actor_username: ctx.from?.username,
      token,
    });
  } catch (e) {
    await logAll({
      type: "ERROR",
      message: `where=info\nerr=${String(e?.message || e)}`,
      actor_id: ctx.from?.id,
      actor_username: ctx.from?.username,
    });
    await ctx.reply("Ошибка. Попробуйте позже.");
  }
});

bot.command("active", async (ctx) => {
  if (!isAdmin(ctx)) return;
  try {
    const items = await lastTokens(10, true);
    if (!items.length) return ctx.reply("Активных токенов нет.");

    const rows = items.map((r) => {
      const user = r.issued_to_username ? `@${r.issued_to_username}` : "-";
      const uid = r.issued_to_id || "-";
      return `${r.token} — ${user} (${uid}) — access=${r.access_count || 0}\n${tokenLink(r.token)}`;
    });

    await ctx.reply("Активные токены:\n\n" + rows.join("\n\n"));

    await logAll({
      type: "ACTIVE",
      message: `count=${items.length}`,
      actor_id: ctx.from?.id,
      actor_username: ctx.from?.username,
    });
  } catch (e) {
    await logAll({
      type: "ERROR",
      message: `where=active\nerr=${String(e?.message || e)}`,
      actor_id: ctx.from?.id,
      actor_username: ctx.from?.username,
    });
    await ctx.reply("Ошибка. Попробуйте позже.");
  }
});

bot.command("list", async (ctx) => {
  if (!isAdmin(ctx)) return;
  try {
    const items = await lastTokens(10, false);
    if (!items.length) return ctx.reply("Список пуст.");

    const rows = items.map((r) => {
      const user = r.issued_to_username ? `@${r.issued_to_username}` : "-";
      const uid = r.issued_to_id || "-";
      const status = r.revoked ? "REVOKED" : "ACTIVE";
      return `${r.token} — ${user} (${uid}) — ${status}\n${tokenLink(r.token)}`;
    });

    await ctx.reply(
      `Последние токены:\n\n${rows.join("\n\n")}\n\nУдалить:\n• /revoke <token>\n• или /info <token> → 🗑`
    );

    await logAll({
      type: "LIST",
      message: `count=${items.length}`,
      actor_id: ctx.from?.id,
      actor_username: ctx.from?.username,
    });
  } catch (e) {
    await logAll({
      type: "ERROR",
      message: `where=list\nerr=${String(e?.message || e)}`,
      actor_id: ctx.from?.id,
      actor_username: ctx.from?.username,
    });
    await ctx.reply("Ошибка. Попробуйте позже.");
  }
});

bot.command("search", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const q = String(ctx.message?.text || "").split(/\s+/).slice(1).join(" ").trim();
  if (!q) return ctx.reply("Использование: /search @username или /search <id>");

  try {
    const items = await tokensByUser(q, 20);
    if (!items.length) return ctx.reply("Ничего не найдено.");

    const rows = items.map((r) => {
      const user = r.issued_to_username ? `@${r.issued_to_username}` : "-";
      const uid = r.issued_to_id || "-";
      const status = r.revoked ? "REVOKED" : "ACTIVE";
      return `${r.token} — ${user} (${uid}) — ${status} — access=${r.access_count || 0}\n${tokenLink(r.token)}`;
    });

    await ctx.reply(`Найдено: ${items.length}\n\n${rows.join("\n\n")}`);

    await logAll({
      type: "SEARCH",
      message: `query=${q}\ncount=${items.length}`,
      actor_id: ctx.from?.id,
      actor_username: ctx.from?.username,
    });
  } catch (e) {
    await logAll({
      type: "ERROR",
      message: `where=search\nerr=${String(e?.message || e)}`,
      actor_id: ctx.from?.id,
      actor_username: ctx.from?.username,
    });
    await ctx.reply("Ошибка. Попробуйте позже.");
  }
});

bot.command("logs", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const type = String(ctx.message?.text || "").split(/\s+/)[1] || ""; // optional filter

  try {
    let q = supabase
      .from("logs")
      .select("type,message,actor_id,actor_username,token,created_at")
      .order("created_at", { ascending: false })
      .limit(15);

    if (type) q = q.eq("type", type.toUpperCase());

    const { data, error } = await q;
    if (error) throw error;

    if (!data || data.length === 0) return ctx.reply("Логов нет.");

    const rows = data.map((r) => {
      const who = r.actor_username ? `@${r.actor_username}` : "-";
      const tok = r.token ? ` token=${r.token}` : "";
      return `${r.created_at} [${r.type}] ${who}${tok}\n${r.message}`;
    });

    await ctx.reply(rows.join("\n\n"));
  } catch (e) {
    await logAll({
      type: "ERROR",
      message: `where=logs\nerr=${String(e?.message || e)}`,
      actor_id: ctx.from?.id,
      actor_username: ctx.from?.username,
    });
    await ctx.reply("Ошибка. Попробуйте позже.");
  }
});

bot.catch(async (err, ctx) => {
  console.error("Bot error", err);
  await logAll({
    type: "ERROR",
    message: `where=bot.catch\nerr=${String(err?.message || err)}`,
    actor_id: ctx?.from?.id,
    actor_username: ctx?.from?.username,
  });
  try { await ctx.reply("Ошибка. Попробуйте позже."); } catch (_) {}
});

// запуск
await setupCommands();
await bot.launch();
console.log("Bot started");

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
