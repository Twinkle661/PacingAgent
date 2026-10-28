# Agent Pacer

A Hermes Agent plugin that decides when the agent should have its next opportunity to reach out. After a completed turn, a background LLM call reviews recent messages and chooses to start, postpone, keep, or cancel a timer. When it expires, the plugin injects a timestamped user message into the captured gateway session.

## Installation

Use a Hermes version that supports `ctx.llm.complete_structured()`, `ctx.register_auxiliary_task()`, and `ctx.inject_message()`.

From this repository, copy the plugin into your Hermes home:

```sh
mkdir -p ~/.hermes/plugins/agent-pacer
cp __init__.py plugin.yaml ~/.hermes/plugins/agent-pacer/
hermes plugins enable agent-pacer
```

For gateway use, also grant message-injection permission in the target Hermes profile's `config.yaml`. Merge this into any existing `plugins` configuration; do not replace other plugin settings:

```yaml
plugins:
  entries:
    agent-pacer:
      allow_gateway_injection: true
```

Enabling the plugin alone does not grant this permission. It allows the plugin to trigger conversational turns in that profile. If you use a named profile, install, enable, and configure the plugin in that same profile rather than the default Hermes home.

Restart the Hermes gateway after enabling and configuring it. The plugin uses Hermes-managed LLM credentials and registers the `pacer` auxiliary task.

When a timer fires, injection is attempted once. A rejected request or exception is logged, and that notification is not retried automatically; a later completed turn can schedule another timer. A successful request means Hermes accepted it, not that the resulting turn completed or a message was delivered.

## Configuration

Edit the `config` dictionary in the installed `__init__.py` and restart the gateway:

| Setting | Default | Purpose |
| --- | --- | --- |
| `pacer.duration_min` | `1800` | Minimum delay per decision, in seconds |
| `pacer.duration_max` | `28800` | Maximum delay per decision, in seconds |
| `pacer.recent_messages` | `8` | Recent user/assistant messages to review |
| `llm_timeout` | `180` | Background LLM request timeout, in seconds |
| `debug` | `False` | Include a reason in the structured decision |

Postponement adds to the existing deadline, so the total interval can exceed `duration_max`.

The current implementation shares one timer and pending queue across sessions; use it with a single gateway conversation. Timers live in memory and are lost on restart. Background decisions consume LLM tokens, and automated follow-ups can trigger further pacing decisions.

See the [Hermes plugin guide](https://hermes-agent.nousresearch.com/docs/developer-guide/plugins) for plugin setup and validation.
