import { Telegraf } from "telegraf";
import crypto from "crypto";

// ============ ENV ============

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error("Missing BOT_TOKEN");

const SITE_BASE = String(process.env.SITE_BASE || "").replace(/\/+$/, "");
if (!SITE_BASE) throw new Error("Missing SITE_BASE (e.g. https://rave.onl)");

const ADMIN_IDS = String(process.env.ADMIN_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (ADMIN_IDS.length === 0) {
  console.warn("WARN: ADMIN_IDS is empty. Admin commands will not work.");
}

const TG_CHANNEL_ID = process.env.TG_CHANNEL_ID || ""; // optional

const UP_URL_RAW = process.env.UPSTASH_REDIS_REST_URL;
const UP_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
if (!UP_URL_RAW || !UP_TOKEN) throw new Error("Missing Upstash env vars");

// Upstash URL can be:
// - https://xxxx.upstash.io
// - https://xxxx.upstash.io/command
// - https://xxxx.upstash.io/pipeline
// We normalize it to ".../command"
function getUpstashCommandUrl() {
  const u = String(UP_URL_RAW).trim().replace(/\/+$/, "");
  if (u.endsWith("/command")) return u;
  if (u.endsWith("/pipeline")) return u.replace(/\/pipeline$/, "/command");
  return `${u}/command`;
}

// ============ HELPERS ============

async function redis(cmdArray) {
  // cmdArray must be like ["GET", "key"] / ["LPUSH", "list", "value"] etc.
  if (!Array.isArray(cmdArray) || cmdArray.length === 0) {
    throw new Error("redis(): cmdArray must be a non-empty array");
  }

  const url = getUpstashCommandUrl();

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${UP_TOKEN}`,
      "Content-Type": "application/json",
    },
    // IMPORTANT: Upstash expects JSON array, not {command: ...}
    body: JSON.stringify(cmdArray),
  });

  const data = await resp.json().catch(() => ({}));

  // Upstash usually returns { result: ... } or { error: ... }
  if (!resp.ok || data.error) {
    const msg =
      data?.error ||
      data?.message ||
      `Upstash HTTP ${resp.status} ${resp.statusText}`;
    throw new Error(msg);
  }

  return data.result;
}

function isAdmin(ctx) {
  const id = String(ctx.from?.id || "");
  return ADMIN_IDS.includes(id);
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

function genToken(len = 10) {
  return crypto
    .randomBytes(16)
    .toString("base64url")
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(0, len);
}

function kbForToken(token) {
  return {
    reply_markup: {
      inline_keyboard: [[{ text: "🗑 Удалить ссылку (админ)", callback_data: `del|${token}` }]],
    },
  };
}

async function getTokenRecord(token) {
  const raw = await redis(["GET", `token:${token}`]);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function saveTokenRecord(token, rec) {
  await redis(["SET", `token:${token}`, JSON.stringify(rec)]);
}

async function pushIssued(token) {
  await redis(["LPUSH", "issued", token]);
  await redis(["LTRIM", "issued", "0", "49"]);
}

// ============ CORE FLOW ============

async function issueLinkForUser(ctx) {
  // Take one item from pool (login:key)
  const item = await redis(["RPOP", "pool"]);
  if (!item) {
    await ctx.reply(
      "Сейчас нет доступов. Пожалуйста, подождите — админ пополнит список, и вы сможете запросить ссылку снова."
    );
    await logToChannel(
      `[EMPTY]\nuser=${ctx.from?.username || "-"} id=${ctx.from?.id || "-"}\ntime=${new Date().toISOString()}`
    );
    return;
  }

  // Parse "login:key" (key can contain ':')
  const s = String(item);
  const parts = s.split(":");
  let login = "";
  let key = "";

  if (parts.length >= 2) {
    login = parts.shift() || "";
    key = parts.join(":");
  } else {
    login = `user_${Date.now()}`;
    key = s;
  }

  const token = genToken(10);

  const record = {
    login,
    key,
    issued_to: { id: ctx.from?.id, username: ctx.from?.username },
    created_at: Date.now(),
    revoked: false,
  };

  await saveTokenRecord(token, record);
  await pushIssued(token);

  const link = `${SITE_BASE}/${token}`;

  await ctx.reply(`Ваша персональная ссылка:\n\n${link}`, kbForToken(token));

  await logToChannel(
    `[ISSUED]\nuser=${ctx.from?.username || "-"} id=${ctx.from?.id || "-"}\nlink=${link}\nlogin=${login}\ntime=${new Date().toISOString()}`
  );
}

async function handleDelete(ctx, token) {
  const rec = await getTokenRecord(token);
  if (!rec) return ctx.answerCbQuery("Ссылка не найдена.", { show_alert: true });
  if (!isAdmin(ctx)) return ctx.answerCbQuery("Нет доступа.", { show_alert: true });

  rec.revoked = true;
  rec.revoked_at = Date.now();
  await saveTokenRecord(token, rec);

  await logToChannel(
    `[DELETE]\nby=${ctx.from?.username || "-"} id=${ctx.from?.id || "-"}\ntoken=${token}\ntime=${new Date().toISOString()}`
  );

  return ctx.answerCbQuery("Ссылка удалена (отключена).", { show_alert: true });
}

// ============ BOT ============

const bot = new Telegraf(BOT_TOKEN);

bot.start(async (ctx) => issueLinkForUser(ctx));
bot.command("link", async (ctx) => issueLinkForUser(ctx));

// inline button callback
bot.on("callback_query", async (ctx) => {
  try {
    const data = String(ctx.callbackQuery?.data || "");
    const [op, token] = data.split("|");
    if (!op || !token) return ctx.answerCbQuery();

    if (op === "del") return await handleDelete(ctx, token);

    return ctx.answerCbQuery();
  } catch (_) {
    return ctx.answerCbQuery("Ошибка. Попробуйте ещё раз.", { show_alert: true });
  }
});

// ===== Admin commands =====

bot.command("stock", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const n = await redis(["LLEN", "pool"]);
  await ctx.reply(`В пуле доступов: ${n}`);
});

bot.command("revoke", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const token = String(ctx.message?.text || "").split(/\s+/)[1] || "";
  if (!token) return ctx.reply("Использование: /revoke <token>");

  const rec = await getTokenRecord(token);
  if (!rec) return ctx.reply("Токен не найден.");

  rec.revoked = true;
  rec.revoked_at = Date.now();
  await saveTokenRecord(token, rec);

  await ctx.reply(`Ок. Ссылка отключена: ${token}`);
  await logToChannel(
    `[REVOKE]\nadmin=${ctx.from?.username || "-"} id=${ctx.from?.id || "-"}\ntoken=${token}\ntime=${new Date().toISOString()}`
  );
});

bot.command("info", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const token = String(ctx.message?.text || "").split(/\s+/)[1] || "";
  if (!token) return ctx.reply("Использование: /info <token>");

  const rec = await getTokenRecord(token);
  if (!rec) return ctx.reply("Токен не найден.");

  const status = rec.revoked ? "REVOKED" : "ACTIVE";

  await ctx.reply(
    `token: ${token}` +
      `\nstatus: ${status}` +
      `\nlogin: ${rec.login || "-"}` +
      `\nissued_to: ${rec.issued_to?.username || "-"} (${rec.issued_to?.id || "-"})` +
      `\ncreated: ${new Date(rec.created_at).toISOString()}`
  );
});

bot.command("list", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const tokens = await redis(["LRANGE", "issued", "0", "9"]).catch(() => []);
  if (!tokens || tokens.length === 0) return ctx.reply("Список пуст.");
  await ctx.reply("Последние токены:\n" + tokens.map((t) => `- ${t}`).join("\n"));
});

// /upload: admin sends lines after command OR attaches .txt
bot.command("upload", async (ctx) => {
  if (!isAdmin(ctx)) return;

  const msg = ctx.message;

  // If message has document (txt)
  if (msg?.document) {
    const fileId = msg.document.file_id;
    const file = await ctx.telegram.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
    const text = await (await fetch(fileUrl)).text();
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

    if (!lines.length) return ctx.reply("Файл пустой.");

    for (const line of lines) await redis(["LPUSH", "pool", line]);

    await ctx.reply(`Загружено в пул: ${lines.length}`);
    await logToChannel(
      `[UPLOAD]\nadmin=${ctx.from?.username || "-"}\ncount=${lines.length}\ntime=${new Date().toISOString()}`
    );
    return;
  }

  // Otherwise parse text after /upload
  const text = String(msg?.text || "");
  const body = text.replace(/^\/upload(@\w+)?\s*/i, "");
  const lines = body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  if (!lines.length) {
    return ctx.reply(
      "Пришли /upload и далее строки вида login:key (каждая с новой строки) или отправь .txt файлом."
    );
  }

  for (const line of lines) await redis(["LPUSH", "pool", line]);

  await ctx.reply(`Загружено в пул: ${lines.length}`);
  await logToChannel(
    `[UPLOAD]\nadmin=${ctx.from?.username || "-"}\ncount=${lines.length}\ntime=${new Date().toISOString()}`
  );
});

// global error handler
bot.catch(async (err, ctx) => {
  console.error("Bot error", err);
  try {
    await ctx.reply("Ошибка. Попробуйте позже.");
  } catch (_) {}
});

bot.launch();
console.log("Bot started");

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
