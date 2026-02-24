import { Telegraf } from "telegraf";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

/* ===== ENV ===== */
const BOT_TOKEN = process.env.BOT_TOKEN;
const SITE_BASE = process.env.SITE_BASE;
const ADMIN_IDS = (process.env.ADMIN_IDS || "").split(",").map(x => x.trim());

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!BOT_TOKEN) throw new Error("Missing BOT_TOKEN");
if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error("Missing Supabase vars");

/* ===== CLIENTS ===== */
const bot = new Telegraf(BOT_TOKEN);
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

/* ===== HELPERS ===== */
const isAdmin = (ctx) => ADMIN_IDS.includes(String(ctx.from.id));

const genToken = () =>
  crypto.randomBytes(16).toString("hex").slice(0, 10);

/* ===== ISSUE LINK ===== */
async function issueLink(ctx) {
  const { data: item } = await supabase
    .from("pool_items")
    .select("*")
    .eq("used", false)
    .limit(1)
    .single();

  if (!item) {
    return ctx.reply("Нет доступов. Попробуй позже.");
  }

  await supabase
    .from("pool_items")
    .update({ used: true })
    .eq("id", item.id);

  const [login, key] = item.value.split(":");
  const token = genToken();

  await supabase.from("tokens").insert({
    token,
    login,
    key,
    issued_to_id: ctx.from.id,
    issued_to_username: ctx.from.username
  });

  await ctx.reply(`Ваша ссылка:\n\n${SITE_BASE}/${token}`);
}

/* ===== COMMANDS ===== */
bot.start(issueLink);
bot.command("link", issueLink);

bot.command("stock", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const { count } = await supabase
    .from("pool_items")
    .select("*", { count: "exact", head: true })
    .eq("used", false);

  ctx.reply(`В пуле: ${count}`);
});

bot.command("upload", async (ctx) => {
  if (!isAdmin(ctx)) return;

  const text = ctx.message.text.replace("/upload", "").trim();
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);

  if (!lines.length) {
    return ctx.reply("Формат:\n/upload\nlogin:key");
  }

  await supabase.from("pool_items").insert(
    lines.map(v => ({ value: v }))
  );

  ctx.reply(`Загружено: ${lines.length}`);
});

/* ===== ERRORS ===== */
bot.catch(err => console.error("Bot error", err));

bot.launch();
console.log("Bot started");
