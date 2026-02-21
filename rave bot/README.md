# Telegram bot for one-time links

## Environment variables
- BOT_TOKEN (from BotFather)
- ADMIN_IDS (comma-separated Telegram numeric IDs, e.g. "123,456")
- SITE_BASE (e.g. "https://link.rave.plus")
- TG_CHANNEL_ID (optional: channel/chat id to log admin events)
- UPSTASH_REDIS_REST_URL
- UPSTASH_REDIS_REST_TOKEN

## Pool format
Upload lines in format:
login:key
(one per line)

## Commands
User:
- /start or /link

Admin:
- /upload (send text with lines or a .txt file)
- /stock
- /revoke <token>
- /info <token>
- /list
