# Pi integration notes

Source: https://github.com/earendil-works/pi (`packages/coding-agent`, docs in `docs/`).

- **Package:** `@earendil-works/pi-coding-agent`, binary `pi`, Node >= 22.19.
- **Sessions (step 4):** run `pi --mode rpc` inside the project container (`docker exec -i`).
  Commands are JSONL on stdin (`prompt`, `get_state`, `set_model`, ...); stdout carries
  `response` records and session events. Frame on LF only (not Node `readline`, which also
  splits on U+2028/U+2029). Subscribe to events before sending `prompt`, and treat
  `agent_settled` (not `agent_end`) as "done". See `docs/rpc.md`, `rpc-commands.md`, `json.md`.
- **Providers (step 5):** pi reads `models.json` from `PI_CODING_AGENT_DIR` (default `~/.pi/agent`).
  A provider entry has `baseUrl`, `apiKey` (literal, `$ENV`, or `!command`), and `api`
  (`openai-completions`, `openai-responses`, `anthropic-messages`, ...). So Pi-Panel generates
  `models.json` per project instead of proxying requests, and Anthropic needs no separate adapter.
  See `docs/models-configuration.md`, `docs/llama-cpp.md`.
- **Implemented providers (step 5):** `anthropic` and `openai` use pi's built-in providers with
  `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` (optional `baseUrl` override in `models.json`);
  `openai-compatible` (llama.cpp, Unsloth Studio, others) is written to `models.json` as an
  `openai-completions` provider with `apiKey: "$PP_KEY_<id>"`. Keys are AES-256-GCM encrypted in
  SQLite, `models.json` never contains them, and only the session's chosen provider key is put in
  that pi process's env. The model is selected with the RPC `set_model` command, not `--model`,
  because ids like `qwen2.5-coder:7b` collide with the CLI's `:<thinking>` suffix. Caveat: pi's
  bash tool can read its own process env, so a session can see its provider's key.
- **Credentials:** pass only the keys a project needs as container env vars; never mount the
  host's `~/.pi/agent`. See `docs/containerization.md`.
- **Packages (step 7):** `pi install npm:<name>`; see `docs/packages.md` (not yet reviewed).
- **Env:** `PI_SKIP_VERSION_CHECK`, `PI_TELEMETRY=0`, `PI_OFFLINE`, `PI_CODING_AGENT_SESSION_DIR`.
