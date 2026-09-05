# Nosana Deploy CLI (`nosana-deploy`)

The command-line half of [Nosana MCP](../README.md). It shares its core with the MCP server and is meant for humans, scripts and CI.

Deploy GPU workloads on [Nosana](https://nosana.com) from your terminal, paid with **account credits** and authenticated with a **Nosana API key**. Pick a ready-to-run template such as **MiniMax H3**, choose a GPU by price and live availability, confirm the cost, and watch the deployment come online.

The deployments you create here are the same objects you see on [deploy.nosana.com](https://deploy.nosana.com), so you can switch between the CLI and the dashboard at any time.

```
$ nosana-deploy run --template minimax-h3 --variant i2v-32gb --gpu nvidia-5090 --timeout 120

Plan
  Workload      minimax-h3-i2v-32gb  MiniMax H3 Video - Image to Video (32 GB)
  GPU           NVIDIA 5090 (nvidia-5090)  32 GB  3 hosts available  $0.400/h
  Strategy      SIMPLE, 1 replica, timeout 2 h
  Estimate      0.800 credits for one timeout window ($0.400/h x 2.00 h x 1)
  Credits       89.101 available
? Create and start this deployment? Yes
OK  Created deployment J2Ws52RB...HQzkHr (DRAFT)
OK  Started
00:05  deployment RUNNING
00:05  job G4cn...r54n QUEUED
...
OK  Your workload is online.
   https://<host>.node.k8s.prd.nos.ci  (MiniMaxH3-i2v-comfy, port 8188)
```

## Requirements

- Node.js 20 or newer
- A Nosana account with credits. Top up on deploy.nosana.com under **Billing** (card or crypto).
- An API key from deploy.nosana.com under **Account > API Keys**.

## Install

```bash
git clone https://github.com/SohniSwatantra/nosana-mcp.git
cd nosana-mcp
npm install
npm run build
npm link            # puts `nosana-deploy` on your PATH; or call `node dist/index.js ...`
```

`npm link` installs the binary into your global npm bin directory (`npm prefix -g`/bin). If that directory is not on your PATH, either add it or run `npx nosana-deploy` from inside this folder.

## Five-minute start

```bash
nosana-deploy login                                   # paste your API key once; it is verified and stored
nosana-deploy templates list                          # what you can run
nosana-deploy gpus --template minimax-h3 --variant i2v-32gb   # which GPUs fit, price/h, idle hosts
nosana-deploy run                                     # guided: template -> variant -> GPU -> timeout -> confirm
nosana-deploy deploy list                             # everything on your account
nosana-deploy deploy stop <id>                        # stop paying
```

`run` without flags is fully interactive. With flags it is scriptable:

```bash
nosana-deploy run --template minimax-h3 --variant i2v-32gb --gpu nvidia-5090 --timeout 120 --yes
nosana-deploy run --template hello-world --gpu nvidia-3060 --timeout 60 --yes --json
nosana-deploy run --file examples/minimax-h3-i2v-32gb.json --gpu 5090 --timeout 90 --yes
```

## Commands

| Command | What it does |
|---|---|
| `login` / `logout` | Verify and store (or remove) the API key in `~/.config/nosana-deploy/config.json` (mode 600). |
| `balance` | Assigned, reserved, settled and available credits. |
| `doctor` | Checks Node, the key and every Nosana API the CLI uses. Run this first when something looks wrong. |
| `templates list [--all] [--search x]` | Template catalog. Variants (e.g. `minimax-h3-i2v-32gb`) fold under their parent. |
| `templates show <id> [--variant v] [--readme]` | Variants, VRAM and hardware notes, exposed ports, the job definition. |
| `templates export <id> [--variant v] [-o file]` | Save a template job definition to customise and deploy with `--file`. |
| `gpus [--template id --variant v] [--vram gb] [--all] [--queue]` | Markets with price/h (fee included, matches the dashboard), idle hosts, and whether each fits the workload. |
| `run [flags]` | Guided deploy: create, start, and watch until the endpoint is online or the job completes. |
| `deploy create [flags] [--start]` | Same as `run` but never prompts; creates a draft unless `--start`. |
| `deploy list / get / start / stop / watch` | Lifecycle. `start --wait` and `watch` follow status, jobs, events and endpoints. |
| `deploy jobs / events / result <id>` | Jobs a deployment ran, its event log, and the logs/results of a job. |
| `deploy extend / scale / rename / revision <id>` | Change timeout, replicas, name, or upload a new job definition revision. |
| `deploy auth-header <id>` | Access header for a `--confidential` deployment's endpoint. |
| `deploy archive / delete <id> [--yes]` | Housekeeping, with confirmation. `delete` stops a running deployment first. Drafts cannot be removed through the API until they have been started and stopped once. |
| `job get <address>` | Look up any job by address. |

Global flags: `--json` (machine-readable output), `--network mainnet|devnet`, `--api-key <key>`, `--rpc <url>`.

## Deploy flags

| Flag | Meaning |
|---|---|
| `-t, --template <id>` / `--variant <id>` | Template and variant, e.g. `minimax-h3` + `i2v-32gb`. |
| `-f, --file <job.json>` | Deploy your own job definition instead of a template. |
| `-g, --gpu <market>` | `nvidia-5090`, `5090`, `NVIDIA 5090` or a market address. |
| `--timeout <minutes>` | GPU time reserved per job. **Minimum 60**, see below. Default 60. |
| `--replicas <n>` | Parallel jobs. Default 1. |
| `--strategy SIMPLE\|SIMPLE-EXTEND\|SCHEDULED\|INFINITE` | SIMPLE runs once and stops at the timeout. SIMPLE-EXTEND keeps extending while credits last. SCHEDULED needs `--schedule "<cron>"`. INFINITE keeps a replacement job ready (`--rotation-time`, `--startup-timeout`). |
| `--confidential` | Hide the job on the explorer and protect the endpoint with an auth header. |
| `--ssh-key <pubkey...>` | Allow SSH into the jobs (max 10 keys). |
| `--all` | Allow community GPU markets. |
| `--no-wait` / `--wait-timeout <min>` | Do not watch, or watch longer than the default 45 minutes. |
| `-y, --yes` | Skip the confirmation. Required when not in a terminal. |
| `--force` | Deploy despite a too-small GPU or insufficient credits. |

## Things to know before you deploy

- **Timeouts are at least 60 minutes.** Nosana only schedules credit-paid jobs of 3600 seconds or more. A shorter deployment is accepted by the API but never gets a job; the scheduler logs `JOB_LIST_ERROR ... must have a timeout of at least 3600 seconds` forever. The CLI rejects such values before creating anything.
- **Cost estimate.** `price/h x timeout x replicas` is what one window can cost. Credits are reserved when the job is listed and settled for the time actually used. A SIMPLE deployment stops at the timeout; stop it earlier with `deploy stop`.
- **"Available"** is the number of idle hosts waiting in that GPU market right now. With 0 available the job queues until a host frees up; the CLI warns but lets you proceed.
- **Big templates can start slowly.** MiniMax H3 needs 44 to 55 GB of weights on the host before ComfyUI answers: about 5 minutes when the host has them cached, much longer when it does not. Use a timeout of 120 minutes or more; `deploy watch <id>` can be re-run any time.
- **MiniMax H3 needs Blackwell.** The 32 GB variants run on the RTX 5090; the 80 GB variants need an RTX PRO 6000. The CLI flags other cards as `check hardware`.
- **Endpoints and "online".** Nosana marks an endpoint online as soon as the host's tunnel is up, while the container may still be pulling its image or weights (the URL then shows a "Service Initializing" page). The CLI probes the URL and only reports the workload online once it answers with something other than a 502/503/504. For `--confidential` deployments add the header from `deploy auth-header <id>`.

## Non-interactive use

Every prompt has a flag. Without a TTY the CLI never prompts; missing values fail with exit code 2 and a hint. Exit codes: 0 success, 1 runtime or deployment failure, 2 usage error, 130 cancelled. Add `--json` for machine-readable output on any command.

## Configuration

API key resolution order: `--api-key`, then `NOSANA_API_KEY`, then the file written by `login`. Set `NOSANA_DEPLOY_CONFIG_DIR` to move the config directory. Never commit API keys.

## Troubleshooting

- `nosana-deploy doctor` shows which layer fails (key, credits API, markets, templates, deployments, RPC).
- `deploy events <id>` shows the scheduler's reasons: no funds, unavailable hosts, bad timeout.
- Status `INSUFFICIENT_FUNDS`: top up on deploy.nosana.com (Billing) and `deploy start <id>` again.
- A watch that ends on a network error leaves the deployment running; resume with `deploy watch <id>`.

## History

This CLI started life as `nosana-credits-cli` (June 2026), which pinned `@nosana/kit` 2.3.1 and posted direct jobs with 10-minute timeouts that Nosana never scheduled, because credit-paid jobs need 60 minutes. It was rewritten in September 2026 on `@nosana/kit` 2.11.2 with templates, GPU selection, cost checks and end-to-end watching, and now lives in this repository next to the MCP server.

## Development

```bash
npm run dev:cli -- templates list  # run from source with tsx
npm run typecheck
npm run build
```

`examples/` holds exported job definitions (`hello-world.json`, `minimax-h3-i2v-32gb.json`) you can deploy with `--file`.

## License

MIT
