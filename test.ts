/**
 * Smoke test: drives index.ts against a fake ExtensionAPI. No network, no real
 * pi, no provider. `bun test.ts`.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const tmp = mkdtempSync(join(tmpdir(), "pi-output-cap-test-"));
process.env.PI_OUTPUT_CAP_CONFIG = join(tmp, "config.json");
process.env.PI_OUTPUT_CAP = undefined;

const { default: activate, clampOutputLimit, effectiveCap, loadConfig, saveConfig, DEFAULTS } = await import(
	"./index.ts"
);

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type Handler = (event: never, ctx: never) => unknown;

interface Fake {
	pi: ExtensionAPI;
	handlers: Record<string, Handler[]>;
	commands: Record<string, { handler: (args: string, ctx: never) => Promise<void> }>;
	sent: { content: string; deliverAs?: string }[];
	notifications: string[];
	statuses: (string | undefined)[];
	aborts: number;
}

function fakePi(): Fake {
	const handlers: Record<string, Handler[]> = {};
	const fake: Fake = {
		handlers,
		commands: {},
		sent: [],
		notifications: [],
		statuses: [],
		aborts: 0,
		pi: {
			on: (event: string, handler: Handler) => {
				(handlers[event] ??= []).push(handler);
				return () => {};
			},
			registerCommand: (name: string, cmd: never) => {
				fake.commands[name] = cmd as never;
			},
			sendUserMessage: async (content: string, options?: { deliverAs?: string }) => {
				fake.sent.push({ content, deliverAs: options?.deliverAs });
			},
		} as unknown as ExtensionAPI,
	};
	return fake;
}

const ctx = (fake: Fake) =>
	({
		ui: {
			notify: (text: string) => fake.notifications.push(text),
			setStatus: (_key: string, text: string | undefined) => fake.statuses.push(text),
		},
		mode: "tui",
		model: { provider: "opencode", id: "test-model", api: "openai-completions", maxTokens: 131_072 },
		thinkingLevel: "off",
		abort: () => {
			fake.aborts += 1;
		},
		isIdle: () => true,
	}) as never;

const assistant = (output: number, stopReason = "stop") => ({
	type: "message_end",
	message: { role: "assistant", usage: { output }, stopReason },
});

const settle = (overrides: Record<string, unknown> = {}) =>
	({
		type: "agent_before_settle",
		outcome: "completed",
		continue: false,
		entries: [] as unknown[],
		context: { canContinue: true },
		...overrides,
	}) as never;

const emit = async (fake: Fake, event: string, payload: unknown): Promise<unknown[]> => {
	const results: unknown[] = [];
	for (const handler of fake.handlers[event] ?? []) results.push(await handler(payload as never, ctx(fake)));
	return results;
};

/** Full run: agent_start, N responses, settle. */
async function run(fake: Fake, outputs: { output: number; stopReason?: string }[]) {
	await emit(fake, "agent_start", { type: "agent_start" });
	for (const o of outputs) await emit(fake, "message_end", assistant(o.output, o.stopReason ?? "stop"));
	return (await emit(fake, "agent_before_settle", settle())) as
		({ continue?: boolean; entries?: { content?: string }[] } | undefined)[];
}

let failures = 0;
function assert(cond: boolean, label: string) {
	console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
	if (!cond) failures++;
}

// ---------------------------------------------------------------------------
// Pure logic
// ---------------------------------------------------------------------------

{
	const anthropic = clampOutputLimit(
		{ model: "claude", max_tokens: 131_072, messages: [{ role: "user", content: "hi" }] },
		16_384,
		"anthropic-messages",
	);
	assert((anthropic.payload as { max_tokens: number }).max_tokens === 16_384, "anthropic max_tokens clamped");
	assert((anthropic.payload as { max_tokens: number }).max_tokens < 131_072, "clamp lowered the limit");
	assert(anthropic.fields.join() === "max_tokens", "clamp reports the field it moved");

	const reasoning = clampOutputLimit({ model: "o3", max_completion_tokens: 128_000 }, 16_384, "openai-completions");
	assert((reasoning.payload as { max_completion_tokens: number }).max_completion_tokens === 16_384, "max_completion_tokens clamped");

	const google = clampOutputLimit(
		{ model: "g", generationConfig: { temperature: 0.7, maxOutputTokens: 65_536 }, contents: [] },
		16_384,
		"google-generative-ai",
	);
	assert((google.payload as { generationConfig: { maxOutputTokens: number } }).generationConfig.maxOutputTokens === 16_384, "nested generationConfig clamped");

	const bedrock = clampOutputLimit({ model: "b", inferenceConfig: { maxTokens: 32_000 } }, 16_384, "bedrock-converse-stream");
	assert((bedrock.payload as { inferenceConfig: { maxTokens: number } }).inferenceConfig.maxTokens === 16_384, "nested inferenceConfig clamped");

	const inserted = clampOutputLimit({ model: "g", generationConfig: { temperature: 0.2 } }, 16_384, "google-generative-ai");
	assert((inserted.payload as { generationConfig: { maxOutputTokens: number } }).generationConfig.maxOutputTokens === 16_384, "limit inserted when the field was missing");

	const smaller = clampOutputLimit({ max_tokens: 4_096 }, 16_384, "anthropic-messages");
	assert((smaller.payload as { max_tokens: number }).max_tokens === 4_096 && smaller.fields.length === 0, "a smaller limit is never raised");

	const unlimited = clampOutputLimit({ max_tokens: 0 }, 16_384, "anthropic-messages");
	assert((unlimited.payload as { max_tokens: number }).max_tokens === 16_384, "'no limit' sentinel becomes the cap");

	const original = { model: "x", max_tokens: 131_072 };
	clampOutputLimit(original, 16_384, "anthropic-messages");
	assert(original.max_tokens === 131_072, "the incoming payload is cloned, not mutated");

	const deep = clampOutputLimit({ model: "m", a: { b: { c: { d: { e: { f: { max_tokens: 99_999 } } } } } } }, 16_384, "anthropic-messages");
	assert(JSON.stringify(deep.payload).includes("99999"), "fields deeper than the walk limit are left alone");

	const disabled = clampOutputLimit({ max_tokens: 131_072 }, 0, "anthropic-messages");
	assert(disabled.fields.length === 0 && (disabled.payload as { max_tokens: number }).max_tokens === 131_072, "cap 0 disables clamping");

	assert(effectiveCap({ perResponse: 16_384, wrapUpCap: 2_048, thinkingLevel: "off", modelMaxTokens: 0 }) === 16_384, "cap without thinking is the budget");
	assert(effectiveCap({ perResponse: 16_384, wrapUpCap: 2_048, thinkingLevel: "high", modelMaxTokens: 0 }) === 32_768, "thinking high doubles the ceiling");
	assert(effectiveCap({ perResponse: 16_384, wrapUpCap: 2_048, thinkingLevel: "xhigh", modelMaxTokens: 0 }) === 49_152, "thinking xhigh triples the ceiling");
	assert(effectiveCap({ perResponse: 16_384, wrapUpCap: 2_048, thinkingLevel: "high", modelMaxTokens: 8_192 }) === 8_192, "the model's own limit still wins");
	assert(effectiveCap({ perResponse: 16_384, wrapUpCap: 2_048, thinkingLevel: "off", wrapUp: true }) === 2_048, "wrap-up turn uses the wrap-up cap");
	assert(effectiveCap({ perResponse: 16_384, wrapUpCap: 2_048, thinkingLevel: "high", wrapUp: true }) === 4_096, "wrap-up keeps room for reasoning");
}

// ---------------------------------------------------------------------------
// Config store
// ---------------------------------------------------------------------------

{
	saveConfig({ ...DEFAULTS, perResponse: 24_000, runSoft: 90_000 });
	const reloaded = loadConfig();
	assert(reloaded.perResponse === 24_000 && reloaded.runSoft === 90_000, "config survives a save/load round trip");

	process.env.PI_OUTPUT_CAP_STATUS = "1";
	assert(loadConfig().status === true, "PI_OUTPUT_CAP_STATUS=1 turns the footer counter on");
	delete process.env.PI_OUTPUT_CAP_STATUS;

	process.env.PI_OUTPUT_CAP = "off";
	assert(loadConfig().enabled === false, "PI_OUTPUT_CAP=off disables the guard");
	process.env.PI_OUTPUT_CAP_PER_RESPONSE = "8192";
	assert(loadConfig().perResponse === 8_192, "env overrides the stored per-response cap");
	delete process.env.PI_OUTPUT_CAP;
	delete process.env.PI_OUTPUT_CAP_PER_RESPONSE;

	rmSync(process.env.PI_OUTPUT_CAP_CONFIG, { force: true });
	saveConfig({ ...DEFAULTS });
	assert(JSON.parse(readFileSync(process.env.PI_OUTPUT_CAP_CONFIG as string, "utf8")).perResponse === DEFAULTS.perResponse, "defaults are written back");
	rmSync(process.env.PI_OUTPUT_CAP_CONFIG, { force: true });
}

// ---------------------------------------------------------------------------
// Per-response cap through the event seam
// ---------------------------------------------------------------------------

{
	const fake = fakePi();
	await activate(fake.pi);
	await emit(fake, "agent_start", { type: "agent_start" });

	const [payload] = (await emit(fake, "before_provider_request", {
		type: "before_provider_request",
		payload: { model: "longcat", max_tokens: 131_072, messages: [] },
	})) as [{ max_tokens: number }];
	assert(payload?.max_tokens === DEFAULTS.perResponse, "before_provider_request clamps the outgoing payload");

	const thinkingCtx = { ...(ctx(fake) as object), thinkingLevel: "high" } as never;
	const thinkingPayload = (await fake.handlers.before_provider_request[0](
		{ type: "before_provider_request", payload: { model: "longcat", max_tokens: 131_072 } } as never,
		thinkingCtx,
	)) as { max_tokens: number } | undefined;
	assert(thinkingPayload?.max_tokens === 32_768, "a thinking model keeps reasoning headroom");

	// A truncated response buys a wrap-up turn, which gets the small one-shot cap.
	await emit(fake, "message_end", assistant(20_000, "length"));
	await emit(fake, "agent_before_settle", settle({ outcome: "completed" }));
	const [wrapPayload] = (await emit(fake, "before_provider_request", {
		type: "before_provider_request",
		payload: { model: "longcat", max_tokens: 131_072, messages: [] },
	})) as [{ max_tokens: number }];
	assert(wrapPayload?.max_tokens === DEFAULTS.wrapUpCap, "the wrap-up turn is capped at the wrap-up cap");

	const [normalPayload] = (await emit(fake, "before_provider_request", {
		type: "before_provider_request",
		payload: { model: "longcat", max_tokens: 131_072, messages: [] },
	})) as [{ max_tokens: number }];
	assert(normalPayload?.max_tokens === DEFAULTS.perResponse, "the one-shot wrap-up cap is spent");
}

// ---------------------------------------------------------------------------
// Guideline
// ---------------------------------------------------------------------------

{
	const fake = fakePi();
	await activate(fake.pi);
	const event = { systemPromptOptions: { promptGuidelines: ["existing"] } };
	await emit(fake, "before_agent_start", event);
	assert(event.systemPromptOptions.promptGuidelines.length === 2, "the budget guideline is added once");
	await emit(fake, "before_agent_start", event);
	assert(event.systemPromptOptions.promptGuidelines.length === 2, "the guideline is not duplicated on later runs");
	assert(event.systemPromptOptions.promptGuidelines[1].includes(String(DEFAULTS.perResponse)), "the guideline states the cap");
}

// ---------------------------------------------------------------------------
// Run budget: steer, abort, wrap-up
// ---------------------------------------------------------------------------

{
	const fake = fakePi();
	await activate(fake.pi);

	const [result] = (await run(fake, [{ output: 40_000 }, { output: 25_000 }])) as (
		{ continue?: boolean; entries?: { content?: string }[] } | undefined
	)[];
	assert(fake.sent.length === 1 && fake.sent[0].deliverAs === "steer", "crossing the soft budget steers the agent");
	assert(fake.sent[0].content.includes("65,000"), "the steer message quotes the tokens spent");
	assert(!result?.continue, "a clean, under-budget run settles untouched");
	assert(fake.aborts === 0, "an under-budget run is never aborted");
}

{
	const fake = fakePi();
	await activate(fake.pi);
	await run(fake, [{ output: 50_000 }]);
	assert(fake.sent.length === 0, "no steering before the soft budget");
}

{
	const fake = fakePi();
	await activate(fake.pi);
	const [result] = (await run(fake, [{ output: 60_000 }, { output: 45_000 }])) as (
		{ continue?: boolean; entries?: { content?: string }[] } | undefined
	)[];
	await new Promise((resolve) => setTimeout(resolve, 5));
	assert(fake.aborts === 1, "crossing the hard budget aborts the run");
	assert(fake.notifications.some((n) => n.includes("budget spent")), "the abort is reported to the user");
	assert(result?.continue === true, "an aborted run still asks for a wrap-up");
	assert(result?.entries?.[0]?.content?.includes("120 words"), "the wrap-up asks for a bounded reply");
}

{
	const fake = fakePi();
	await activate(fake.pi);
	const [result] = (await run(fake, [{ output: 20_000, stopReason: "length" }])) as (
		{ continue?: boolean; entries?: { content?: string }[] } | undefined
	)[];
	assert(fake.sent.length === 0, "a truncated response does not also trigger a steer");
	assert(result?.continue === true && result.entries.length === 1, "a truncated response turns into a wrap-up turn");
	assert(result?.entries?.[0]?.content?.includes("cut off"), "the wrap-up names the truncation");
	assert(fake.notifications.some((n) => n.includes("truncated")), "truncation is reported");
}

{
	const fake = fakePi();
	await activate(fake.pi);
	await emit(fake, "agent_start", { type: "agent_start" });
	await emit(fake, "message_end", assistant(1_000, "length"));
	// A second settle for the same run must not chain wrap-ups forever.
	const [first] = (await emit(fake, "agent_before_settle", settle())) as (
		{ continue?: boolean; entries?: unknown[] } | undefined
	)[];
	await emit(fake, "message_end", assistant(20_000, "length"));
	const [second] = (await emit(fake, "agent_before_settle", settle())) as (
		{ continue?: boolean; entries?: unknown[] } | undefined
	)[];
	assert(first?.continue === true, "first truncation requests one wrap-up");
	assert(second === undefined, "the wrap-up is not requested twice for one run");
}

{
	const fake = fakePi();
	await activate(fake.pi);
	const [result] = (await emit(fake, "agent_before_settle", settle({ outcome: "error" }))) as [unknown];
	assert(result === undefined, "provider errors are pi's to report, not ours to answer");
}

{
	const fake = fakePi();
	await activate(fake.pi);
	const [result] = (await emit(fake, "agent_before_settle", settle({ context: { canContinue: false } }))) as [unknown];
	assert(result === undefined, "no wrap-up when pi cannot continue");
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

{
	const fake = fakePi();
	await activate(fake.pi);
	await emit(fake, "agent_start", { type: "agent_start" });
	await emit(fake, "message_end", assistant(5_000, "length"));

	await fake.commands.outcap.handler("", ctx(fake));
	assert(fake.notifications.some((n) => n.includes("per response: 16384")), "/outcap reports the caps");
	assert(fake.notifications.some((n) => n.includes("footer counter off")), "the footer counter is off by default");
	assert(
		fake.statuses.every((s) => s === undefined),
		"no footer text is rendered while the counter is off",
	);
	assert(fake.notifications.some((n) => n.includes("5.0k")), "/outcap reports this run's output");

	await fake.commands.outcap.handler("off", ctx(fake));
	await fake.commands.outcap.handler("", ctx(fake));
	assert(fake.notifications.some((n) => n.includes("disabled")), "/outcap off disables the guard");

	// Disabled: no guideline, no cap.
	const event = { systemPromptOptions: { promptGuidelines: [] as string[] } };
	await emit(fake, "before_agent_start", event);
	assert(event.systemPromptOptions.promptGuidelines.length === 0, "a disabled guard injects no guideline");
	const [untouched] = await emit(fake, "before_provider_request", {
		type: "before_provider_request",
		payload: { model: "m", max_tokens: 131_072 },
	});
	assert(untouched === undefined, "a disabled guard leaves the payload alone");

	await fake.commands.outcap.handler("per-response 24576", ctx(fake));
	await fake.commands.outcap.handler("run 90000 120000", ctx(fake));
	await fake.commands.outcap.handler("", ctx(fake));
	assert(fake.notifications.some((n) => n.includes("per response: 24576")), "/outcap per-response sets the cap");
	assert(fake.notifications.some((n) => n.includes("steer at 90000")), "/outcap run sets the run budgets");
	assert(JSON.parse(readFileSync(process.env.PI_OUTPUT_CAP_CONFIG as string, "utf8")).perResponse === 24576, "command changes are persisted");
	assert(JSON.parse(readFileSync(process.env.PI_OUTPUT_CAP_CONFIG as string, "utf8")).status === false, "the footer setting is persisted");

	await fake.commands.outcap.handler("on", ctx(fake));
	await fake.commands.outcap.handler("status on", ctx(fake));
	await emit(fake, "message_end", assistant(3_000));
	assert(fake.statuses.some((s) => typeof s === "string" && s.includes("out 8.0k")), "/outcap status on shows the counter");
	await fake.commands.outcap.handler("status off", ctx(fake));
	await emit(fake, "message_end", assistant(4_000));
	assert(fake.statuses.at(-1) === undefined, "/outcap status off clears the footer");

	await fake.commands.outcap.handler("wrapup land it", ctx(fake));
	assert(fake.sent.some((m) => m.content.includes("land it")), "/outcap wrapup sends the instruction");

	await fake.commands.outcap.handler("on", ctx(fake));
	rmSync(process.env.PI_OUTPUT_CAP_CONFIG as string, { force: true });
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
