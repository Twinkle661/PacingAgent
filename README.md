# Pacing Agent

A Hermes Agent plugin that uses a background LLM to decide when the agent should reach out again.

## Installation

Requires Hermes with `ctx.llm.complete_structured()`, `ctx.register_auxiliary_task()`, and `ctx.inject_message()` support.

Place this repository inside the target Hermes home's `plugins/pacing-agent/` directory, with `plugin.yaml` and `__init__.py` directly inside it. You can clone the repository there or copy those files.

Enable it from the same Hermes profile:

```sh
hermes plugins enable pacing-agent
```

Complete the configuration below, then restart that profile's gateway. For named profiles, use that profile's plugin directory and configuration, not the default Hermes home.

## Hermes configuration

Merge these settings into the target profile's `config.yaml`, preserving any existing plugin and auxiliary settings:

```yaml
plugins:
  entries:
    pacing-agent:
      allow_gateway_injection: true

auxiliary:
  pacer:
    provider: "<your-provider>"
    model: "<your-model>"
```

### Gateway permission

`allow_gateway_injection: true` allows Pacing Agent to trigger conversational turns. Enabling the plugin alone does not grant this permission.

### Background model

Replace the provider and model placeholders with the identifiers for your chosen Hermes provider and model. Configure that provider's credentials through Hermes; do not put credentials in the plugin source.

- `auxiliary.pacer` selects the model used for background timing decisions, not the model that writes chat replies.
- Choose a model that reliably produces structured JSON. A lightweight model is a reasonable starting point.
- Background decisions consume model usage in addition to normal chat replies.

Restart the gateway after configuration changes.

## Pacing settings

Edit the `config` dictionary near the top of the installed `__init__.py`, then restart the gateway. These are plugin-source settings; adding them to Hermes's `config.yaml` will not configure the current implementation.

| Setting | Default | Purpose |
| --- | --- | --- |
| `pacer.duration_min` | `1800` | Minimum delay per decision, in seconds |
| `pacer.duration_max` | `28800` | Maximum delay per decision, in seconds |
| `pacer.recent_messages` | `8` | Recent user/assistant messages reviewed per decision |
| `llm_timeout` | `180` | Timeout passed to the background LLM request, in seconds |
| `debug` | `False` | Request a reason in the structured decision; does not enable debug logging |

Postponements add to the existing deadline, so the total interval can exceed `duration_max`. Back up local source edits before updating the plugin.

## Notes

- Use with a single gateway conversation: the current implementation shares one timer across sessions. Timers are lost on restart.
- Automated follow-ups can trigger further pacing decisions.
- Failed notification injection is logged without automatic retries. Check gateway logs if the agent does not reach out.

See the [Hermes plugin guide](https://hermes-agent.nousresearch.com/docs/developer-guide/plugins) for general plugin setup.
