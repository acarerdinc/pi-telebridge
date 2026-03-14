# pi-telebridge

A [pi](https://github.com/badlogic/pi-mono) extension that creates a two-way relay between your active pi coding agent session and a Telegram bot. Enable it per-session with `/telegram`, then interact with your session from your phone.

- **Agent → Phone**: Every final assistant response is forwarded to your Telegram chat
- **Phone → Agent**: Your Telegram replies are injected as user messages into the session
- **Voice Messages**: Voice, audio, and video note messages are downloaded and forwarded to the agent for transcription

Both the pi TUI and Telegram inputs coexist — you can use either at any time.

## Install

```bash
pi install npm:pi-telebridge
```

## Setup

1. Create a bot with [@BotFather](https://t.me/BotFather) on Telegram and copy the token
2. In pi, run `/telegram setup`
3. Enter your bot token when prompted
4. Send any message to your bot on Telegram — this links your chat ID
5. Done! Config is saved to `~/.pi/agent/telebridge.json`

### Environment Variables (optional)

You can skip the interactive setup by setting these beforehand:

| Variable | Purpose |
|----------|---------|
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | Your Telegram chat ID |

## Usage

| Command | Description |
|---------|-------------|
| `/telegram` | Toggle relay on/off for this session |
| `/telegram setup` | Guided setup: enter bot token, discover chat ID |
| `/telegram status` | Show connection state, chat ID, relay status |

When the relay is enabled:
- A **📡 TG** indicator appears in the footer
- Every assistant response is forwarded to your Telegram chat
- Messages you send to the bot are injected into the pi session
- Voice/audio messages are downloaded to `~/.pi/agent/voice_messages/` and forwarded as `[Voice message received: <path>]`
- If the agent is idle, your message starts a new turn; if busy, it's queued as a follow-up

## Security

- Only messages from your configured `chat_id` are accepted
- All other Telegram messages are silently ignored
- Bot token and chat ID are stored locally in `~/.pi/agent/telebridge.json`

## License

MIT
