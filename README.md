# Nosana MCP

**Let your AI agent rent a GPU and deploy models on [Nosana](https://nosana.com).**
Nosana MCP is a [Model Context Protocol](https://modelcontextprotocol.io) server that gives Claude Code, Claude Desktop, Cursor, Codex, OpenClaw and any other MCP client the tools to browse Nosana's ready-to-run templates (MiniMax H3 video, Qwen and Gemma LLMs, ComfyUI, Jupyter, VS Code), compare GPU markets by live price and availability, estimate the cost, deploy, and hand back the running endpoint. Everything is paid with Nosana account credits through a single API key. No wallet, no tokens.

> "Deploy MiniMax H3 on an RTX 5090 and give me the ComfyUI link."
> The agent checks your credits, picks the 32 GB variant, shows you the price (about 0.40 credits per hour on a 5090), waits for your yes, deploys, polls until ComfyUI answers, and returns the URL. When you are done: "stop it".

A companion CLI, `nosana-deploy`, ships in the same package for humans, scripts and CI. See [docs/CLI.md](docs/CLI.md).

## Quick start

### 1. Credits and an API key

1. Sign in at [deploy.nosana.com](https://deploy.nosana.com).
2. **Billing**: add credits with a card or crypto.
3. **Account > API Keys > Create Key**. Copy it once.

### 2. Add the server to your client

Claude Code:

```bash
claude mcp add nosana --env NOSANA_API_KEY=nos_your_key -- npx -y nosana-mcp
```

Claude Desktop, Cursor, Windsurf and most other clients take the same JSON:

```json
{
  "mcpServers": {
    "nosana": {
      "command": "npx",
      "args": ["-y", "nosana-mcp"],
      "env": { "NOSANA_API_KEY": "nos_your_key" }
    }
  }
}
```

Codex CLI:

```bash
codex mcp add nosana --env NOSANA_API_KEY=nos_your_key -- npx -y nosana-mcp
```

Running from a clone instead of npm:

```bash
git clone https://github.com/SohniSwatantra/nosana-mcp.git && cd nosana-mcp
npm install && npm run build
# then point your client at:  node /absolute/path/to/nosana-mcp/dist/mcp/index.js
```

Instead of the environment variable you can run `nosana-deploy login` once; the server also reads the key that command stores in `~/.config/nosana-deploy/config.json`.

### 3. Ask

- "Deploy Qwen 3.6 27B on the cheapest idle GPU and give me the OpenAI-compatible URL."
- "Deploy MiniMax H3 image-to-video. If no 5090 is idle, show me the alternatives."
- "What is running right now and what does it cost per hour?" / "Stop everything."

The agent must show you the estimate and get a yes before it can call `create_deployment`. Bundled prompts: `deploy_template`, `deploy_llm`, `deploy_comfy`, `deploy_minimax_h3`, `stop_when_done`.

After adding or changing the server configuration, restart the client or reconnect its MCP servers (Claude Code: `/mcp`); tools are discovered at session start.

## Tools

Every tool returns one JSON object, both as text and as MCP `structuredContent`: `{ok, message, next_tool, next_args, ...}`. `ok` is false only when the tool itself failed; deployment outcomes live in `outcome`. Agents never have to parse prose.

| Tool | What it does | Spends credits |
|---|---|---|
| `doctor` | Checks the key, credits and every Nosana API; returns the exact fix (install command, restart hint). | no |
| `get_balance` | Assigned, reserved, settled and available credits. | no |
| `list_templates` / `get_template` | Catalog with kind (comfyui, llm, notebook, ide), VRAM from the template itself, variants, hardware notes, typical boot time. | no |
| `list_gpus` | Markets in buyer buckets: `ready_now` (fits, idle host), `fits_but_queued`, `idle_with_risk`, `unsupported`. Prices per hour include the fee and match the dashboard. | no |
| `recommend_plan` | One call from a workload ("minimax-h3/i2v-32gb", "qwen3-6-27b", "gemma3 12b", or a job definition) to the cheapest ready GPU, cost, similar deployments already running, and exact `create_deployment` arguments. Never picks a queued or unsupported GPU by itself. | no |
| `estimate_deployment` | Dry run of `create_deployment` with the same arguments, including `gpu: "auto"`. | no |
| `create_deployment` | Creates and starts. Needs `confirm=true`. Refuses to queue without `accept_queue`, to duplicate a running workload without `allow_duplicate`, and to use unfit hardware or overspend without `force`. | **yes** |
| `wait_for_deployment` | Watches up to 45 s per call (MCP clients time out at 60 s). Returns `online` with URLs and usage, `completed` with logs, `stopped` (user or timeout, not an error), `failed` with the scheduler error, or `pending` with phase (`queued`, `starting`, `initializing`), elapsed time and `poll_after_seconds`. | no |
| `get_deployment` / `list_deployments` | Status, phase, endpoints with a real readiness probe, price per hour, recent jobs and events. | no |
| `get_endpoint_usage` | How to use the running service: ComfyUI `/prompt` API, OpenAI-compatible base URL for Ollama/vLLM (`/v1/models`, `/v1/chat/completions`), Jupyter/VS Code URL, raw ports for custom jobs. | no |
| `get_job_result` / `get_deployment_events` | Logs and the scheduler's event log. | no |
| `stop_deployment` | Stops jobs; billing stops with them. | ends spending |
| `start_deployment` / `extend_deployment` | Restart a stopped deployment (needs `confirm=true`) or change its timeout. | yes |

Resources: `nosana://templates`, `nosana://gpus`. Prompts: `deploy_template`, `deploy_llm`, `deploy_comfy`, `deploy_minimax_h3`, `stop_when_done`.

### The happy path an agent follows

```
recommend_plan("qwen3-6-27b")        -> ready_now GPU, cost, create_args
create_deployment(create_args, confirm=true)   after the user says yes
wait_for_deployment(id)  x N          -> pending(phase) ... online
get_endpoint_usage(id)                -> OPENAI_BASE_URL, /v1/models, curl example
stop_deployment(id)                   when the user is done
```

## Guard rails built in

- **Confirmation before spending.** `create_deployment` and `start_deployment` do nothing without `confirm=true`; their descriptions tell the agent to show the estimate first, and MCP annotations mark them non-read-only so clients prompt for approval.
- **No silent queueing.** With `gpu: "auto"` only a GPU that fits *and* has an idle host is chosen. If none is ready, the response lists `fits_but_queued` and `idle_with_risk` and asks for a decision (`accept_queue` or `force`). Unsupported hardware (a non-Blackwell card for MiniMax H3) is never offered, because it would download 45 GB of weights and then fail.
- **No accidental duplicates.** Creating a workload that is already running is refused unless `allow_duplicate=true`.
- **60-minute minimum.** Nosana only schedules credit-paid jobs of 3600 seconds or more; shorter values are rejected before anything is created. Workloads that download weights default to 120 minutes.
- **Real readiness.** Nosana's endpoint flag is advisory: it can report online while the container is still loading, and it can lag for many minutes after the service already answers. Once a job is running the server probes the service itself (`/` for web UIs, `/api/tags` or `/v1/models` for LLMs) and reports `online` only on a real answer.
- **Stopped is not failed.** A deployment stopped by the user or its timeout reports `outcome: "stopped"`, so agents do not "fix" it by restarting and paying the boot again.
- **Fail fast, retry the transient.** Repeated scheduler errors end the wait with the error text; transient 5xx and network blips are retried with backoff.
- **Short calls.** No tool blocks longer than 45 seconds. Pending results carry `poll_after_seconds` and `next_args` so the agent can loop safely.

## Costs to expect

Prices come from the live market list and include the network fee, so they match deploy.nosana.com. Every plan and every online result carries `usd_per_hour`, `estimated_credits`, `boot_minutes_typical` and the billing rules (idle time bills, there is no pause, stopping ends billing, restarting pays the boot again). See [docs/COST.md](docs/COST.md) for numbers from real runs.

## Development

```bash
npm install
npm run build
npm run test:mcp          # read-only smoke test with assertions against the live API (needs NOSANA_API_KEY)
SMOKE_DEPLOY=1 npm run test:mcp   # also deploys hello-world once (about 0.05 credits)
npm run inspect           # MCP Inspector UI against the built server
```

Layout: `src/core` (Nosana Kit wrappers: templates, markets, deployments, cost, readiness), `src/mcp` (server and tools), `src/cli` (the `nosana-deploy` command). Both surfaces share the core, so a fix in one place fixes both.

## License

MIT. Not affiliated with Nosana; built on the public `@nosana/kit` SDK and API.
