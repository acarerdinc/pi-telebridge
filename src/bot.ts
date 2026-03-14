import { Bot } from "grammy";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

let botInstance: Bot | null = null;
let currentToken: string | null = null;

export type IncomingMessageHandler = (chatId: number, text: string) => void;
export type IncomingVoiceHandler = (chatId: number, filePath: string, duration: number) => void;

let onIncomingMessage: IncomingMessageHandler | null = null;
let onIncomingVoice: IncomingVoiceHandler | null = null;
let allowedChatId: number | null = null;
let chatIdDiscoveryResolve: ((chatId: number) => void) | null = null;

// ── Voice message storage ───────────────────────────────────

const VOICE_DIR = path.join(os.homedir(), ".pi", "agent", "voice_messages");

function ensureVoiceDir(): void {
	try { fs.mkdirSync(VOICE_DIR, { recursive: true }); } catch {}
}

// ── Lock file for cross-process coordination ────────────────

const LOCK_DIR = path.join(os.homedir(), ".pi", "agent");
const LOCK_FILE = path.join(LOCK_DIR, "telebridge.lock");

/** Unique ID for this bot instance */
let instanceId: string | null = null;

function writeLock(): string {
	const id = crypto.randomUUID();
	fs.mkdirSync(LOCK_DIR, { recursive: true });
	fs.writeFileSync(LOCK_FILE, id, "utf-8");
	instanceId = id;
	return id;
}

function readLock(): string | null {
	try {
		return fs.readFileSync(LOCK_FILE, "utf-8").trim();
	} catch {
		return null;
	}
}

function clearLock(): void {
	try {
		const current = readLock();
		if (current === instanceId) {
			fs.unlinkSync(LOCK_FILE);
		}
	} catch {
		// Ignore
	}
	instanceId = null;
}

/** Check if another instance has taken over the lock */
export function isEvicted(): boolean {
	if (!instanceId) return true;
	const current = readLock();
	return current !== instanceId;
}

// ── Bot lifecycle ───────────────────────────────────────────

/**
 * Start the grammy Bot singleton with cross-process coordination.
 *
 * Always stops any existing bot first (even if same token) to prevent
 * duplicate pollers. Then:
 * 1. Writes a lock file to claim this instance
 * 2. Calls deleteWebhook to force-disconnect any existing poller
 * 3. Starts long polling
 * 4. Handles 409 Conflict by stopping gracefully (another instance took over)
 */
export async function startBot(token: string): Promise<Bot> {
	// Always stop existing bot — never reuse instances
	if (botInstance) {
		await stopBot();
	}

	// Claim the lock — any other instance checking will see it's been evicted
	writeLock();

	const bot = new Bot(token);

	bot.on("message:text", (ctx) => {
		const chatId = ctx.chat.id;
		const text = ctx.message.text;

		// Chat ID discovery mode
		if (chatIdDiscoveryResolve) {
			chatIdDiscoveryResolve(chatId);
			chatIdDiscoveryResolve = null;
			return;
		}

		// Security: only accept messages from allowed chat
		if (allowedChatId !== null && chatId !== allowedChatId) {
			return;
		}

		// Forward to handler
		if (onIncomingMessage) {
			onIncomingMessage(chatId, text);
		}
	});

	// Handle voice/audio/video_note messages
	bot.on(["message:voice", "message:audio", "message:video_note"], async (ctx) => {
		const chatId = ctx.chat.id;

		// Chat ID discovery mode
		if (chatIdDiscoveryResolve) {
			chatIdDiscoveryResolve(chatId);
			chatIdDiscoveryResolve = null;
			return;
		}

		if (allowedChatId !== null && chatId !== allowedChatId) return;

		try {
			const media = ctx.message.voice || ctx.message.audio || ctx.message.video_note;
			if (!media) return;

			const file = await ctx.api.getFile(media.file_id);
			const fileUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`;

			const resp = await fetch(fileUrl);
			const buffer = Buffer.from(await resp.arrayBuffer());

			ensureVoiceDir();
			const ext = path.extname(file.file_path || "") || ".ogg";
			const filename = `voice_${Date.now()}${ext}`;
			const filepath = path.join(VOICE_DIR, filename);
			fs.writeFileSync(filepath, buffer);

			// Write metadata for latest voice message
			const meta = {
				file: filepath,
				date: ctx.message.date,
				duration: media.duration || 0,
				chatId,
				timestamp: Date.now(),
			};
			fs.writeFileSync(path.join(VOICE_DIR, "latest.json"), JSON.stringify(meta, null, 2));

			// Notify via voice handler or fall back to text handler
			if (onIncomingVoice) {
				onIncomingVoice(chatId, filepath, media.duration || 0);
			} else if (onIncomingMessage) {
				onIncomingMessage(chatId, `[Voice message received: ${filepath}]`);
			}
		} catch (err: any) {
			console.error("[telebridge] Voice download error:", err.message);
		}
	});

	// Handle errors — detect 409 Conflict (another poller took over)
	bot.catch((err) => {
		const msg = err.message || "";
		const description = (err as any)?.error?.description || "";

		if (msg.includes("409") || description.includes("409") || description.includes("Conflict")) {
			console.error("[telebridge] 409 Conflict — another instance is polling. Stopping this bot.");
			stopBot();
			return;
		}

		console.error("[telebridge] Bot error:", msg);
	});

	// Force-disconnect any existing poller by calling deleteWebhook
	// This also terminates any pending getUpdates call from another process
	try {
		await bot.api.deleteWebhook({ drop_pending_updates: false });
	} catch {
		// Ignore — might fail if token is invalid, but start() will catch that
	}

	// Start long polling (non-blocking)
	// Catch the promise to handle polling errors (409 Conflict etc.)
	// without crashing the process via unhandled rejection
	bot.start({
		onStart: () => {
			// Bot is polling
		},
	}).catch((err: any) => {
		const msg = err?.message || "";
		if (msg.includes("409") || msg.includes("Conflict")) {
			// Another instance took over — stop silently
			botInstance = null;
			currentToken = null;
			clearLock();
		} else {
			console.error("[telebridge] Polling stopped:", msg);
		}
	});

	botInstance = bot;
	currentToken = token;

	return bot;
}

export async function stopBot(): Promise<void> {
	if (botInstance) {
		try {
			await botInstance.stop();
		} catch {
			// Ignore errors during shutdown
		}
		botInstance = null;
		currentToken = null;
	}
	clearLock();
}

export function getBot(): Bot | null {
	return botInstance;
}

export function setAllowedChatId(chatId: number | null): void {
	allowedChatId = chatId;
}

export function setIncomingMessageHandler(handler: IncomingMessageHandler | null): void {
	onIncomingMessage = handler;
}

export function setIncomingVoiceHandler(handler: IncomingVoiceHandler | null): void {
	onIncomingVoice = handler;
}

/**
 * Wait for the first message to arrive from any chat.
 * Used during setup to discover the user's chat ID.
 */
export function waitForChatId(): Promise<number> {
	return new Promise<number>((resolve) => {
		chatIdDiscoveryResolve = resolve;
	});
}

/**
 * Send a text message. Falls back silently on error.
 */
export async function sendText(chatId: number, text: string, parseMode?: "HTML"): Promise<void> {
	if (!botInstance) return;
	try {
		await botInstance.api.sendMessage(chatId, text, {
			parse_mode: parseMode,
		});
	} catch (err: any) {
		console.error("[telebridge] Send error:", err.message);
	}
}

/**
 * Send a photo. Falls back silently on error.
 */
export async function sendPhoto(chatId: number, url: string, caption?: string): Promise<void> {
	if (!botInstance) return;
	try {
		await botInstance.api.sendPhoto(chatId, url, {
			caption,
			parse_mode: "HTML",
		});
	} catch (err: any) {
		console.error("[telebridge] Photo send error:", err.message);
	}
}

/**
 * Send a typing indicator.
 */
export async function sendTyping(chatId: number): Promise<void> {
	if (!botInstance) return;
	try {
		await botInstance.api.sendChatAction(chatId, "typing");
	} catch {
		// Ignore
	}
}
