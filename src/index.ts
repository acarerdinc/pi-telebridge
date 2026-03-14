import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { loadConfig, saveConfig, resolveToken, resolveChatId } from "./config.js";
import { startBot, stopBot, getBot, setAllowedChatId, setIncomingMessageHandler, waitForChatId, sendText, sendTyping } from "./bot.js";
import { markdownToTelegramHtml, splitForTelegram } from "./formatter.js";

const TELEGRAM_BRIEF_INSTRUCTION = [
	"The user is reading this on a phone via Telegram.",
	"Be very concise: short paragraphs, no big code blocks unless asked.",
	"Summarize actions taken rather than showing full output.",
	"Use plain language, skip formatting-heavy content.",
].join(" ");

export default function (pi: ExtensionAPI) {
	let relayEnabled = false;
	let chatId: number | null = null;
	let botToken: string | null = null;
	let lastMessageFromTelegram = false;

	// ── Setup Flow ──────────────────────────────────────────────

	async function runSetup(ctx: ExtensionCommandContext): Promise<boolean> {
		// 1. Resolve bot token
		botToken = resolveToken();
		if (!botToken) {
			const input = await ctx.ui.input("Enter your Telegram bot token (from @BotFather):");
			if (!input || !input.trim()) {
				ctx.ui.notify("Setup cancelled — no token provided", "warning");
				return false;
			}
			botToken = input.trim();
		}

		// 2. Start bot
		ctx.ui.notify("Starting Telegram bot...", "info");
		try {
			await startBot(botToken);
		} catch (err: any) {
			ctx.ui.notify(`Failed to start bot: ${err.message}`, "error");
			botToken = null;
			return false;
		}

		// 3. Resolve chat ID
		chatId = resolveChatId();
		if (!chatId) {
			ctx.ui.notify("Send any message to your bot on Telegram to link your chat...", "info");
			chatId = await waitForChatId();
			ctx.ui.notify(`Chat ID discovered: ${chatId}`, "info");
		}

		// 4. Persist config
		saveConfig({ botToken, chatId });
		setAllowedChatId(chatId);

		// 5. Wire up incoming message handler
		wireIncomingHandler(ctx);

		ctx.ui.notify(`✅ Telegram connected! Chat ID: ${chatId}`, "info");
		return true;
	}

	function isSetUp(): boolean {
		return getBot() !== null && chatId !== null;
	}

	// ── Incoming Message Handler ────────────────────────────────

	function wireIncomingHandler(ctx: ExtensionContext) {
		setIncomingMessageHandler((_incomingChatId, text) => {
			if (!relayEnabled) {
				sendText(_incomingChatId, "⚠️ Relay is disabled. Enable with /telegram in pi.");
				return;
			}

			// Notify in TUI
			if (ctx.hasUI) {
				ctx.ui.notify(`📱 Telegram: ${text.length > 60 ? text.slice(0, 60) + "…" : text}`, "info");
			}

			// Mark as Telegram-originated and send to agent
			lastMessageFromTelegram = true;
			if (ctx.isIdle()) {
				pi.sendUserMessage(text);
			} else {
				pi.sendUserMessage(text, { deliverAs: "followUp" });
			}
		});
	}

	// ── Relay Toggle ────────────────────────────────────────────

	async function enableRelay(ctx: ExtensionContext) {
		relayEnabled = true;
		pi.appendEntry("telebridge-state", { enabled: true });

		if (ctx.hasUI) {
			const theme = ctx.ui.theme;
			ctx.ui.setStatus("telebridge", theme.fg("success", "📡 TG"));
			ctx.ui.notify("🟢 Telegram relay enabled", "info");
		}

		if (chatId) {
			await sendText(chatId, "📡 Connected to pi session");
		}
	}

	async function disableRelay(ctx: ExtensionContext) {
		relayEnabled = false;
		pi.appendEntry("telebridge-state", { enabled: false });

		if (ctx.hasUI) {
			ctx.ui.setStatus("telebridge", undefined);
			ctx.ui.notify("🔴 Telegram relay disabled", "info");
		}

		if (chatId) {
			await sendText(chatId, "📴 Disconnected from pi session");
		}
	}

	// ── Commands ────────────────────────────────────────────────

	pi.registerCommand("telegram", {
		description: "Toggle Telegram relay (setup | status | on/off)",
		handler: async (args, ctx) => {
			const subcommand = args?.trim().toLowerCase();

			if (subcommand === "setup") {
				await runSetup(ctx);
				return;
			}

			if (subcommand === "status") {
				const botRunning = getBot() !== null;
				const lines = [
					`Bot: ${botRunning ? "✅ running" : "❌ stopped"}`,
					`Chat ID: ${chatId ?? "not set"}`,
					`Relay: ${relayEnabled ? "🟢 enabled" : "🔴 disabled"}`,
				];
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			// Toggle: set up first if needed
			if (!isSetUp()) {
				const ok = await runSetup(ctx);
				if (!ok) return;
			}

			// Toggle relay
			if (relayEnabled) {
				await disableRelay(ctx);
			} else {
				await enableRelay(ctx);
			}
		},
	});

	// ── Telegram → Brief Response ───────────────────────────────

	pi.on("input", async (event) => {
		// If input came from the TUI (not from our extension), clear the flag
		if (event.source !== "extension") {
			lastMessageFromTelegram = false;
		}
	});

	pi.on("before_agent_start", async (event) => {
		if (!relayEnabled || !lastMessageFromTelegram) return;
		return {
			systemPrompt: event.systemPrompt + "\n\n" + TELEGRAM_BRIEF_INSTRUCTION,
		};
	});

	// ── Session Events ──────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		// Always stop any lingering bot and reset state
		await stopBot();
		relayEnabled = false;
		lastMessageFromTelegram = false;
		if (ctx.hasUI) {
			ctx.ui.setStatus("telebridge", undefined);
		}
	});

	pi.on("session_before_switch", async (_event, ctx) => {
		// Stop bot before switching sessions to release the polling connection
		if (relayEnabled && chatId) {
			await sendText(chatId, "📴 Session switching...");
		}
		await stopBot();
		relayEnabled = false;
		lastMessageFromTelegram = false;
		if (ctx.hasUI) {
			ctx.ui.setStatus("telebridge", undefined);
		}
	});

	pi.on("session_switch", async (_event, ctx) => {
		// Belt-and-suspenders: ensure bot is stopped after switch completes
		await stopBot();
		relayEnabled = false;
		lastMessageFromTelegram = false;
		if (ctx.hasUI) {
			ctx.ui.setStatus("telebridge", undefined);
		}
	});

	pi.on("session_shutdown", async () => {
		if (relayEnabled && chatId) {
			await sendText(chatId, "📴 pi session ended");
		}
		await stopBot();
	});

	// ── Agent → Telegram (outgoing) ─────────────────────────────

	pi.on("agent_start", async () => {
		if (relayEnabled && chatId && lastMessageFromTelegram) {
			await sendTyping(chatId);
		}
	});

	pi.on("agent_end", async (event) => {
		if (!relayEnabled || !chatId || !lastMessageFromTelegram) return;
		lastMessageFromTelegram = false;

		// Extract the last assistant message text
		const messages = event.messages ?? [];
		let assistantText = "";

		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg.role === "assistant") {
				// Extract text content blocks
				if (typeof msg.content === "string") {
					assistantText = msg.content;
				} else if (Array.isArray(msg.content)) {
					assistantText = msg.content
						.filter((block: any) => block.type === "text")
						.map((block: any) => block.text)
						.join("\n");
				}
				break;
			}
		}

		if (!assistantText.trim()) return;

		// Convert markdown to Telegram HTML and split if needed
		const html = markdownToTelegramHtml(assistantText);
		const chunks = splitForTelegram(html);

		for (const chunk of chunks) {
			try {
				await sendText(chatId!, chunk, "HTML");
			} catch {
				// If HTML parsing fails, try plain text
				try {
					await sendText(chatId!, assistantText.slice(0, 4096));
				} catch {
					// Give up silently
				}
			}
		}
	});
}
