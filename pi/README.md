# Pacing Agent — pi

A [pi](https://github.com/badlogic/pi-mono) extension that uses a background LLM to decide when the agent should reach out again. Port of the [Hermes plugin](../hermes-agent).

## How it works

1. After each run settles (`agent_settled`, the final idle point, after retries and queued follow-ups), the extension takes the last few user/assistant text messages from the active branch.
2. A background model returns a timer decision: `start`, `postpone`, `keep` or `cancel`, plus `delay_seconds`. It answers by calling a `pacing_decision` tool whose parameters are the JSON schema. If a model replies in text instead, the extension parses JSON from that text as a fallback.
3. When the timer fires, the extension sends `[Time Passed: it is HH:MM:SS now.]` as a user message (`pi.sendUserMessage`). That starts a new turn, or is queued as a follow-up if the agent is busy.

Only the latest pending context is kept; a request already in flight is not interrupted.

## Installation

Install as a pi package from this repository:

```sh
pi install git:github.com/Twinkle661/PacingAgent
```

The root `package.json` points pi at `pi/index.ts`. To load a local checkout instead, add the file to `extensions` in `~/.pi/agent/settings.json`, or try it once with `pi -e ./pi/index.ts`.

No build step is needed: pi loads TypeScript directly.

## Configuration

Create `~/.pi/agent/pacing-agent.json` (or set `PACING_AGENT_CONFIG` to another path). See [`pacing-agent.example.json`](pacing-agent.example.json). Every key is optional.

| Setting | Default | Purpose |
| --- | --- | --- |
| `model.provider` / `model.id` | session's active model | Background model for timing decisions (any model pi knows, including providers in `models.json`) |
| `timeZone` | system zone | IANA zone for clock times shown to the pacer and in notifications. Set this in Docker, where the system zone is often UTC |
| `pacer.durationMin` | `300` | Minimum delay per decision, in seconds |
| `pacer.durationMax` | `28800` | Maximum delay per decision, in seconds |
| `pacer.recentMessages` | `8` | Recent user/assistant messages reviewed per decision |
| `llmTimeout` | `180` | Background request timeout, in seconds |
| `maxTokens` | `512` | Output cap for the background request |
| `debug` | `false` | Ask for a `reason` in the decision and write DEBUG lines to the log |
| `restoreOnStartup` | `true` | Restore an active timer from the session file on startup, resume and reload |
| `logFile` | `~/.pi/agent/pacing-agent.log` | Log file; `""` disables logging |

Restart pi (or `/reload`) after changing the config. Credentials come from pi's normal auth; none go in this file.

Choose a model that calls tools reliably. A lightweight model is a reasonable starting point. Background decisions consume model usage in addition to normal chat replies. Without `model`, every decision runs on the chat model.

The `/pacing` command shows the current timer.

## Differences from the Hermes version

- **Hook:** `agent_settled` instead of `post_llm_call`.
- **Structured output:** a tool call with constrained sampling (`strict: "prefer"`) instead of `complete_structured`. The result is validated and `delay_seconds` is clamped to the configured range.
- **Session scope:** one pi process runs one session at a time, so the timer belongs to that session. It is cleared on `/new`, `/resume`, `/fork`, `/reload` and quit, and a notification is skipped if the session has changed.
- **Persistence:** each timer change is written to the session as a custom entry (`pacing-agent-timer`, not sent to the LLM). On restart the timer is restored; a timer that ran out while pi was down fires about 5 seconds after startup.
- **Time:** the pacer sees times with a UTC offset, weekday and zone, e.g. `2026-11-21T14:38:05+00:00 (Sat, Europe/London)`, and each recent message carries its own timestamp.
- **Logging:** goes to a file, never stdout, because stdout is the protocol channel in RPC mode.
- **Modes:** active in TUI, RPC and JSON modes; disabled in print mode (`-p`).

## Notes

- Automated follow-ups trigger further pacing decisions; the prompt tells the pacer to back off when contact goes unanswered.
- A failed notification is logged and not retried.
- Postponements add to the existing deadline, so the total interval can exceed `durationMax`.
