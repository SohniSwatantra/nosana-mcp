# What Nosana GPU time costs through this MCP

All numbers below were observed with this server on 4 and 5 September 2026 (mainnet). Prices are read live from the market list on every call, so treat these as illustrations, not a price list.

## Price per hour (fee included)

| GPU market | VRAM | USD per hour | Typical use |
|---|---|---|---|
| nvidia-3060 | 8 GB | 0.048 | hello-world, small Ollama models (Gemma 3 4B) |
| nvidia-3090 | 24 GB | 0.192 | Qwen 3.5 27B, Gemma 3 27B, ComfyUI SD/SDXL |
| nvidia-4090 | 24 GB | 0.320 | same, faster |
| nvidia-5090 | 32 GB | 0.400 | MiniMax H3 32 GB variants (Blackwell required) |
| nvidia-a6000 | 48 GB | 0.400 | Qwen 3.6 35B-A3B; not MiniMax H3 (Ampere) |
| nvidia-pro6000 | 96 GB | 1.000 | MiniMax H3 80 GB variants |

Credits are priced like USD. Credits are reserved when a job is listed and settled for the time actually used.

## Observed runs

| Run | GPU | Boot to service answering | Billed |
|---|---|---|---|
| hello-world (`echo hello world`) | nvidia-3060 | job completed 5 to 20 s after listing | under 0.001 credits |
| MiniMax H3 i2v-32gb, 120 min SIMPLE | nvidia-5090 | 4 min queued for an idle host, then about 7 min until ComfyUI returned HTTP 200 | 0.728 credits for the full window |
| Qwen 3.6 27B (Ollama), via the MCP `recommend_plan` -> `create_deployment` -> `wait_for_deployment` loop | nvidia-3090 | host assigned immediately, 6 min until `/v1/models` answered, stopped right after | about 0.02 credits |
| MiniMax H3 i2v-32gb again, through the published `npx -y nosana-mcp` package | nvidia-5090 (cold host) | ComfyUI answered well before the 40-minute watch ended, but Nosana's endpoint flag stayed offline for a long time; 0.2.1 probes the URL regardless of that flag | 0.8 credits reserved for the 120-minute window |

The MiniMax boot was fast because the host already had most of the 45 GB of weights cached. A cold host can take 15 minutes or more. Idle time counts: a 5090 left running for an hour after you finish is 0.40 credits gone.

## Rules the tools encode

- Minimum timeout 60 minutes (Nosana rejects shorter credit-paid jobs).
- No pause. `stop_deployment` ends billing; `start_deployment` starts a new job and pays the boot again.
- SIMPLE strategy stops on its own at the timeout; SIMPLE-EXTEND and INFINITE keep billing until stopped.
