/**
 * Pacing Agent — pi extension
 *
 * After each settled agent run, a background model decides when the agent
 * should get its next opportunity to reach out. When the timer fires, a
 * "[Time Passed: ...]" user message is sent, which starts a new turn.
 *
 * Port of the Hermes plugin in ../hermes-agent.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface PacerConfig {
	/** Background model used for timing decisions. Falls back to the session's active model. */
	model?: { provider: string; id: string };
	debug: boolean;
	/** Seconds. */
	llmTimeout: number;
	maxTokens: number;
	/** IANA time zone for clock times shown to the pacer and in notifications. Defaults to the system zone. */
	timeZone?: string;
	/** Restore an active timer from the session file after a restart / resume / reload. */
	restoreOnStartup: boolean;
	/** Log file path. Empty string disables file logging. */
	logFile: string;
	pacer: {
		durationMin: number;
		durationMax: number;
		recentMessages: number;
	};
}

const DEFAULT_CONFIG: PacerConfig = {
	debug: false,
	llmTimeout: 180,
	maxTokens: 512,
	restoreOnStartup: true,
	logFile: join(getAgentDir(), "pacing-agent.log"),
	pacer: {
		durationMin: 300,
		durationMax: 28800,
		recentMessages: 8,
	},
};

/**
 * Config lookup, first existing file wins:
 *   1. $PACING_AGENT_CONFIG
 *   2. config.json next to this file (manual install in ~/.pi/agent/extensions/pacing-agent/)
 *   3. ~/.pi/agent/pacing-agent.json (git install: `pi update` runs `git clean`, which would delete 2)
 */
function configCandidates(): string[] {
	const here = dirname(fileURLToPath(import.meta.url));
	return [process.env.PACING_AGENT_CONFIG, join(here, "config.json"), join(getAgentDir(), "pacing-agent.json")].filter(
		(p): p is string => Boolean(p),
	);
}

function loadConfig(): { config: PacerConfig; path: string | null } {
	const path = configCandidates().find((p) => existsSync(p)) ?? null;
	if (!path) return { config: DEFAULT_CONFIG, path: null };
	const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<PacerConfig>;
	return {
		config: {
			...DEFAULT_CONFIG,
			...raw,
			pacer: { ...DEFAULT_CONFIG.pacer, ...(raw.pacer ?? {}) },
		},
		path,
	};
}

// ---------------------------------------------------------------------------
// Logging (never stdout: in RPC mode stdout is the protocol channel)
// ---------------------------------------------------------------------------

type Level = "DEBUG" | "INFO" | "WARNING" | "ERROR";

function makeLogger(config: PacerConfig) {
	return (level: Level, msg: string, err?: unknown) => {
		if (level === "DEBUG" && !config.debug) return;
		if (!config.logFile) return;
		let line = `${new Date().toISOString()} - ${level} - ${msg}`;
		if (err !== undefined) line += ` :: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`;
		try {
			appendFileSync(config.logFile, `${line}\n`);
		} catch {
			// Logging must never break the agent.
		}
	};
}

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

function partsIn(date: Date, timeZone?: string): Record<string, string> {
	const fmt = new Intl.DateTimeFormat("en-GB", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
		weekday: "short",
		timeZoneName: "longOffset",
	});
	const out: Record<string, string> = {};
	for (const p of fmt.formatToParts(date)) out[p.type] = p.value;
	return out;
}

/** e.g. "2026-11-21T14:38:05+00:00 (Sat, Europe/London)" */
function formatLocal(date: Date | null, timeZone?: string): string | null {
	if (!date) return null;
	const p = partsIn(date, timeZone);
	const offset = p.timeZoneName === "GMT" ? "+00:00" : p.timeZoneName.replace("GMT", "");
	const zone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
	return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${offset} (${p.weekday}, ${zone})`;
}

function clockTime(date: Date, timeZone?: string): string {
	const p = partsIn(date, timeZone);
	return `${p.hour}:${p.minute}:${p.second}`;
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const DECISION_TOOL = "pacing_decision";

const Prompts = {
	requestInstruction(pacer: PacerConfig["pacer"]): string {
		const minimum = pacer.durationMin;
		const maximum = pacer.durationMax;
		return `You are the conversational agent's background pacing controller. Choose when to give the agent its next opportunity to reach out to the user. You manage a timer; you do not write the message the agent will send.

PERSPECTIVE
Take the agent's perspective: given what it has recently expressed and what the user is doing, when would it naturally want to reach out again? Prioritize the agent's expressed disposition over a generic assessment of the conversation's atmosphere. Infer that disposition from its actual messages and known events; do not invent feelings or emotional developments. A calm, settled disposition supports a longer interval. Expressed concern, anticipation, or a wish to follow up can support a shorter interval. Ground concern in concrete context. Use the user's activities and availability to calibrate this inclination. Explicit user timing requests and boundaries take priority.

CLOCK TIME AND DAILY RHYTHMS
Consider physical time and the daily rhythms as well as conversational events. The approach of lunch, dinner, bedtime, or an expected period of tiredness or boringness can itself be a reason to offer the agent an opportunity to check in, even if the user has not mentioned a new event and no task is pending. Use the supplied current time, the user's local time when known, and any stated routine or recent context to choose a relevant upcoming moment rather than only measuring a generic interval since the last message. For example, an approaching meal can support a check-in around mealtime; a late hour or a long stretch of activity can make rest or sleep relevant. Treat hunger and sleepiness as possibilities, not established facts. Adapt to the user's actual schedule, including irregular hours, rather than imposing standard meal or bedtimes; do not assume an unknown timezone or routine. If the user is already sleeping or has asked for quiet, aim for their expected waking or available time. These time-based reasons remain subject to explicit boundaries and the unanswered-contact backoff below; they must not become repeated meal or sleep reminders after silence.

EVERYDAY CONTACT
Normally maintain a future opportunity to reconnect, even without a pending task. Use cancel sparingly. Meals, outings, work, rest, and ordinary goodbyes usually call for an appropriate delay, not cancellation. As flexible reference points, a meal may suggest 30-60 minutes, a short errand 1-2 hours, and a longer outing or gathering 4-6 hours. Adjust these estimates to the user's stated plans and the agent's expressed disposition. For sleep or focused work, aim for the expected waking or free time. Never schedule inside an explicit do-not-disturb period just to fit the timer limit; if it cannot be respected within that limit, cancel instead. A temporary request for space usually calls for a longer delay. An explicit request to stop proactive contact calls for cancel; do not restart while that request remains in effect. Brief acknowledgements do not by themselves end an existing reason to reconnect.

UNANSWERED CONTACT
Messages matching '[Time Passed: it is ... now.]' are automated timer notifications, even when their role is user. They are not user engagement. When recent history is mostly these notifications and unanswered assistant messages, progressively lengthen the interval and give the user more space. Neither an automated notification nor the agent's own message resets this pattern. Do not let repeated self-generated concern produce faster contact. Use the visible pattern and existing timer duration as evidence; do not invent counts or elapsed times missing from the supplied context. A genuine new user message allows a fresh assessment of the appropriate interval.

TIMER ACTIONS
- start: Schedule from the triggering message's time, replacing any existing timer. Use this when no timer is active, or when a new interval is needed.
- postpone: Add delay_seconds to the existing scheduled ending, not to the current time. Only use this when a timer is active and an extension of that deadline is intended. To schedule a fresh interval instead, use start.
- keep: Leave the timer unchanged; an inactive timer stays inactive. Prefer this when the existing deadline remains appropriate. Do not reset a timer merely because another message arrived.
- cancel: Remove the timer when proactive contact is unwanted or clearly inappropriate. Ordinary absence or lack of a concrete task is not enough.

OUTPUT
Respond only by calling the ${DECISION_TOOL} tool exactly once; do not write any other text. delay_seconds must be an integer between ${minimum} and ${maximum}, inclusive. For start it is the new interval; for postpone it is the added interval. For keep and cancel, set delay_seconds to ${minimum}; it is ignored. If the tool requests reason, briefly state the contextual basis for the action and timing. Do not add fields that the tool does not request.`;
	},

	requestContext(msgs: RecentMessage[], msgTime: string | null, timerStatus: unknown): string {
		return [
			`<time now="${msgTime}" />`,
			"<existing_timer>",
			JSON.stringify(timerStatus),
			"</existing_timer>",
			"<recent_messages>",
			JSON.stringify(msgs),
			"</recent_messages>",
		].join("\n\n");
	},

	returnMsg(timeZone?: string): string {
		return `[Time Passed: it is ${clockTime(new Date(), timeZone)} now.]`;
	},
};

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

function makePacerSchema(config: PacerConfig) {
	const schema: {
		type: "object";
		properties: Record<string, unknown>;
		required: string[];
		additionalProperties: false;
	} = {
		type: "object",
		properties: {
			action: { type: "string", enum: ["start", "postpone", "cancel", "keep"] },
			delay_seconds: {
				type: "integer",
				minimum: config.pacer.durationMin,
				maximum: config.pacer.durationMax,
			},
		},
		required: ["action", "delay_seconds"],
		additionalProperties: false,
	};
	if (config.debug) {
		schema.properties.reason = { type: "string" };
		schema.required.push("reason");
	}
	return schema;
}

type Action = "start" | "postpone" | "cancel" | "keep";
interface PacingDecision {
	action: Action;
	delay_seconds: number;
	reason?: string;
}

function validateDecision(raw: unknown, config: PacerConfig): PacingDecision {
	if (!raw || typeof raw !== "object") throw new Error(`Pacer returned a non-object: ${JSON.stringify(raw)}`);
	const r = raw as Record<string, unknown>;
	if (!["start", "postpone", "cancel", "keep"].includes(r.action as string)) {
		throw new Error(`Invalid pacer action: ${JSON.stringify(r.action)}`);
	}
	let delay = Number(r.delay_seconds);
	if (!Number.isFinite(delay)) throw new Error(`Invalid delay_seconds: ${JSON.stringify(r.delay_seconds)}`);
	// Schema enforcement is best-effort across providers, so clamp here as well.
	delay = Math.round(Math.min(Math.max(delay, config.pacer.durationMin), config.pacer.durationMax));
	return {
		action: r.action as Action,
		delay_seconds: delay,
		reason: typeof r.reason === "string" ? r.reason : undefined,
	};
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

interface RecentMessage {
	role: "user" | "assistant";
	content: string;
	time: string | null;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b): b is { type: "text"; text: string } => b?.type === "text" && typeof b.text === "string")
		.map((b) => b.text)
		.join("\n");
}

function recentMessages(ctx: ExtensionContext, config: PacerConfig): RecentMessage[] {
	const out: RecentMessage[] = [];
	for (const entry of ctx.sessionManager.buildContextEntries()) {
		if (entry.type !== "message") continue;
		const msg = entry.message as { role?: string; content?: unknown; timestamp?: number };
		if (msg.role !== "user" && msg.role !== "assistant") continue;
		const content = textOf(msg.content).trim();
		// Assistant turns that only call tools carry no conversational text.
		if (!content) continue;
		out.push({
			role: msg.role,
			content,
			time: formatLocal(typeof msg.timestamp === "number" ? new Date(msg.timestamp) : null, config.timeZone),
		});
	}
	return out.slice(-config.pacer.recentMessages);
}

// ---------------------------------------------------------------------------
// Pacer
// ---------------------------------------------------------------------------

interface TimerStatus {
	active: boolean;
	updated: Date | null;
	session: string | null;
	starting: Date | null;
	duration: number;
	ending: Date | null;
}

const emptyStatus = (): TimerStatus => ({
	active: false,
	updated: null,
	session: null,
	starting: null,
	duration: 0,
	ending: null,
});

interface Job {
	time: Date;
	msgs: RecentMessage[];
	session: string;
}

const STATE_ENTRY = "pacing-agent-timer";
// setTimeout overflows above 2^31-1 ms (~24.8 days); long waits are re-armed in chunks.
const MAX_TIMEOUT_MS = 2_147_000_000;

class AgentPacer {
	private readonly schema;
	private status: TimerStatus = emptyStatus();
	private timer: ReturnType<typeof setTimeout> | null = null;
	private ctx: ExtensionContext | null = null;

	// Keep only the latest pending context; an in-flight request is not interrupted.
	private pending: Job | null = null;
	private running = false;
	private abort: AbortController | null = null;

	constructor(
		private readonly pi: ExtensionAPI,
		private readonly config: PacerConfig,
		private readonly log: ReturnType<typeof makeLogger>,
	) {
		this.schema = makePacerSchema(config);
	}

	// --- session lifecycle -------------------------------------------------

	attach(ctx: ExtensionContext, reason: string) {
		this.ctx = ctx;
		if (!this.config.restoreOnStartup || reason === "new" || reason === "fork") return;

		let saved: Record<string, unknown> | undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === STATE_ENTRY) {
				saved = entry.data as Record<string, unknown>;
			}
		}
		if (!saved?.active || typeof saved.ending !== "string" || typeof saved.starting !== "string") return;

		const ending = new Date(saved.ending);
		this.status = {
			active: true,
			updated: typeof saved.updated === "string" ? new Date(saved.updated) : null,
			session: ctx.sessionManager.getSessionId(),
			starting: new Date(saved.starting),
			duration: Number(saved.duration) || 0,
			ending,
		};
		// An overdue timer fires shortly after startup instead of being dropped.
		this.arm(ending.getTime() < Date.now() ? new Date(Date.now() + 5_000) : ending);
		this.log("INFO", `Restored pacer timer ending at ${ending.toISOString()}`);
	}

	detach() {
		this.clearTimer();
		this.abort?.abort();
		this.pending = null;
		this.status = emptyStatus();
		this.ctx = null;
	}

	// --- hook --------------------------------------------------------------

	put(ctx: ExtensionContext) {
		this.ctx = ctx;
		this.log("INFO", "Pacer received completed turn");
		this.pending = {
			time: new Date(),
			msgs: recentMessages(ctx, this.config),
			session: ctx.sessionManager.getSessionId(),
		};
		if (!this.running) void this.drain();
	}

	private async drain() {
		this.running = true;
		try {
			while (this.pending) {
				const job = this.pending;
				this.pending = null;
				try {
					const decision = await this.decide(job);
					this.log("INFO", `Pacer decision: ${JSON.stringify(decision)}`);
					this.route(decision, job.time, job.session);
				} catch (err) {
					this.log("ERROR", "Pacer worker failed", err);
				}
			}
		} finally {
			this.running = false;
		}
	}

	// --- background model --------------------------------------------------

	private async decide(job: Job): Promise<PacingDecision> {
		const ctx = this.ctx;
		if (!ctx) throw new Error("No active session");

		const model = this.config.model
			? ctx.modelRegistry.find(this.config.model.provider, this.config.model.id)
			: ctx.model;
		if (!model) {
			throw new Error(
				this.config.model
					? `Pacer model ${this.config.model.provider}/${this.config.model.id} not found`
					: "No pacer model configured and no active session model",
			);
		}

		this.log("DEBUG", `Evaluating pacing for ${job.msgs.length} recent messages with ${model.provider}/${model.id}`);

		this.abort = new AbortController();
		const timeout = setTimeout(() => this.abort?.abort(), this.config.llmTimeout * 1000);
		try {
			const stream = ctx.modelRegistry.streamSimple(
				model,
				{
					systemPrompt: Prompts.requestInstruction(this.config.pacer),
					messages: [
						{
							role: "user",
							content: [
								{
									type: "text",
									text: Prompts.requestContext(job.msgs, formatLocal(job.time, this.config.timeZone), this.statusForPrompt()),
								},
							],
							timestamp: Date.now(),
						},
					],
					tools: [
						{
							name: DECISION_TOOL,
							description: "Record the pacing timer decision.",
							parameters: this.schema,
							constrainedSampling: { type: "json_schema", strict: "prefer" },
						},
					],
				},
				{
					temperature: 0,
					maxTokens: this.config.maxTokens,
					signal: this.abort.signal,
					sessionId: `pacing-agent-${job.session}`,
				},
			);
			const result = await stream.result();
			if (result.stopReason === "error" || result.stopReason === "aborted") {
				throw new Error(`Pacer model request failed: ${result.errorMessage ?? result.stopReason}`);
			}

			const call = result.content.find((c) => c.type === "toolCall" && c.name === DECISION_TOOL);
			if (call && call.type === "toolCall") return validateDecision(call.arguments, this.config);

			// Fallback for models that answer in text instead of calling the tool.
			const text = result.content
				.filter((c) => c.type === "text")
				.map((c) => (c as { text: string }).text)
				.join("");
			const match = text.match(/\{[\s\S]*\}/);
			if (!match) throw new Error("Pacer model returned no parsed pacing result");
			return validateDecision(JSON.parse(match[0]), this.config);
		} finally {
			clearTimeout(timeout);
			this.abort = null;
		}
	}

	statusForPrompt() {
		const tz = this.config.timeZone;
		return {
			active: this.status.active,
			updated: formatLocal(this.status.updated, tz),
			session: this.status.session,
			starting: formatLocal(this.status.starting, tz),
			duration: this.status.duration,
			ending: formatLocal(this.status.ending, tz),
		};
	}

	// --- timer -------------------------------------------------------------

	private route(pacing: PacingDecision, msgTime: Date, session: string) {
		this.status.updated = msgTime;

		if (pacing.action === "cancel") {
			this.log("INFO", "Pacer requested timer cancellation");
			this.cancel();
			this.persist();
			return;
		}
		if (pacing.action === "keep") {
			this.log("DEBUG", `Keeping pacer timer: active=${this.status.active}, ending=${this.status.ending?.toISOString()}`);
			this.persist();
			return;
		}

		let duration: number;
		let start: Date;
		if (pacing.action === "start") {
			duration = pacing.delay_seconds;
			start = msgTime;
		} else {
			if (!this.status.active || !this.status.starting) {
				this.log("DEBUG", "Skipping postpone: no valid active pacing timer");
				return;
			}
			// Extend the original deadline rather than restarting from the current message.
			duration = this.status.duration + pacing.delay_seconds;
			start = this.status.starting;
		}

		const ending = new Date(start.getTime() + duration * 1000);
		// Keep the existing timer if the proposed deadline is within a minute or already past.
		if (ending.getTime() - Date.now() <= 60_000) {
			this.log("DEBUG", `Skipping near-term or expired pacing deadline: ${ending.toISOString()}`);
			return;
		}

		this.start(duration, start, ending, session);
		this.persist();
	}

	private start(duration: number, start: Date, ending: Date, session: string) {
		this.cancel();
		this.status = { ...this.status, active: true, starting: start, duration, ending, session };
		// Anchored to the triggering message, so model latency adds no extra delay.
		this.arm(ending);
		this.log("INFO", `Pacer timer scheduled: duration=${duration}s, ending=${ending.toISOString()}`);
	}

	private arm(ending: Date) {
		this.clearTimer();
		const wait = Math.max(0, ending.getTime() - Date.now());
		this.timer = setTimeout(
			() => {
				this.timer = null;
				if (Date.now() < ending.getTime() - 1000) this.arm(ending);
				else this.fire();
			},
			Math.min(wait, MAX_TIMEOUT_MS),
		);
		// Do not keep the process alive just for the pacer.
		this.timer.unref?.();
	}

	private clearTimer() {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
	}

	private cancel() {
		this.clearTimer();
		this.status = { ...this.status, active: false, starting: null, duration: 0, ending: null, session: null };
	}

	private persist() {
		try {
			this.pi.appendEntry(STATE_ENTRY, {
				active: this.status.active,
				updated: this.status.updated?.toISOString() ?? null,
				starting: this.status.starting?.toISOString() ?? null,
				duration: this.status.duration,
				ending: this.status.ending?.toISOString() ?? null,
			});
		} catch (err) {
			this.log("WARNING", "Could not persist pacer state", err);
		}
	}

	private fire() {
		const ctx = this.ctx;
		const session = this.status.session;
		this.cancel();
		this.persist();

		if (!ctx || (session && ctx.sessionManager.getSessionId() !== session)) {
			this.log("WARNING", "Pacing notification skipped: session changed or closed");
			return;
		}
		// One attempt per notification; failures are logged without automatic retries.
		try {
			const text = Prompts.returnMsg(this.config.timeZone);
			if (ctx.isIdle()) this.pi.sendUserMessage(text);
			else this.pi.sendUserMessage(text, { deliverAs: "followUp" });
			this.log("INFO", "Pacing notification sent");
		} catch (err) {
			this.log("ERROR", "Pacing notification injection failed; not retrying", err);
		}
	}
}

// ---------------------------------------------------------------------------
// Register with pi
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	const { config, path: configPath } = loadConfig();
	const log = makeLogger(config);
	const pacer = new AgentPacer(pi, config, log);

	pi.on("session_start", async (event, ctx) => {
		// Print mode exits after one prompt; there is nobody to reach out to.
		if (ctx.mode === "print") return;
		pacer.attach(ctx, event.reason);
		log("INFO", `Pacing Agent attached (reason=${event.reason}, mode=${ctx.mode}, config=${configPath ?? "defaults"})`);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (ctx.mode === "print") return;
		pacer.put(ctx);
	});

	pi.on("session_shutdown", async () => {
		pacer.detach();
	});

	pi.registerCommand("pacing", {
		description: "Show the Pacing Agent timer status",
		handler: async (_args, ctx) => {
			const s = pacer.statusForPrompt();
			const text = s.active ? `Pacer timer active, ends ${s.ending}` : "Pacer timer inactive";
			if (ctx.hasUI) ctx.ui.notify(text, "info");
		},
	});
}
