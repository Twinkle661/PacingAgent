# Pacing Agent

LLM-guided timers that give a conversational agent an opportunity to reach out again after a conversation. After each turn, a background model decides when the agent should next check in; when the timer fires, the agent gets a `[Time Passed: ...]` message and a new turn.

| Harness | Folder | Install |
| --- | --- | --- |
| [pi](https://github.com/badlogic/pi-mono) | [`pi/`](pi) | `pi install git:github.com/Twinkle661/PacingAgent` |
| [Hermes Agent](https://hermes-agent.nousresearch.com) | [`hermes-agent/`](hermes-agent) | Copy the folder into `plugins/pacing-agent/` |

Both versions use the same pacing prompt and timer logic (`start` / `postpone` / `keep` / `cancel`). See each folder's README for configuration.

## License

MIT
