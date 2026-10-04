/**
 * pi-output-cap — a single response that spends 100k+ output tokens and ends
 * truncated has achieved nothing. Make that outcome unreachable, and
 * recoverable when a provider still forces it.
 *
 * The failure this exists for: the agent streams one enormous response, the
 * provider cuts it at the model's max-output limit, and pi prints "Response was
 * truncated before completion." over an empty result. Nothing written, nothing
 * verified, nothing answered — and the only warning is the one line the user
 * sees after the bill.
 *
 * The limit is per model turn, never per chat. A long conversation with many
 * turns is not a budget problem; one runaway response is. Nothing here sums
 * output across a run, steers at a run total, or aborts on one.
 *
 * Three layers, each fail-open:
 *
 *  1. Hard cap per response (`before_provider_request`). Every output-limit
 *     field in the outgoing provider payload — `max_tokens`,
 *     `max_completion_tokens`, `max_output_tokens`, `maxTokens`,
 *     `maxOutputTokens`, including the nested `generationConfig` and
 *     `inferenceConfig` shapes — is clamped to the budget, and only ever
 *     lowered. One response can no longer run away, whatever the model's own
 *     limit says. Compaction and branch-summary calls do not pass through this
 *     hook (they call the stream function directly), so context summaries keep
 *     their full budget.
 *  2. Tell the agent it has a budget (`before_agent_start`). One deterministic
 *     guideline bullet, so the cached prompt prefix survives turn to turn.
 *  3. Wrap-up instead of silence (`agent_before_settle`). A run whose last
 *     response was cut off at the cap gets exactly one extra turn under a small
 *     cap with a strict instruction: at most 120 words — what is done, what is
 *     not, the exact next step. The user gets an answer instead of a cut-off
 *     blob.
 *
 * Deliberately not done: no mid-stream token counting (the payload cap already
 * bounds the response), no re-generation of truncated text, no edits to the
 * model's declared maxTokens in models.json, no run totals that accumulate
 * across turns, no interference with the user's own abort.
 *
 * Fail-open contract: on any surprise the payload, the run, and the transcript
 * stay exactly as pi built them. A guard that breaks a session is worse than a
 * guard that misses one runaway reply.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface CapConfig {
	/** Master switch. When false nothing is capped and nothing is injected. */
	enabled: boolean;
	/** Show the live token counter in the footer status line. Off by default: the
	 *  footer already carries context usage, and a third counter is noise. */
	status: boolean;
	/** Output tokens allowed for one model turn. 0 disables the per-response cap. */
	perResponse: number;
	/** Output tokens allowed for the forced wrap-up turn. */
	wrapUpCap: number;
}

export const DEFAULTS: CapConfig = {
	enabled: true,
	status: false,
	perResponse: 16_384,
	wrapUpCap: 2_048,
};

/** Providers reject absurdly small caps; keep the floor high enough to be safe. */
const MIN_CAP = 512;
/** A response at this fraction of the cap counts as "hit the ceiling". */
const CAP_HIT_FRACTION = 0.9;
/** Wrap-up reply length the agent is asked for, in words. */
const WRAP_UP_WORDS = 120;

function envNum(name: string): number | undefined {
	const raw = process.env[name]?.trim();
	if (!raw) return undefined;
	const value = Number(raw);
	return Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

export function configPath(): string {
	const override = process.env.PI_OUTPUT_CAP_CONFIG?.trim();
	if (override) return override;
	return join(homedir(), ".pi", "agent", "pi-output-cap.json");
}

/** File settings first, then environment overrides on top. */
export function loadConfig(): CapConfig {
	let stored: Partial<CapConfig> = {};
	try {
		const raw = readFileSync(configPath(), "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (parsed && typeof parsed === "object") stored = parsed as Partial<CapConfig>;
	} catch {
		// No file yet, unreadable, or corrupt: defaults are the contract.
	}

	const config: CapConfig = { ...DEFAULTS };
	if (typeof stored.enabled === "boolean") config.enabled = stored.enabled;
	if (typeof stored.status === "boolean") config.status = stored.status;
	for (const key of ["perResponse", "wrapUpCap"] as const) {
		const value = stored[key];
		if (typeof value === "number" && Number.isFinite(value) && value >= 0) config[key] = Math.floor(value);
	}

	if (process.env.PI_OUTPUT_CAP?.trim().toLowerCase() === "off") config.enabled = false;
	const statusEnv = process.env.PI_OUTPUT_CAP_STATUS?.trim().toLowerCase();
	if (statusEnv) config.status = statusEnv === "1" || statusEnv === "on" || statusEnv === "true";
	const perResponse = envNum("PI_OUTPUT_CAP_PER_RESPONSE");
	if (perResponse !== undefined) config.perResponse = perResponse;
	const wrapUpCap = envNum("PI_OUTPUT_CAP_WRAP_UP_CAP");
	if (wrapUpCap !== undefined) config.wrapUpCap = wrapUpCap;

	return config;
}

export function saveConfig(config: CapConfig): void {
	try {
		const path = configPath();
		mkdirSync(dirname(path), { recursive: true });
		const tmp = `${path}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, "utf8");
		renameSync(tmp, path);
	} catch {
		// Persistence is a convenience; a read-only home must not break the run.
	}
}

// ---------------------------------------------------------------------------
// Payload clamping
// ---------------------------------------------------------------------------

/** Output-limit fields, wherever a provider puts them. */
const LIMIT_KEYS = new Set([
	"max_tokens",
	"max_completion_tokens",
	"max_output_tokens",
	"maxTokens",
	"maxOutputTokens",
]);

/**
 * Where to insert a cap when the payload carries no limit field at all. Only
 * APIs whose field name is unambiguous get this: on OpenAI-compatible payloads
 * `max_tokens` vs `max_completion_tokens` depends on the model, and guessing
 * wrong is a 400 from the provider, so those payloads are left uncapped rather
 * than risking the request.
 */
const FALLBACK_PATHS: Record<string, [string, string]> = {
	"google-generative-ai": ["generationConfig", "maxOutputTokens"],
	"google-vertex": ["generationConfig", "maxOutputTokens"],
	"bedrock-converse-stream": ["inferenceConfig", "maxTokens"],
	"mistral-conversations": ["", "maxTokens"],
};

const MAX_DEPTH = 5;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collect(node: Record<string, unknown>, cap: number, path: string, fields: string[], depth: number): void {
	if (depth > MAX_DEPTH) return;
	for (const key of Object.keys(node)) {
		const value = node[key];
		if (LIMIT_KEYS.has(key) && typeof value === "number" && Number.isFinite(value)) {
			// 0 and negatives are "no limit" sentinels on some providers.
			if (value <= 0 || value > cap) {
				node[key] = cap;
				fields.push(`${path}${key}`);
			}
		} else if (isPlainObject(value)) {
			// Arrays (messages, tools) hold no limit fields and are large: skip them.
			collect(value, cap, `${path}${key}.`, fields, depth + 1);
		}
	}
}

export interface ClampResult {
	payload: unknown;
	/** Dotted paths of the fields that were lowered. */
	fields: string[];
}

/**
 * Clamp every output-limit field in a provider payload to `cap`, lowering only.
 * Returns the payload pi should send (a clone, so other handlers never observe
 * a half-modified object) and the list of fields that moved.
 */
export function clampOutputLimit(payload: unknown, cap: number, api?: string): ClampResult {
	if (!cap || cap <= 0 || !isPlainObject(payload)) return { payload, fields: [] };

	let root: Record<string, unknown>;
	try {
		root = structuredClone(payload) as Record<string, unknown>;
	} catch {
		// Payload with something non-cloneable in it: clamp in place rather than
		// skip the guard entirely.
		root = payload;
	}

	const fields: string[] = [];
	collect(root, cap, "", fields, 0);

	if (fields.length === 0 && api) {
		const fallback = FALLBACK_PATHS[api];
		if (fallback) {
			const [parentKey, field] = fallback;
			if (!parentKey) {
				root[field] = cap;
				fields.push(field);
			} else {
				const parent = root[parentKey];
				if (isPlainObject(parent) && !(field in parent)) {
					parent[field] = cap;
					fields.push(`${parentKey}.${field}`);
				}
			}
		}
	}

	return { payload: root, fields };
}

/** Reasoning eats the same output budget, so a thinking model needs headroom. */
function thinkingAllowance(thinkingLevel?: string): number {
	switch (thinkingLevel) {
		case "xhigh":
			return 2;
		case "high":
			return 1;
		case "medium":
			return 0.5;
		default:
			return 0;
	}
}

export interface CapInputs {
	perResponse: number;
	wrapUpCap: number;
	thinkingLevel?: string;
	/** Model-declared limit; 0 or missing means unknown. */
	modelMaxTokens?: number;
	/** True for the single forced wrap-up turn. */
	wrapUp?: boolean;
}

/** The token ceiling actually sent for one request. 0 means "do not cap". */
export function effectiveCap(inputs: CapInputs): number {
	const base = Math.max(MIN_CAP, Math.floor(inputs.perResponse || 0));
	const wanted = inputs.wrapUp ? Math.max(MIN_CAP, Math.floor(inputs.wrapUpCap || 0)) : base;
	const withThinking = Math.max(wanted, Math.round(wanted * (1 + thinkingAllowance(inputs.thinkingLevel))));
	const modelLimit = inputs.modelMaxTokens ?? 0;
	const capped = modelLimit > 0 ? Math.min(withThinking, modelLimit) : withThinking;
	return Math.max(MIN_CAP, Math.floor(capped));
}

// ---------------------------------------------------------------------------
// Prompt text
// ---------------------------------------------------------------------------

function guideline(config: CapConfig): string {
	return (
		`Output budget: every response is hard-capped at ${config.perResponse} output tokens and is cut off ` +
		"mid-sentence at the cap, so anything longer must go to a file. Each turn starts fresh — there is no " +
		"budget for the conversation as a whole. Write code, logs, and long prose with write/edit and report " +
		"the path instead of pasting it. Keep chat replies short and state the result before the details."
	);
}

function wrapUpInstruction(used: number, cap: number): string {
	return (
		`[pi-output-cap] Your last response was cut off at the output limit after ` +
		`${used.toLocaleString("en-US")} output tokens. The next response is capped at ` +
		`${cap.toLocaleString("en-US")} tokens.\n` +
		`Write a wrap-up of at most ${WRAP_UP_WORDS} words and nothing else:\n` +
		"1. what is already done,\n" +
		"2. what is not done,\n" +
		"3. the exact next step.\n" +
		"No new tool calls, no file dumps, no code blocks."
	);
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function fmtTokens(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
	return String(Math.round(value));
}

interface UiLike {
	ui?: {
		notify?: (text: string, type?: "info" | "warning" | "error") => void;
		setStatus?: (key: string, text: string | undefined) => void;
	};
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

interface RunState {
	outputTokens: number;
	/** Output tokens of the most recent response, for the per-turn counter. */
	lastOutput: number;
	responses: number;
	truncated: number;
	capped: number;
	/** One-shot cap for the next request (the forced wrap-up turn). */
	nextWrapUpCap: number;
	/** True once the wrap-up continuation has been requested for this run. */
	wrapUpRequested: boolean;
}

interface Stats {
	sessionOutput: number;
	truncated: number;
	capped: number;
	wrapUps: number;
}

export default function (pi: ExtensionAPI) {
	const config = loadConfig();
	const run: RunState = {
		outputTokens: 0,
		lastOutput: 0,
		responses: 0,
		truncated: 0,
		capped: 0,
		nextWrapUpCap: 0,
		wrapUpRequested: false,
	};
	const stats: Stats = {
		sessionOutput: 0,
		truncated: 0,
		capped: 0,
		wrapUps: 0,
	};
	/** Cap of the last response, for the "hit the ceiling" heuristic. */
	let lastCap = 0;

	const notify = (ctx: unknown, text: string, level: "info" | "warning" | "error" = "warning") => {
		try {
			(ctx as UiLike).ui?.notify?.(text, level);
		} catch {
			// Notifications are best-effort and must never break a handler.
		}
	};

	const setStatus = (ctx: unknown) => {
		try {
			const ui = (ctx as UiLike).ui;
			// The footer counter is opt-in; when it is off, make sure nothing of
			// ours is left in the footer from an earlier setting.
			if (!config.enabled || !config.status) {
				ui?.setStatus?.("pi-output-cap", undefined);
				return;
			}
			const cap = lastCap > 0 ? `/${fmtTokens(lastCap)}` : "";
			const hot = lastCap > 0 && run.lastOutput >= lastCap * CAP_HIT_FRACTION ? "!" : "";
			ui?.setStatus?.("pi-output-cap", `turn ${fmtTokens(run.lastOutput)}${cap}${hot}`);
		} catch {
			// Status is decoration.
		}
	};

	const modelOf = (ctx: unknown): { api?: string; maxTokens?: number; thinkingLevel?: string } | undefined => {
		try {
			const context = ctx as {
				model?: { api?: string; maxTokens?: number };
				thinkingLevel?: string;
			};
			if (!context.model) return undefined;
			return { api: context.model.api, maxTokens: context.model.maxTokens, thinkingLevel: context.thinkingLevel };
		} catch {
			return undefined;
		}
	};

	// 1. Hard cap per response ------------------------------------------------
	pi.on("before_provider_request", (event, ctx) => {
		if (!config.enabled) return undefined;
		try {
			const wrapUp = run.nextWrapUpCap > 0;
			const cap = effectiveCap({
				perResponse: config.perResponse,
				wrapUpCap: wrapUp ? run.nextWrapUpCap : config.wrapUpCap,
				thinkingLevel: modelOf(ctx)?.thinkingLevel,
				modelMaxTokens: modelOf(ctx)?.maxTokens,
				wrapUp,
			});
			const result = clampOutputLimit(event.payload, cap, modelOf(ctx)?.api);
			run.nextWrapUpCap = 0;
			// The ceiling in force for this request, for the cap-hit heuristic.
			lastCap = cap;
			if (result.fields.length === 0) return undefined;
			return result.payload;
		} catch {
			return undefined;
		}
	});

	// 2. Tell the agent it has a budget ---------------------------------------
	pi.on("before_agent_start", (event) => {
		if (!config.enabled || config.perResponse <= 0) return undefined;
		try {
			const bullet = guideline(config);
			const options = event.systemPromptOptions;
			if (!Array.isArray(options.promptGuidelines)) return undefined;
			if (!options.promptGuidelines.includes(bullet)) options.promptGuidelines.push(bullet);
		} catch {
			// A prompt tweak is never worth breaking a run over.
		}
		return undefined;
	});

	// 3. Budget for the whole run ---------------------------------------------
	pi.on("agent_start", () => {
		run.outputTokens = 0;
		run.lastOutput = 0;
		run.responses = 0;
		run.truncated = 0;
		run.capped = 0;
		run.nextWrapUpCap = 0;
		run.wrapUpRequested = false;
	});

	pi.on("message_end", (event, ctx) => {
		if (!config.enabled) return;
		try {
			const message = event.message as {
				role?: string;
				usage?: { output?: number };
				stopReason?: string;
			};
			if (message?.role !== "assistant") return;

			const output = message.usage?.output ?? 0;
			run.outputTokens += output;
			run.lastOutput = output;
			run.responses += 1;
			stats.sessionOutput += output;
			if (message.stopReason === "length") {
				run.truncated += 1;
				stats.truncated += 1;
			}
			if (lastCap > 0 && output >= lastCap * CAP_HIT_FRACTION) {
				run.capped += 1;
				stats.capped += 1;
			}
			setStatus(ctx);
		} catch {
			// Accounting must never break message handling.
		}
	});

	// 4. Wrap-up instead of silence -------------------------------------------
	pi.on("agent_before_settle", (event, ctx) => {
		if (!config.enabled) return undefined;
		try {
			const settle = event as unknown as {
				outcome?: string;
				continue?: boolean;
				entries?: unknown[];
				context?: { canContinue?: boolean };
			};
			// Errors are pi's to report, not ours to answer for.
			if (settle.outcome === "error") return undefined;
			if (run.wrapUpRequested) return undefined;
			if (settle.context?.canContinue === false) return undefined;
			if (run.truncated === 0) return undefined;

			run.wrapUpRequested = true;
			stats.wrapUps += 1;
			run.nextWrapUpCap = config.wrapUpCap;
			const cap = effectiveCap({
				perResponse: config.perResponse,
				wrapUpCap: config.wrapUpCap,
				thinkingLevel: modelOf(ctx)?.thinkingLevel,
				modelMaxTokens: modelOf(ctx)?.maxTokens,
				wrapUp: true,
			});
			notify(ctx, "pi-output-cap: response was truncated — requesting a short wrap-up", "info");
			setStatus(ctx);

			return {
				continue: true,
				entries: [
					{
						type: "custom_message",
						customType: "pi-output-cap",
						content: wrapUpInstruction(run.lastOutput, cap),
						display: true,
					},
				],
			};
		} catch {
			return undefined;
		}
	});

	pi.on("agent_settled", (ctx) => {
		try {
			run.nextWrapUpCap = 0;
			setStatus(ctx);
		} catch {
			// Decoration only.
		}
	});

	pi.on("session_shutdown", (ctx) => {
		try {
			(ctx as UiLike).ui?.setStatus?.("pi-output-cap", undefined);
		} catch {
			// Decoration only.
		}
	});

	// -------------------------------------------------------------------------
	// /outcap
	// -------------------------------------------------------------------------
	const report = (ctx: unknown): string => {
		const lines = [
			`pi-output-cap ${config.enabled ? "on" : "off"} (footer counter ${config.status ? "on" : "off"})`,
			`  per turn:    ${config.perResponse > 0 ? `${config.perResponse} tokens` : "uncapped"}`,
			`  wrap-up cap: ${config.wrapUpCap} tokens`,
			`  last turn:   ${fmtTokens(run.lastOutput)} output tokens` +
				`${run.truncated > 0 ? `, ${run.truncated} truncated this run` : ""}` +
				`${run.capped > 0 ? `, ${run.capped} at the cap` : ""}`,
			`  this run:    ${fmtTokens(run.outputTokens)} output tokens in ${run.responses} response(s)`,
			`  this session: ${fmtTokens(stats.sessionOutput)} output tokens, ` +
				`${stats.truncated} truncated, ${stats.capped} at the cap, ${stats.wrapUps} wrap-up(s)`,
		];
		return lines.join("\n");
	};

	pi.registerCommand("outcap", {
		description:
			"Per-turn output cap: /outcap shows it — /outcap off|on toggles — /outcap status on|off toggles the footer counter — /outcap per-response <n|off> — /outcap wrapup [text]",
		getArgumentCompletions: (prefix: string) => {
			const subs = ["on", "off", "status", "per-response", "wrapup"];
			const matches = subs.filter((s) => s.startsWith(prefix));
			return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const [rawSub, ...rest] = args.trim().split(/\s+/);
			const sub = (rawSub ?? "").toLowerCase();
			const values = rest.join(" ").trim();

			const parseBudget = (text: string): number | undefined => {
				if (!text) return undefined;
				if (/^(off|none|0)$/i.test(text)) return 0;
				const value = Number(text);
				return Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
			};

			if (!sub) {
				notify(ctx, report(ctx), "info");
				return;
			}

			if (sub === "on" || sub === "off") {
				config.enabled = sub === "on";
				saveConfig(config);
				notify(ctx, `pi-output-cap ${config.enabled ? "enabled" : "disabled"}`, "info");
				setStatus(ctx);
				return;
			}

			if (sub === "status" || sub === "footer") {
				const wanted = (values || rawSub || "on").toLowerCase();
				if (wanted === "on" || wanted === "off") {
					config.status = wanted === "on";
					saveConfig(config);
					setStatus(ctx);
					notify(ctx, `pi-output-cap: footer counter ${wanted}`, "info");
				} else {
					notify(ctx, "usage: /outcap status on|off", "warning");
				}
				return;
			}

			if (sub === "per-response" || sub === "set") {
				const budget = parseBudget(values);
				if (budget === undefined) {
					notify(ctx, "usage: /outcap per-response <tokens|off>", "warning");
					return;
				}
				config.perResponse = budget;
				saveConfig(config);
				notify(
					ctx,
					budget > 0
						? `pi-output-cap: per-response cap ${budget} tokens`
						: "pi-output-cap: per-response cap disabled (provider limits apply)",
					"info",
				);
				return;
			}

			if (sub === "run") {
				notify(ctx, "run budgets are gone: the cap applies per turn — /outcap per-response <tokens|off>", "warning");
				return;
			}

			if (sub === "wrapup") {
				if (!ctx.isIdle()) {
					notify(ctx, "pi-output-cap: agent is still running — queued as a follow-up", "warning");
					await pi.sendUserMessage(values || "Wrap up now: what is done, what is not, the next step.", {
						deliverAs: "followUp",
					});
					return;
				}
				await pi.sendUserMessage(
					values || "Wrap up now: at most 120 words on what is done, what is not, and the exact next step.",
				);
				notify(ctx, "pi-output-cap: wrap-up requested", "info");
				return;
			}

			notify(ctx, report(ctx), "info");
		},
	});
}
