import { Telegraf } from "telegraf";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";

/* ===================== ENV ===================== */
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error("Missing BOT_TOKEN");

const SITE_BASE = (process.env.SITE_BASE || "").replace(/\/+$/, "");
if (!SITE_BASE) throw new Error("Missing SITE_BASE (e.g. https://link.rave.onl)");

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

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

/* ===================== HELPERS ===================== */
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

/* ===================== DB ===================== */
// pool_items: id, value, created_at, used(boolean), used_at(timestamp)
// tokens: token(pk), login, pass, issued_to_id, issued_to_username, created_at, revoked(boolean), revoked_at(timestamp)
// token_opens: id, token, opened_at, ip, ua, platform, language, screen, timezone

async function popPoolItem() {
  // берём 1 неиспользованный item и помечаем used=true
  // делаем в 2 запроса (для простоты)
  const { data, error } = await sb
    .from("pool_items")
    .select("id,value")
    .eq("used", false)
    .order("id", { ascending: true })
    .limit(1);

  if (error) throw error;
  if (!data || data.length === 0) return null;

  const item = data[0];

  const { error: e2 } = await sb
    .from("pool_items")
    .update({ used: true, used_at: new Date().toISOString() })
    .eq("id", item.id);

  if (e2) throw e2;

  return item.value;
}

async function pushPoolLines(lines) {
  if (!lines.length) return 0;
  const rows = lines.map((v) => ({ value: v, used: false }));
  const { error } = await sb.from("pool_items").insert(rows);
  if (error) throw error;
  return lines.length;
}

async function saveTokenRecord(rec) {
  const { error } = await sb.from("tokens").insert(rec);
  if (error) throw error;
}

async function getToken(token) {
  const { data, error } = await sb
    .from("tokens")
    .select("*")
    .eq("token", token)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function revokeToken(token, by) {
  const { error } = await sb
    .from("tokens")
    .update({ revoked: true, revoked_at: new Date().toISOString() })
    .eq("token", token);
  if (error) throw error;

  await logToChannel(
    `[REVOKE]\nby=${by.username || "-"} id=${by.id || "-"}\ntoken=${token}\ntime=${new Date().toISOString()}`
  );
}

/* ===================== BOT ===================== */
const bot = new Telegraf(BOT_TOKEN);

// команды чтобы подсказки были
async function setCommands() {
  await bot.telegram.setMyCommands([
    { command: "start", description: "Получить ссылку (если есть доступы)" },
    { command: "link", description: "Получить ссылку (если есть доступы)" },

    { command: "stock", description: "Админ: сколько в пуле" },
    { command: "upload", description: "Админ: загрузить login:pass" },
    { command: "list", description: "Админ: последние токены" },
    { command: "info", description: "Админ: инфо по токену" },
    { command: "revoke", description: "Админ: отключить токен" },
    { command: "who", description: "Админ: кто владелец и открытия" }
  ]);
}

async function issueLinkForUser(ctx) {
  const item = await popPoolItem();

  if (!item) {
    await ctx.reply("Сейчас нет доступов. Подождите — админ пополнит список.");
    await logToChannel(
      `[EMPTY]\nuser=${ctx.from?.username || "-"} id=${ctx.from?.id || "-"}\ntime=${new Date().toISOString()}`
    );
    return;
  }

  // item: "login:pass" (pass может содержать :)
  const s = String(item);
  const parts = s.split(":");
  const login = parts.length >= 2 ? parts.shift() : `user_${Date.now()}`;
  const pass = parts.length >= 1 ? parts.join(":") : s;

  const token = genToken(10);
  const link = `${SITE_BASE}/?t=${encodeURIComponent(token)}`;

  const rec = {
    token,
    login,
    pass,
    issued_to_id: String(ctx.from?.id || ""),
    issued_to_username: String(ctx.from?.username || ""),
    created_at: new Date().toISOString(),
    revoked: false,
    revoked_at: null
  };

  await saveTokenRecord(rec);

  await ctx.reply(
    `Ваша персональная ссылка:\n\n${link}\n\n(Откройте её в браузере)`
  );

  await logToChannel(
    `[ISSUED]\nuser=${ctx.from?.username || "-"} id=${ctx.from?.id || "-"}\nlogin=${login}\ntoken=${token}\nlink=${link}\ntime=${new Date().toISOString()}`
  );
}

bot.start(async (ctx) => {
  // /start просто сообщает что нужно жать /link
  await ctx.reply("Чтобы получить ссылку — напишите /link");
});

bot.command("link", async (ctx) => {
  try {
    await issueLinkForUser(ctx);
  } catch (e) {
    console.error("link error", e);
    await ctx.reply("Ошибка. Попробуйте позже.");
  }
});

/* ===== ADMIN ===== */
bot.command("stock", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const { count, error } = await sb
    .from("pool_items")
    .select("*", { count: "exact", head: true })
    .eq("used", false);

  if (error) return ctx.reply("Ошибка базы.");
  await ctx.reply(`В пуле доступов: ${count ?? 0}`);
});

bot.command("upload", async (ctx) => {
  if (!isAdmin(ctx)) return;

  const msg = ctx.message;

  // если .txt документ
  if (msg?.document) {
    const fileId = msg.document.file_id;
    const file = await ctx.telegram.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
    const text = await (await fetch(fileUrl)).text();
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

    if (!lines.length) return ctx.reply("Файл пустой.");

    try {
      const n = await pushPoolLines(lines);
      await ctx.reply(`Загружено в пул: ${n}`);
      await logToChannel(
        `[UPLOAD_FILE]\nadmin=${ctx.from?.username || "-"} id=${ctx.from?.id || "-"}\ncount=${n}\ntime=${new Date().toISOString()}`
      );
    } catch (e) {
      console.error("upload file error", e);
      await ctx.reply("Ошибка загрузки в базу.");
    }
    return;
  }

  // иначе текст после /upload
  const text = String(msg?.text || "");
  const body = text.replace(/^\/upload(@\w+)?\s*/i, "");
  const lines = body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  if (!lines.length) {
    return ctx.reply("Пришли /upload и далее строки login:pass (каждая с новой строки) или отправь .txt файлом.");
  }

  try {
    const n = await pushPoolLines(lines);
    await ctx.reply(`Загружено в пул: ${n}`);
    await logToChannel(
      `[UPLOAD_TEXT]\nadmin=${ctx.from?.username || "-"} id=${ctx.from?.id || "-"}\ncount=${n}\ntime=${new Date().toISOString()}`
    );
  } catch (e) {
    console.error("upload text error", e);
    await ctx.reply("Ошибка загрузки в базу.");
  }
});

bot.command("list", async (ctx) => {
  if (!isAdmin(ctx)) return;

  const { data, error } = await sb
    .from("tokens")
    .select("token, issued_to_username, issued_to_id, created_at, revoked")
    .order("created_at", { ascending: false })
    .limit(10);

  if (error) return ctx.reply("Ошибка базы.");

  if (!data || !data.length) return ctx.reply("Список пуст.");

  const lines = data.map((t) => {
    const st = t.revoked ? "REVOKED" : "ACTIVE";
    return `- ${t.token} | ${st} | ${t.issued_to_username || "-"} (${t.issued_to_id || "-"})`;
  });

  await ctx.reply("Последние токены:\n" + lines.join("\n") + "\n\nУдалить: /revoke <token>\nПосмотреть: /who <token>");
});

bot.command("info", async (ctx) => {
  if (!isAdmin(ctx)) return;

  const token = String(ctx.message?.text || "").split(/\s+/)[1] || "";
  if (!token) return ctx.reply("Использование: /info <token>");

  try {
    const rec = await getToken(token);
    if (!rec) return ctx.reply("Токен не найден.");

    await ctx.reply(
      `token: ${rec.token}\n` +
      `status: ${rec.revoked ? "REVOKED" : "ACTIVE"}\n` +
      `login: ${rec.login || "-"}\n` +
      `owner: ${rec.issued_to_username || "-"} (${rec.issued_to_id || "-"})\n` +
      `created: ${new Date(rec.created_at).toISOString()}\n` +
      `\nУдалить: /revoke ${rec.token}`
    );
  } catch (e) {
    console.error("info error", e);
    await ctx.reply("Ошибка базы.");
  }
});

bot.command("revoke", async (ctx) => {
  if (!isAdmin(ctx)) return;

  const token = String(ctx.message?.text || "").split(/\s+/)[1] || "";
  if (!token) return ctx.reply("Использование: /revoke <token>");

  try {
    const rec = await getToken(token);
    if (!rec) return ctx.reply("Токен не найден.");

    await revokeToken(token, { username: ctx.from?.username, id: ctx.from?.id });
    await ctx.reply(`Ок. Ссылка отключена: ${token}`);
  } catch (e) {
    console.error("revoke error", e);
    await ctx.reply("Ошибка базы.");
  }
});

bot.command("who", async (ctx) => {
  if (!isAdmin(ctx)) return;

  const token = String(ctx.message?.text || "").split(/\s+/)[1] || "";
  if (!token) {
    return ctx.reply("Использование: /who <token>\n\nУдалить: /revoke <token>");
  }

  try {
    const { data: t, error: e1 } = await sb
      .from("tokens")
      .select("token, login, revoked, created_at, issued_to_id, issued_to_username")
      .eq("token", token)
      .maybeSingle();

    if (e1) throw e1;
    if (!t) return ctx.reply("Токен не найден.");

    const { count, error: e2 } = await sb
      .from("token_opens")
      .select("*", { count: "exact", head: true })
      .eq("token", token);

    if (e2) throw e2;

    const { data: opens, error: e3 } = await sb
      .from("token_opens")
      .select("opened_at, ip, platform, language, screen, timezone")
      .eq("token", token)
      .order("opened_at", { ascending: false })
      .limit(5);

    if (e3) throw e3;

    const lastLines = opens?.length
      ? opens.map((o, i) => {
          return (
            `${i + 1}) ${new Date(o.opened_at).toISOString()}\n` +
            `   ip: ${o.ip || "-"}\n` +
            `   platform: ${o.platform || "-"}\n` +
            `   lang: ${o.language || "-"}\n` +
            `   screen: ${o.screen || "-"}\n` +
            `   tz: ${o.timezone || "-"}`
          );
        }).join("\n\n")
      : "Открытий ещё не было.";

    await ctx.reply(
      `🔎 WHO\n` +
      `token: ${t.token}\n` +
      `status: ${t.revoked ? "REVOKED" : "ACTIVE"}\n` +
      `owner: ${t.issued_to_username || "-"} (${t.issued_to_id || "-"})\n` +
      `login: ${t.login || "-"}\n` +
      `created: ${new Date(t.created_at).toISOString()}\n` +
      `opens: ${count ?? 0}\n\n` +
      `Последние открытия:\n${lastLines}\n\n` +
      `Удалить: /revoke ${t.token}`
    );
  } catch (e) {
    console.error("who error", e);
    await ctx.reply("Ошибка базы.");
  }
});

bot.catch(async (err, ctx) => {
  console.error("Bot error", err);
  try { await ctx.reply("Ошибка. Попробуйте позже."); } catch (_) {}
});

/* запуск */
(async () => {
  await setCommands();
  await bot.launch();
  console.log("Bot started");
})();
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
