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

- "What GPUs fit MiniMax H3 and what do they cost per hour?"
- "Estimate a 2-hour MiniMax H3 image-to-video deployment on a 5090."
- "Deploy it." (the agent must show you the estimate and get a yes before it can call `create_deployment`)
- "Is it online yet?" / "Show me the logs." / "Stop it."

Or use the bundled prompt `deploy_minimax_h3` from your client's prompt picker.

## Tools

| Tool | What it does | Spends credits |
|---|---|---|
| `get_balance` | Assigned, reserved, settled and available credits. | no |
| `list_templates` / `get_template` | Catalog with variants, VRAM needs and hardware notes (MiniMax H3 needs a Blackwell GPU). | no |
| `list_gpus` | Markets with price/h (fee included, matches the dashboard), idle hosts right now, and whether each fits a template. | no |
| `estimate_deployment` | Dry run: resolves template, variant and GPU, validates, returns cost for one timeout window plus warnings. | no |
| `create_deployment` | Creates and starts a deployment. Requires `confirm=true`; refuses blocking warnings unless `force=true`. | **yes** |
| `wait_for_deployment` | Watches up to 120 s per call: `online` (service answers, with URLs), `completed` (with logs), `failed` (with the scheduler error) or `pending`. | no |
| `get_deployment` / `list_deployments` | Status, endpoints with a real readiness check, recent jobs and events. | no |
| `get_job_result` / `get_deployment_events` | Logs and the scheduler's event log. | no |
| `stop_deployment` | Stops jobs; billing stops with them. | ends spending |
| `start_deployment` / `extend_deployment` | Restart a stopped deployment (needs `confirm=true`) or change its timeout. | yes |

Resources: `nosana://templates` and `nosana://gpus`. Prompt: `deploy_minimax_h3`.

## Guard rails built in

- **Confirmation before spending.** `create_deployment` and `start_deployment` do nothing without `confirm=true`, and their descriptions tell the agent to show the estimate first. MCP tool annotations mark them as non-read-only so clients prompt for approval.
- **60-minute minimum.** Nosana only schedules credit-paid jobs of 3600 seconds or more. Shorter deployments are accepted by the API but never run. The server rejects them before anything is created.
- **Fit checks.** Too little VRAM, a non-Blackwell card for MiniMax H3, or insufficient credits block a deployment unless forced. No idle hosts is reported as an advisory.
- **Real readiness.** Nosana marks an endpoint online when the host tunnel is up while the container may still be downloading weights. The server probes the URL and only reports `online` once the service answers.
- **Fail fast.** Repeated scheduler errors (bad timeout, insufficient funds) end the wait with the error text instead of spinning.
- **Read-only by default.** Everything except create, start, extend and stop is read-only and idempotent.

## Costs to expect

Prices come from the live market list and include the network fee, so they match deploy.nosana.com. At the time of writing an RTX 3060 is about $0.05/h, an RTX 4090 about $0.32/h, an RTX 5090 about $0.40/h, an RTX PRO 6000 about $1.00/h. MiniMax H3 32 GB variants need the 5090; the 80 GB variants need the PRO 6000. Credits are reserved when a job is listed and settled for the time actually used; a `SIMPLE` deployment stops on its own at the timeout.

## Development

```bash
npm install
npm run build
npm run test:mcp          # read-only smoke test against the live API (needs NOSANA_API_KEY)
SMOKE_DEPLOY=1 npm run test:mcp   # also deploys hello-world once (about 0.05 credits)
npm run inspect           # MCP Inspector UI against the built server
```

Layout: `src/core` (Nosana Kit wrappers: templates, markets, deployments, cost, readiness), `src/mcp` (server and tools), `src/cli` (the `nosana-deploy` command). Both surfaces share the core, so a fix in one place fixes both.

## License

MIT. Not affiliated with Nosana; built on the public `@nosana/kit` SDK and API.
