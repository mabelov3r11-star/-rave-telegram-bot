import { Telegraf } from "telegraf";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";

// ===== ENV =====
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error("Missing BOT_TOKEN");

const SITE_BASE = (process.env.SITE_BASE || "").replace(/\/+$/, "");
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

// ===== Helpers =====
function isAdmin(ctx) {
  const id = String(ctx.from?.id || "");
  return ADMIN_IDS.includes(id);
}

function genToken(len = 10) {
  return crypto
    .randomBytes(24)
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

function kbForToken(token) {
  return {
    reply_markup: {
      inline_keyboard: [[{ text: "🗑 Удалить ссылку (админ)", callback_data: `del|${token}` }]],
    },
  };
}

// ===== DB: pool =====
async function popPoolItem() {
  // Берём самый старый неиспользованный и помечаем used_at (аналог RPOP)
  const { data: row, error: selErr } = await supabase
    .from("pool_items")
    .select("id,value")
    .is("used_at", null)
    .order("id", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (selErr) throw selErr;
  if (!row) return null;

  const { error: updErr } = await supabase
    .from("pool_items")
    .update({ used_at: new Date().toISOString() })
    .eq("id", row.id);

  if (updErr) throw updErr;
  return row.value;
}

async function pushPoolLines(lines) {
  if (!lines.length) return 0;
  const payload = lines.map((value) => ({ value }));
  const { error } = await supabase.from("pool_items").insert(payload);
  if (error) throw error;
  return lines.length;
}

async function countPool() {
  const { count, error } = await supabase
    .from("pool_items")
    .select("*", { count: "exact", head: true })
    .is("used_at", null);
  if (error) throw error;
  return count || 0;
}

// ===== DB: tokens =====
async function saveTokenRecord(rec) {
  const { error } = await supabase.from("tokens").upsert(rec, { onConflict: "token" });
  if (error) throw error;
}

async function getTokenRecord(token) {
  const { data, error } = await supabase.from("tokens").select("*").eq("token", token).maybeSingle();
  if (error) throw error;
  return data || null;
}

async function revokeToken(token, by) {
  const { error } = await supabase
    .from("tokens")
    .update({ revoked: true, revoked_at: new Date().toISOString() })
    .eq("token", token);
  if (error) throw error;

  await logToChannel(
    `[REVOKE]\nby=${by.username || "-"} id=${by.id || "-"}\ntoken=${token}\ntime=${new Date().toISOString()}`
  );
}

async function lastIssued(n = 10) {
  const { data, error } = await supabase
    .from("tokens")
    .select("token,created_at,revoked")
    .order("created_at", { ascending: false })
    .limit(n);
  if (error) throw error;
  return data || [];
}

// ===== Bot logic =====
async function issueLinkForUser(ctx) {
  const item = await popPoolItem();
  if (!item) {
    await ctx.reply("Сейчас нет доступов. Пожалуйста, подождите — админ пополнит список и попробуйте снова.");
    await logToChannel(
      `[EMPTY]\nuser=${ctx.from?.username || "-"} id=${ctx.from?.id || "-"}\ntime=${new Date().toISOString()}`
    );
    return;
  }

  // "login:key" (key может содержать ':')
  const s = String(item);
  const parts = s.split(":");
  let login = "";
  let key = "";
  if (parts.length >= 2) {
    login = parts.shift();
    key = parts.join(":");
  } else {
    login = `user_${Date.now()}`;
    key = s;
  }

  const token = genToken(10);
  const rec = {
    token,
    login,
    key,
    issued_to_id: String(ctx.from?.id || ""),
    issued_to_username: String(ctx.from?.username || ""),
    created_at: new Date().toISOString(),
    revoked: false,
    revoked_at: null,
  };

  await saveTokenRecord(rec);

  const link = `${SITE_BASE}/${token}`;

  await ctx.reply(`Ваша персональная ссылка:\n\n${link}`, kbForToken(token));

  await logToChannel(
    `[ISSUED]\nuser=${ctx.from?.username || "-"} id=${ctx.from?.id || "-"}\nlink=${link}\nlogin=${login}\ntime=${new Date().toISOString()}`
  );
}

async function handleDelete(ctx, token) {
  if (!isAdmin(ctx)) return ctx.answerCbQuery("Нет доступа.", { show_alert: true });

  const rec = await getTokenRecord(token);
  if (!rec) return ctx.answerCbQuery("Ссылка не найдена.", { show_alert: true });

  await supabase
    .from("tokens")
    .update({ revoked: true, revoked_at: new Date().toISOString() })
    .eq("token", token);

  await logToChannel(
    `[DELETE]\nby=${ctx.from?.username || "-"} id=${ctx.from?.id || "-"}\ntoken=${token}\ntime=${new Date().toISOString()}`
  );

  return ctx.answerCbQuery("Ссылка удалена (отключена).", { show_alert: true });
}

// ===== Start bot =====
const bot = new Telegraf(BOT_TOKEN);

bot.start(issueLinkForUser);
bot.command("link", issueLinkForUser);

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

// ===== Admin commands =====
bot.command("stock", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const n = await countPool();
  await ctx.reply(`В пуле доступов: ${n}`);
});

bot.command("revoke", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const token = String(ctx.message?.text || "").split(/\s+/)[1] || "";
  if (!token) return ctx.reply("Использование: /revoke <token>");

  const rec = await getTokenRecord(token);
  if (!rec) return ctx.reply("Токен не найден.");

  await revokeToken(token, { id: ctx.from?.id, username: ctx.from?.username });
  await ctx.reply(`Ок. Ссылка отключена: ${token}`);
});

bot.command("info", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const token = String(ctx.message?.text || "").split(/\s+/)[1] || "";
  if (!token) return ctx.reply("Использование: /info <token>");

  const rec = await getTokenRecord(token);
  if (!rec) return ctx.reply("Токен не найден.");

  const status = rec.revoked ? "REVOKED" : "ACTIVE";
  await ctx.reply(
    `token: ${rec.token}` +
      `\nstatus: ${status}` +
      `\nlogin: ${rec.login || "-"}` +
      `\nissued_to: ${rec.issued_to_username || "-"} (${rec.issued_to_id || "-"})` +
      `\ncreated: ${new Date(rec.created_at).toISOString()}`
  );
});

bot.command("list", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const rows = await lastIssued(10);
  if (!rows.length) return ctx.reply("Список пуст.");
  await ctx.reply(
    "Последние токены:\n" +
      rows
        .map((r) => `- ${r.token} ${r.revoked ? "(revoked)" : ""}`)
        .join("\n")
  );
});

// /upload: строки после команды или .txt
bot.command("upload", async (ctx) => {
  if (!isAdmin(ctx)) return;

  const msg = ctx.message;

  // .txt файл
  if (msg?.document) {
    const fileId = msg.document.file_id;
    const file = await ctx.telegram.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
    const text = await (await fetch(fileUrl)).text();
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

    if (!lines.length) return ctx.reply("Файл пустой.");
    const added = await pushPoolLines(lines);

    await ctx.reply(`Загружено в пул: ${added}`);
    await logToChannel(
      `[UPLOAD]\nadmin=${ctx.from?.username || "-"}\ncount=${added}\ntime=${new Date().toISOString()}`
    );
    return;
  }

  // текст после /upload
  const text = String(msg?.text || "");
  const body = text.replace(/^\/upload(@\w+)?\s*/i, "");
  const lines = body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  if (!lines.length) {
    return ctx.reply("Пришли /upload и далее строки вида login:key (каждая с новой строки) или отправь .txt файлом.");
  }

  const added = await pushPoolLines(lines);
  await ctx.reply(`Загружено в пул: ${added}`);
  await logToChannel(
    `[UPLOAD]\nadmin=${ctx.from?.username || "-"}\ncount=${added}\ntime=${new Date().toISOString()}`
  );
});

bot.catch(async (err, ctx) => {
  console.error("Bot error", err);
  try {
    await ctx.reply("Ошибка. Попробуйте позже.");
  } catch (_) {}
});

// важно: если у тебя где-то был webhook — он должен быть удалён, но ты уже удалял.
await bot.launch();
console.log("Bot started");

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
