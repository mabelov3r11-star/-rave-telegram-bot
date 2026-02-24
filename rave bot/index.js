import { Telegraf, Markup } from "telegraf";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

/* ===== ENV ===== */
const BOT_TOKEN = process.env.BOT_TOKEN;
const SITE_BASE = (process.env.SITE_BASE || "").replace(/\/+$/, "");
const ADMIN_IDS = (process.env.ADMIN_IDS || "")
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);

const TG_CHANNEL_ID = process.env.TG_CHANNEL_ID || ""; // optional

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!BOT_TOKEN) throw new Error("Missing BOT_TOKEN");
if (!SITE_BASE) throw new Error("Missing SITE_BASE");
if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error("Missing Supabase vars");

/* ===== CLIENTS ===== */
const bot = new Telegraf(BOT_TOKEN);
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

/* ===== HELPERS ===== */
const isAdmin = (ctx) => ADMIN_IDS.includes(String(ctx.from?.id || ""));

const genToken = () => crypto.randomBytes(16).toString("hex").slice(0, 10);

async function logToChannel(text) {
  if (!TG_CHANNEL_ID) return;
  try {
    await bot.telegram.sendMessage(TG_CHANNEL_ID, text, {
      disable_web_page_preview: true,
    });
  } catch (e) {
    // молча, чтобы бот не падал если нет прав/канал недоступен
  }
}

function kbForToken(token) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🗑 Отключить ссылку (админ)", `revoke:${token}`)],
    [Markup.button.callback("ℹ️ Инфо", `info:${token}`)],
  ]);
}

/* ===== DB HELPERS ===== */
async function getNextPoolItem() {
  const { data, error } = await supabase
    .from("pool_items")
    .select("*")
    .eq("used", false)
    .order("id", { ascending: true })
    .limit(1);

  if (error) throw error;
  return data?.[0] || null;
}

async function markPoolUsed(id) {
  const { error } = await supabase.from("pool_items").update({ used: true }).eq("id", id);
  if (error) throw error;
}

async function insertToken(rec) {
  const { error } = await supabase.from("tokens").insert(rec);
  if (error) throw error;
}

async function getToken(token) {
  const { data, error } = await supabase.from("tokens").select("*").eq("token", token).limit(1);
  if (error) throw error;
  return data?.[0] || null;
}

async function revokeToken(token, byCtx) {
  const { error } = await supabase
    .from("tokens")
    .update({ revoked: true, revoked_at: new Date().toISOString() })
    .eq("token", token);

  if (error) throw error;

  await logToChannel(
    `[REVOKE]\nadmin=${byCtx.from?.username || "-"} id=${byCtx.from?.id || "-"}\ntoken=${token}\ntime=${new Date().toISOString()}`
  );
}

/* ===== CORE: ISSUE LINK ===== */
async function issueLink(ctx) {
  const item = await getNextPoolItem();

  if (!item) {
    await ctx.reply("Нет доступов. Подождите — админ пополнит список и попробуйте снова.");
    await logToChannel(
      `[EMPTY]\nuser=${ctx.from?.username || "-"} id=${ctx.from?.id || "-"}\ntime=${new Date().toISOString()}`
    );
    return;
  }

  // помечаем used сразу, чтобы не было дублей при параллельных запросах
  await markPoolUsed(item.id);

  // формат login:key (ключ может содержать ":" — тогда join обратно)
  const raw = String(item.value || "");
  const parts = raw.split(":");
  const login = parts.length >= 2 ? parts.shift() : `user_${Date.now()}`;
  const key = parts.length >= 1 ? parts.join(":") : raw;

  const token = genToken();
  const link = `${SITE_BASE}/${token}`;

  await insertToken({
    token,
    login,
    key,
    issued_to_id: String(ctx.from?.id || ""),
    issued_to_username: String(ctx.from?.username || ""),
    created_at: new Date().toISOString(),
    revoked: false,
  });

  await ctx.reply(`Ваша ссылка:\n\n${link}`, kbForToken(token));

  await logToChannel(
    `[ISSUED]\nuser=${ctx.from?.username || "-"} id=${ctx.from?.id || "-"}\nlogin=${login}\nlink=${link}\ntime=${new Date().toISOString()}`
  );
}

/* ===== COMMANDS (USER) ===== */
bot.start(issueLink);
bot.command("link", issueLink);

bot.command("help", async (ctx) => {
  const text =
    `Команды:\n` +
    `/start — получить ссылку\n` +
    `/link — получить ссылку\n` +
    `/help — помощь\n\n` +
    `Админу:\n` +
    `/upload — загрузить доступы (login:key построчно)\n` +
    `/stock — сколько доступов осталось\n` +
    `/list — последние токены\n` +
    `/info <token> — инфо по токену\n` +
    `/revoke <token> — отключить токен`;
  await ctx.reply(text);
});

/* ===== ADMIN: STOCK ===== */
bot.command("stock", async (ctx) => {
  if (!isAdmin(ctx)) return;

  const { count, error } = await supabase
    .from("pool_items")
    .select("*", { count: "exact", head: true })
    .eq("used", false);

  if (error) return ctx.reply("Ошибка чтения базы.");
  await ctx.reply(`В пуле осталось: ${count ?? 0}`);
});

/* ===== ADMIN: LIST LAST TOKENS ===== */
bot.command("list", async (ctx) => {
  if (!isAdmin(ctx)) return;

  const { data, error } = await supabase
    .from("tokens")
    .select("token, created_at, revoked, issued_to_username")
    .order("created_at", { ascending: false })
    .limit(10);

  if (error) return ctx.reply("Ошибка чтения базы.");

  if (!data?.length) return ctx.reply("Список пуст.");

  const lines = data.map((t) => {
    const st = t.revoked ? "REVOKED" : "ACTIVE";
    const u = t.issued_to_username || "-";
    return `- ${t.token} (${st}) user=${u}`;
  });

  await ctx.reply("Последние токены:\n" + lines.join("\n"));
});

/* ===== ADMIN: INFO TOKEN ===== */
bot.command("info", async (ctx) => {
  if (!isAdmin(ctx)) return;

  const token = String(ctx.message?.text || "").split(/\s+/)[1] || "";
  if (!token) return ctx.reply("Использование: /info <token>");

  const rec = await getToken(token);
  if (!rec) return ctx.reply("Токен не найден.");

  const status = rec.revoked ? "REVOKED" : "ACTIVE";
  await ctx.reply(
    `token: ${rec.token}\nstatus: ${status}\nlogin: ${rec.login || "-"}\nissued_to: ${rec.issued_to_username || "-"} (${rec.issued_to_id || "-"})\ncreated: ${rec.created_at}`
  );
});

/* ===== ADMIN: REVOKE TOKEN ===== */
bot.command("revoke", async (ctx) => {
  if (!isAdmin(ctx)) return;

  const token = String(ctx.message?.text || "").split(/\s+/)[1] || "";
  if (!token) return ctx.reply("Использование: /revoke <token>");

  const rec = await getToken(token);
  if (!rec) return ctx.reply("Токен не найден.");

  await revokeToken(token, ctx);
  await ctx.reply(`Ок. Токен отключён: ${token}`);
});

/* ===== ADMIN: UPLOAD TEXT ===== */
bot.command("upload", async (ctx) => {
  if (!isAdmin(ctx)) return;

  const body = String(ctx.message?.text || "").replace(/^\/upload(@\w+)?\s*/i, "");
  const lines = body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  if (!lines.length) {
    return ctx.reply(
      "Формат:\n/upload\nlogin:key\nlogin:key\n\nили отправь .txt файлом (в подписи напиши /upload)"
    );
  }

  const rows = lines.map((v) => ({ value: v, used: false }));
  const { error } = await supabase.from("pool_items").insert(rows);
  if (error) return ctx.reply("Ошибка записи в базу.");

  await ctx.reply(`Загружено: ${lines.length}`);
  await logToChannel(
    `[UPLOAD]\nadmin=${ctx.from?.username || "-"} id=${ctx.from?.id || "-"}\ncount=${lines.length}\ntime=${new Date().toISOString()}`
  );
});

/* ===== ADMIN: UPLOAD .TXT DOCUMENT (caption must contain /upload) ===== */
bot.on("document", async (ctx) => {
  if (!isAdmin(ctx)) return;

  const caption = String(ctx.message?.caption || "");
  if (!caption.includes("/upload")) return;

  // Скачивание файла через Telegram API проще сделать через ctx.telegram.getFileLink
  try {
    const fileId = ctx.message.document.file_id;
    const link = await ctx.telegram.getFileLink(fileId);
    const text = await (await fetch(link.href)).text();

    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return ctx.reply("Файл пустой.");

    const rows = lines.map((v) => ({ value: v, used: false }));
    const { error } = await supabase.from("pool_items").insert(rows);
    if (error) return ctx.reply("Ошибка записи в базу.");

    await ctx.reply(`Загружено из файла: ${lines.length}`);
    await logToChannel(
      `[UPLOAD_FILE]\nadmin=${ctx.from?.username || "-"} id=${ctx.from?.id || "-"}\ncount=${lines.length}\ntime=${new Date().toISOString()}`
    );
  } catch (e) {
    await ctx.reply("Не смог прочитать файл. Попробуй ещё раз.");
  }
});

/* ===== CALLBACKS (inline buttons) ===== */
bot.on("callback_query", async (ctx) => {
  try {
    const data = String(ctx.callbackQuery?.data || "");

    if (data.startsWith("revoke:")) {
      if (!isAdmin(ctx)) return ctx.answerCbQuery("Нет доступа.", { show_alert: true });

      const token = data.replace("revoke:", "").trim();
      const rec = await getToken(token);
      if (!rec) return ctx.answerCbQuery("Токен не найден.", { show_alert: true });

      await revokeToken(token, ctx);
      return ctx.answerCbQuery("Отключено.", { show_alert: true });
    }

    if (data.startsWith("info:")) {
      if (!isAdmin(ctx)) return ctx.answerCbQuery("Нет доступа.", { show_alert: true });

      const token = data.replace("info:", "").trim();
      const rec = await getToken(token);
      if (!rec) return ctx.answerCbQuery("Токен не найден.", { show_alert: true });

      const status = rec.revoked ? "REVOKED" : "ACTIVE";
      await ctx.reply(
        `token: ${rec.token}\nstatus: ${status}\nlogin: ${rec.login || "-"}\nissued_to: ${rec.issued_to_username || "-"} (${rec.issued_to_id || "-"})\ncreated: ${rec.created_at}`
      );
      return ctx.answerCbQuery();
    }

    return ctx.answerCbQuery();
  } catch (e) {
    return ctx.answerCbQuery("Ошибка.", { show_alert: true });
  }
});

/* ===== ERRORS ===== */
bot.catch(async (err, ctx) => {
  console.error("Bot error", err);
  try {
    await ctx.reply("Ошибка. Попробуйте позже.");
  } catch (_) {}
});

/* ===== SHOW COMMANDS IN TELEGRAM UI ===== */
async function setupCommands() {
  await bot.telegram.setMyCommands([
    { command: "start", description: "Получить ссылку" },
    { command: "link", description: "Получить ссылку" },
    { command: "help", description: "Помощь / список команд" },
    { command: "upload", description: "Админ: загрузить доступы (login:key)" },
    { command: "stock", description: "Админ: сколько осталось доступов" },
    { command: "list", description: "Админ: последние токены" },
    { command: "info", description: "Админ: инфо по токену (/info <token>)" },
    { command: "revoke", description: "Админ: отключить токен (/revoke <token>)" },
  ]);
}

(async () => {
  await setupCommands();
  await bot.launch();
  console.log("Bot started");
})();
