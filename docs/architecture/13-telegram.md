# 13 — Chatting with the CTO via Telegram

The CEO messages the CTO through a Telegram bot just like on the web. The CTO's replies, follow-up questions and completion reports also go there,
even when no one has the web UI open (works together with `12-durable-work.md`). Code: `src/channel/telegram.ts`.

## Decisions

- **Long polling (`getUpdates`), no webhook.** No domain, HTTPS or open port is needed on the VPS;
  it also works on a personal machine. The offset (next `update_id`) is stored in `settings` and written
  **before** each message is processed: a restart mid-way drops that message rather than processing it twice.
- **No new library**: the Bot API is called with `fetch`.
- **One bot, one person.** The bot is linked to exactly one private chat (the CEO). Linking uses a random pairing code
  shown on the **Settings** (Cài đặt) page: send `/start <code>` (the link `t.me/<bot>?start=<code>` does this when
  Start is pressed). All other chats are rejected. The bot token is stored in the `settings` table (key `telegram`) and
  is not returned to the UI. "Change user" (Đổi người dùng) removes the link and creates a new code.
- **Telegram is just another entry point into the CTO's session.** CEO messages go through `harness.send(cto, text, "steer", "ceo")`
  exactly like typing on the web, so everything else (inbox persisted in the DB, continuing after restart, non-blocking questions)
  applies automatically. Web and Telegram share one conversation.
- **Output is sent per turn, not per source.** Bootstrap wires the CTO session's `onTurnStart`/`onTurnEnd` to the channel.
  On turn start it records the current message count and sends the "typing" status. On turn end it sends the final
  answer (the last assistant message with text) and any `question` with an option keyboard. So the CEO also receives
  turns that did **not** start from Telegram: messages typed on the web, employee reports that wake the CTO, scheduled
  work.
  - A failed turn reports the error; a stopped turn (`interrupted`) sends nothing.
- An answer to a `question` is a normal message. Pressing a button on the Telegram keyboard sends the option's exact text.
- Commands: the shared slash commands (`17-slash-commands.md`), run against the CTO session. `/help` lists them and the pairing welcome includes the list. Commands run without blocking polling, so `/stop` still arrives during a long `/compact`.
- Photos and files (documents) are downloaded via `getFile` and attached the same way as on the web (`14-uploads.md`); the caption is the message content.
- Long messages are split into several messages of ≤ 4000 characters (Telegram's limit is 4096), preferably at line breaks.
  Sent as plain text, without Telegram Markdown: the model's Markdown often makes Telegram reject the message.

## Not done

- **Zalo**: Zalo's Bot API is new, `getUpdates` is recommended only for testing and there are reports of it
  not receiving messages; production needs an HTTPS webhook. Dropped for now; to be done once a domain + HTTPS exist on the VPS.
- Chatting with employees via Telegram: the CEO talks to the CTO; to see employees, use the web.
- Multiple users / group chats.

## API

| Route | Purpose |
|---|---|
| `GET /api/telegram` | Status: configured, bot name, who it is linked to, pairing code, last error |
| `PUT /api/telegram {token}` | Validate the token with `getMe`, save, create a pairing code, start polling |
| `POST /api/telegram/unlink` | Remove the link, create a new code |
| `DELETE /api/telegram` | Disconnect completely, delete the token |

A 409 error from Telegram means the bot is in use elsewhere (a webhook or a second server running with the same
token): only one process may poll a bot.
