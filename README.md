# pi-output-cap

A run that spends 100k+ output tokens and ends with *"Response was truncated before completion"* has achieved nothing. This extension makes that outcome unreachable, and recoverable when a provider still forces it.

```
[pi-output-cap] run budget 75% spent — asking the agent to land the answer
[pi-output-cap] run budget spent (100.0k output tokens) — stopping the run
[pi-output-cap] response was truncated — requesting a short wrap-up
```

The guard is silent until it matters. No footer counter unless you ask for one (`/outcap status on`).

## What it does

**1. Hard cap per response.** Every output-limit field in the outgoing provider payload — `max_tokens`, `max_completion_tokens`, `max_output_tokens`, `maxTokens`, `maxOutputTokens`, including the nested `generationConfig` and `inferenceConfig` shapes — is clamped to the budget, and only ever *lowered*. One response can no longer run away, whatever the model's own limit says. Compaction and branch-summary calls don't pass through this hook, so context summaries keep their full budget.

**2. The agent knows its budget.** One deterministic guideline bullet in the system prompt: write code, logs, and long prose to files, report paths, keep chat replies short, land the result before the details. Deterministic, so the cached prompt prefix survives turn to turn.

**3. Budget for the whole run.** Output tokens are summed per agent run. At the soft budget the agent is steered to land the answer; at the hard budget the run is aborted so it cannot keep spending.

**4. Wrap-up instead of silence.** A run that ended truncated, or was aborted on budget, gets exactly one extra turn under a small cap with a strict instruction: at most 120 words — what is done, what is not, the exact next step. You get an answer instead of a cut-off blob.

Fail-open everywhere: on any surprise the payload, the run, and the transcript stay exactly as pi built them.

## Commands

| Command | Effect |
|---|---|
| `/outcap` | Show the caps plus this run's and this session's output-token usage |
| `/outcap on` / `/outcap off` | Enable / disable the guard |
| `/outcap status on` / `off` | Show / hide the live footer counter (off by default) |
| `/outcap per-response <n>` | Set the per-response cap in tokens (`off` to drop it) |
| `/outcap run <soft> [hard]` | Tokens per run before steering / before aborting (`off` to drop) |
| `/outcap wrapup [text]` | Ask for a bounded wrap-up turn right now |

Defaults: 16384 tokens per response, steer at 60000 per run, abort at 100000, 2048 for the wrap-up turn. Settings persist in `~/.pi/agent/pi-output-cap.json`.

Thinking models get headroom — the ceiling is doubled at `high` and tripled at `xhigh` — and the model's own `maxTokens` always wins when it is lower than the budget.

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
| `PI_OUTPUT_CAP_PER_RESPONSE` | Per-response cap in tokens |
| `PI_OUTPUT_CAP_RUN_SOFT` | Run budget that triggers the steer |
| `PI_OUTPUT_CAP_RUN_HARD` | Run budget that aborts the run |
| `PI_OUTPUT_CAP_WRAP_UP_CAP` | Cap for the forced wrap-up turn |
| `PI_OUTPUT_CAP_STATUS` | `1` shows the footer counter |
| `PI_OUTPUT_CAP_CONFIG` | Path to the settings file |

## Test

```bash
bun test.ts          # 61 checks against a fake ExtensionAPI, no network
bunx tsc -p tsconfig.json
pi -p "Reply with exactly: OK"   # proves the extension loads in a real session
```

## License

MIT — see [LICENSE](LICENSE).
