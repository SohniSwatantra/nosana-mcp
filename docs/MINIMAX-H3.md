# Run MiniMax H3 on Nosana from the terminal

MiniMax H3 generates video with native audio. Nosana ships it as a ready-to-run ComfyUI template, so you can rent an RTX 5090 by the hour instead of paying per minute of video through a hosted API. This guide takes you from an empty terminal to an open ComfyUI tab.

## 1. Get credits and an API key

1. Sign in at https://deploy.nosana.com.
2. **Billing**: add credits with a card or crypto (free trial credits may also be available).
3. **Account > API Keys > Create Key**: name it, copy it once.

## 2. Install the CLI

```bash
git clone <this repo> nosana-deploy-cli && cd nosana-deploy-cli
npm install && npm run build && npm link
nosana-deploy login          # paste the key; the CLI verifies it and shows your balance
```

## 3. Pick a variant and a GPU

```bash
nosana-deploy templates show minimax-h3
nosana-deploy gpus --template minimax-h3 --variant i2v-32gb
```

| Variant | Use it for | Needs |
|---|---|---|
| `i2v-32gb` | Image (first/last frame) or text to video, 8-step turbo LoRA | RTX 5090 (32 GB) |
| `ref2v-32gb` | Reference images drive identity and style, 4-step turbo LoRA | RTX 5090 (32 GB) |
| `i2v-80gb` / `ref2v-80gb` | Same workflows with the larger weights | RTX PRO 6000 (96 GB) |

The `gpus` table marks each card `fits`, `check hardware` (enough VRAM but not Blackwell) or `too little VRAM`, and shows idle hosts and price per hour.

## 4. Deploy

Guided:

```bash
nosana-deploy run
```

One line:

```bash
nosana-deploy run --template minimax-h3 --variant i2v-32gb --gpu nvidia-5090 --timeout 120
```

The CLI prints the plan and the cost of one timeout window (about 0.80 credits for two hours on a 5090 at the time of writing), asks for confirmation, creates the deployment, starts it and follows it:

```
00:00  deployment STARTING
00:05  deployment RUNNING
00:05  event JOB_LIST_CONFIRMED: Successfully listed job - G4cn...r54n
00:05  job G4cn...r54n QUEUED
02:10  job G4cn...r54n RUNNING on host 9sz4...C5T5
...    (the weights download here: about 5 minutes on a host that has them cached, up to 30 or more on a cold one)
OK  Your workload is online.
   https://<host>.node.k8s.prd.nos.ci  (MiniMaxH3-i2v-comfy, port 8188)
```

Open that URL: it is ComfyUI with the MiniMax H3 weights already in place. Build the graph described in `nosana-deploy templates show minimax-h3 --readme` (UNETLoader -> LoraLoaderModelOnly -> ModelSamplingMiniMaxH3 -> KSampler -> VAEDecode + VAEDecodeAudio -> CreateVideo). The bundled `api_minimax_h3_*` templates inside ComfyUI call MiniMax's cloud API, not the local weights, so do not use those.

## 5. Keep an eye on it, then stop

```bash
nosana-deploy deploy watch <id>       # resume following if you closed the terminal
nosana-deploy deploy get <id>         # status and endpoint
nosana-deploy deploy extend <id> --timeout 240
nosana-deploy deploy stop <id>        # billing stops with the job
```

A `SIMPLE` deployment stops on its own when the timeout elapses. Use `--strategy SIMPLE-EXTEND` to keep it running while credits last.

## Things that trip people up

- Timeouts under 60 minutes never schedule. The CLI refuses them.
- If no 5090 host is idle, the job queues. Either wait or pick the RTX PRO 6000 (`--gpu nvidia-pro6000`, more expensive).
- The first start can be slow because 44 to 55 GB of weights have to reach the host (our test came online after 5.5 minutes on a warm host). Give it a 120-minute timeout or more.
- MiniMax H3's nvfp4 text encoder needs a Blackwell card and an r580+ driver; Ada and Hopper hosts will fail.
