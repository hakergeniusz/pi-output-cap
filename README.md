# pi-output-cap

A response that spends 100k+ output tokens and ends with *"Response was truncated before completion"* has achieved nothing. This extension makes that outcome unreachable, and recoverable when a provider still forces it.

```
[pi-output-cap] response was truncated — requesting a short wrap-up
```

The cap is **per model turn**, never per chat. A long conversation with many turns is not a budget problem; one runaway response is. Nothing here sums output across a run, steers at a run total, or aborts a run for spending.

The guard is silent until it matters. No footer counter unless you ask for one (`/outcap status on`).

## What it does

**1. Hard cap per turn.** Every output-limit field in the outgoing provider payload — `max_tokens`, `max_completion_tokens`, `max_output_tokens`, `maxTokens`, `maxOutputTokens`, including the nested `generationConfig` and `inferenceConfig` shapes — is clamped to the budget, and only ever *lowered*. One response can no longer run away, whatever the model's own limit says. Compaction and branch-summary calls don't pass through this hook, so context summaries keep their full budget.

**2. The agent knows its budget.** One deterministic guideline bullet in the system prompt: write code, logs, and long prose to files, report paths, keep chat replies short, land the result before the details. It states that every turn starts fresh. Deterministic, so the cached prompt prefix survives turn to turn.

**3. Wrap-up instead of silence.** A run whose last response was cut off at the cap gets exactly one extra turn under a small cap with a strict instruction: at most 120 words — what is done, what is not, the exact next step. You get an answer instead of a cut-off blob.

Fail-open everywhere: on any surprise the payload, the run, and the transcript stay exactly as pi built them.

## Commands

| Command | Effect |
|---|---|
| `/outcap` | Show the caps plus the last turn's and this session's output-token usage |
| `/outcap on` / `/outcap off` | Enable / disable the guard |
| `/outcap status on` / `off` | Show / hide the live footer counter (off by default) |
| `/outcap per-response <n>` | Set the per-turn cap in tokens (`off` to drop it) |
| `/outcap wrapup [text]` | Ask for a bounded wrap-up turn right now |

Defaults: 16384 tokens per turn, 2048 for the wrap-up turn. Settings persist in `~/.pi/agent/pi-output-cap.json`.

The footer counter, when enabled, shows the last turn's usage against the ceiling (`turn 12.4k/16.4k`, with `!` when the response hit the cap) — not a running total.

Thinking models get headroom — the ceiling is doubled at `high` and tripled at `xhigh` — and the model's own `maxTokens` always wins when it is lower than the budget.

## Removed: run budgets

Earlier versions steered at a per-run soft total and aborted at a hard one. Both are gone. Summing output across a turn punished long sessions for something no single response did, and an abort cut off work that was going fine. `/outcap run` now says so instead of setting anything.

## Install

```bash
pi install git:github.com/hakergeniusz/pi-output-cap
```

Try without installing:

```bash
pi -e https://github.com/hakergeniusz/pi-output-cap/raw/main/index.ts
```

Or copy `index.ts` into `~/.pi/agent/extensions/`.

## Environment overrides

| Variable | Effect |
|---|---|
| `PI_OUTPUT_CAP=off` | Disable the guard for this session |
| `PI_OUTPUT_CAP_PER_RESPONSE` | Per-turn cap in tokens |
| `PI_OUTPUT_CAP_WRAP_UP_CAP` | Cap for the forced wrap-up turn |
| `PI_OUTPUT_CAP_STATUS` | `1` shows the footer counter |
| `PI_OUTPUT_CAP_CONFIG` | Path to the settings file |

## Test

```bash
bun test.ts          # 52 checks against a fake ExtensionAPI, no network
bunx tsc -p tsconfig.json
pi -p "Reply with exactly: OK"   # proves the extension loads in a real session
```

## License

MIT — see [LICENSE](LICENSE).