# Recorded Antigravity CLI output

stdout captured from real `agy 1.3.4 --output-format stream-json -p <prompt>`
runs on 2026-10-14, then trimmed and anonymized: the conversation id is a fixed
placeholder, the working directory is `/workspace/project`, the `init` tool list
is cut to four entries, and the one `ls -la` tool output is a neutral listing.
Frame order and shape are otherwise unchanged.

| file | what it contains |
| --- | --- |
| `agy-1.3.4-text-tool-text.ndjson` | One turn: response step `Checking.`, a `run_command` tool (`ACTIVE` then `DONE`), response step `Done.`. The terminal `result.response` is the text of both response steps joined. |
| `agy-1.3.4-tool-error.ndjson` | A `view_file` tool that ends with `state: "ERROR"` and the reason in `tool_info.error.message` (no `DONE` frame), followed by a text reply. |
| `agy-1.3.4-interrupted.ndjson` | The process was sent a termination signal mid-turn. agy prints `result.status: "ERROR"` with `error: "interrupted"` and exits 1. |
