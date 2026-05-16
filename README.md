# Meridian

**Autonomous Meteora DLMM liquidity management agent for Solana, powered by LLMs.**

Meridian runs continuous screening and management cycles, deploying capital into high-quality Meteora DLMM pools and closing positions based on live PnL, yield, and range data. It learns from every position it closes.

---

## What it does

- **Screens pools** — scans Meteora DLMM pools against configurable thresholds (fee/TVL ratio, organic score, holder count, mcap, bin step) and surfaces high-quality opportunities
- **Manages positions** — monitors, claims fees, and closes LP positions autonomously; decides to STAY, CLOSE, or REDEPLOY based on live data
- **Learns from performance** — studies top LPers in target pools, saves structured lessons, and evolves screening thresholds based on closed position history
- **Discord signals** — optional Discord listener watches LP Army channels for Solana token calls and queues them for screening
- **Telegram chat** — full agent chat via Telegram, plus cycle reports and OOR alerts
- **Claude Code integration** — run AI-powered screening and management directly from your terminal using Claude Code slash commands

---

## How it works

Meridian runs a **ReAct agent loop** — each cycle the LLM reasons over live data, calls tools, and acts. Two specialized agents run on independent cron schedules:

| Agent | Default interval | Role |
|---|---|---|
| **Screening Agent** | Every 15 min | Pool screening — finds and deploys into the best candidate |
| **Management Agent** | Every 5 min | Position management — evaluates each open position and acts |

**Data sources:** Meteora DLMM SDK, Meteora PnL API, OKX OnchainOS (smart money signals), Pool screening API (fee/TVL, organic scores), Jupiter API (token audit, mcap, price).

Agents are powered via **OpenRouter** and can be swapped for any compatible model (including local models via LM Studio).

---

## Requirements

- Node.js 18+
- [OpenRouter](https://openrouter.ai) API key
- Solana wallet (base58 private key)
- Solana RPC endpoint ([Helius](https://helius.xyz) recommended)
- Telegram bot token (optional)
- [Claude Code](https://claude.ai/code) CLI (optional, for terminal slash commands)

---

## Quick start

```bash
git clone https://github.com/faizalmy/meridian
cd meridian
npm install
npm run setup    # walks you through .env + user-config.json (~2 min)
```

The wizard creates `.env` (API keys, wallet, RPC, Telegram) and `user-config.json` (risk preset, deploy size, thresholds, models).

**Or set up manually:**

```env
WALLET_PRIVATE_KEY=your_base58_private_key
RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
OPENROUTER_API_KEY=sk-or-...
HELIUS_API_KEY=your_helius_key
TELEGRAM_BOT_TOKEN=123456:ABC...        # optional
TELEGRAM_CHAT_ID=                       # set your chat ID
DRY_RUN=true                            # set false for live trading
```

> Never put your private key or API keys in `user-config.json` — use `.env` only. Both files are gitignored.

### Run

```bash
npm run dev    # dry run — no on-chain transactions
npm start      # live mode
```

On startup Meridian fetches your wallet balance, open positions, and top pool candidates, then begins autonomous cycles immediately.

### Run with PM2 (recommended for VPS)

```bash
npm install
npm run pm2:start
pm2 save
```

To update: `git pull && npm install && npm run pm2:restart`

---

## Running modes

### Autonomous agent

```bash
npm start
```

Starts the full autonomous agent with cron-based screening + management cycles and an interactive REPL. The prompt shows a live countdown to the next cycle:

```
[manage: 3m 12s | screen: 11m 3s]
>
```

**REPL commands:**

| Command | Description |
|---|---|
| `/status` | Wallet balance and open positions |
| `/candidates` | Re-screen and display top pool candidates |
| `/learn [pool]` | Study top LPers (all candidates or specific pool) |
| `/thresholds` | Current screening thresholds and performance stats |
| `/evolve` | Trigger threshold evolution (needs 5+ closed positions) |
| `/stop` | Graceful shutdown |
| `<anything>` | Free-form chat — ask the agent anything |

---

### Claude Code (recommended)

Install [Claude Code](https://claude.ai/code) and run it from inside the meridian directory. Claude Code has built-in agents and slash commands that use the `meridian` CLI under the hood.

```bash
cd meridian
claude
```

**Slash commands:**

| Command | What it does |
|---|---|
| `/screen` | Full AI screening cycle — checks Discord queue, fetches candidates, runs deep research, deploys if a winner is found |
| `/manage` | Full AI management cycle — checks all positions, evaluates PnL, claims fees, closes OOR/losing positions |
| `/balance` | Check wallet SOL and token balances |
| `/positions` | List all open DLMM positions with range status |
| `/candidates` | Fetch and enrich top pool candidates |
| `/study-pool` | Study top LPers on a specific pool |
| `/pool-ohlcv` | Fetch price/volume history for a pool |
| `/pool-compare` | Compare all Meteora DLMM pools for a token pair |

**Sub-agents:** `screener` (pool screening, token risk, deploy) and `manager` (position review, PnL, close).

**Loop mode:** Run screening or management on a timer:
```
/loop 15m /screen     # screen every 15 minutes
/loop 5m /manage      # manage every 5 minutes
```

---

### CLI (direct tool invocation)

The `meridian` CLI gives direct access to every tool with JSON output — useful for scripting, debugging, or piping.

```bash
npm install -g .       # install globally (once)
meridian <command> [flags]
```

Or without installing: `node cli.js <command> [flags]`

| Category | Commands |
|---|---|
| **Positions & PnL** | `positions` · `pnl <addr>` · `wallet-positions --wallet <addr>` |
| **Screening** | `candidates --limit N` · `pool-detail --pool <addr>` · `active-bin --pool <addr>` · `search-pools --query <name>` · `study --pool <addr>` |
| **Token research** | `token-info --query <mint>` · `token-holders --mint <addr>` · `token-narrative --mint <addr>` |
| **Deploy & manage** | `deploy --pool <addr> --amount <sol>` · `claim --position <addr>` · `close --position <addr>` · `swap --from <mint> --to <mint> --amount <n>` · `add-liquidity` · `withdraw-liquidity` |
| **Agent cycles** | `screen [--dry-run] [--silent]` · `manage [--dry-run] [--silent]` · `start [--dry-run]` |
| **Config** | `config get` · `config set <key> <value>` |
| **Learning** | `lessons` · `lessons add "<text>"` · `performance` · `evolve` · `pool-memory --pool <addr>` |
| **Blacklist** | `blacklist list` · `blacklist add --mint <addr> --reason "<reason>"` |
| **Other** | `balance` · `discord-signals [clear]` |

**Flags:** `--dry-run` skips all on-chain transactions. `--silent` suppresses Telegram notifications.

---

## Telegram

### Setup

1. Create a bot via [@BotFather](https://t.me/BotFather) and copy the token
2. Add to your `.env`:
   ```env
   TELEGRAM_BOT_TOKEN=<token>
   TELEGRAM_CHAT_ID=<target chat id>
   TELEGRAM_ALLOWED_USER_IDS=<comma-separated user IDs>
   ```
3. Start the agent — notifications go to the configured chat

> Security: If `TELEGRAM_CHAT_ID` is not set, inbound Telegram control is ignored. Command/control is limited to allowed user IDs. Notifications still work.

### Notifications

Meridian sends notifications automatically for:
- Management cycle reports (reasoning + decisions)
- Screening cycle reports (what it found, whether it deployed)
- OOR alerts when a position leaves range past `outOfRangeWaitMinutes`
- Deploy: pair, amount, position address, tx hash
- Close: pair and PnL

### Commands

| Command | Action |
|---|---|
| `/positions` | List open positions with progress bar |
| `/close <n>` | Close position by list index |
| `/closeall` | Close all positions |
| `/set <n> <note>` | Set a note on a position |
| `/pool <n>` | Detailed position info |
| `/status` / `/wallet` | Wallet status |
| `/screen` | Quick deterministic screen |
| `/candidates` | Latest candidates |
| `/deploy <n>` | Deploy candidate N |
| `/settings` / `/menu` | Interactive config menu |
| `/setcfg <key> <value>` | Update config |
| `/pause` / `/resume` | Pause/resume cycles |
| `/briefing` | Generate daily briefing |
| `/hive` | HiveMind status/pull |

You can also chat freely via Telegram — same interface as the REPL.

---

## Discord signals

The Discord listener watches configured channels (e.g. LP Army) for Solana token calls and queues them as priority signals for the screener agent.

### Setup

```bash
cd discord-listener
npm install
```

Add to your root `.env`:
```env
DISCORD_USER_TOKEN=your_discord_account_token
DISCORD_GUILD_ID=the_server_id
DISCORD_CHANNEL_IDS=channel1,channel2
DISCORD_MIN_FEES_SOL=5
```

> This uses a selfbot (personal account automation, not a bot token). Use responsibly.

### Signal pipeline

Each incoming token address passes through: dedup → blacklist → pool resolution → rug check → fees check. Signals that pass all checks are queued as `pending` and picked up by `/screen` and `node cli.js screen` before the normal screening cycle.

Add known rug deployer wallets to `deployer-blacklist.json`.

---

## Learning & evolution

### Lessons

After every closed position the agent studies top LPers in candidate pools, analyzes on-chain behavior (hold duration, entry/exit timing, win rates), and saves concrete lessons. Lessons are injected into subsequent agent cycles.

```bash
node cli.js lessons                              # list lessons
node cli.js lessons add "Never deploy under 2h"   # add manually
```

### Threshold evolution

After 5+ closed positions, the agent automatically evolves screening thresholds based on performance data. You can also trigger manually:

```bash
node cli.js evolve
```

---

## HiveMind

HiveMind sync uses Agent Meridian at `https://api.agentmeridian.xyz` by default. Agents register automatically, pull shared lessons/presets, and push learning events — no separate registration needed.

**Shared:** Lessons, strategy presets, crowd performance context.
**Private:** Your private keys and wallet balances are never sent.

HiveMind failures are non-blocking — if the API is unavailable, the agent logs a warning and keeps running.

Relevant config:
```json
{
  "agentId": "",
  "hiveMindUrl": "",
  "hiveMindApiKey": "",
  "hiveMindPullMode": "auto"
}
```

Blank values fall back to Agent Meridian defaults. Set `hiveMindPullMode` to `manual` to disable auto-pull.

---

## Local model (LM Studio)

Any OpenAI-compatible endpoint works:

```env
LLM_BASE_URL=http://localhost:1234/v1
LLM_API_KEY=lm-studio
LLM_MODEL=your-local-model-name
```

---

## Config reference

All fields optional — defaults shown. Edit `user-config.json` (copy from `user-config.example.json`).

### Screening

| Field | Default | Description |
|---|---|---|
| `minFeeActiveTvlRatio` | `0.05` | Minimum fee/active-TVL ratio |
| `minTvl` / `maxTvl` | `10000` / `150000` | Pool TVL range (USD) |
| `minVolume` | `500` | Minimum pool volume |
| `minOrganic` / `minQuoteOrganic` | `60` / `60` | Min organic scores (base/quote) |
| `minHolders` | `500` | Minimum token holder count |
| `minMcap` / `maxMcap` | `150000` / `10000000` | Market cap range (USD) |
| `minBinStep` / `maxBinStep` | `80` / `125` | Bin step range |
| `timeframe` | `5m` | Candle timeframe for screening |
| `category` | `trending` | Pool category filter |
| `minTokenFeesSol` | `30` | Minimum all-time fees in SOL |
| `maxBundlePct` / `maxBotHoldersPct` | `30` / `30` | Max bundler + bot holder % |
| `maxTop10Pct` | `60` | Max top-10 holder concentration |
| `avoidPvpSymbols` | `true` | Avoid PvP token pairs |
| `blockedLaunchpads` | `[]` | Launchpad names to never deploy into |
| `minTokenAgeHours` / `maxTokenAgeHours` | `null` | Token age range (hours) |

### Management

| Field | Default | Description |
|---|---|---|
| `deployAmountSol` | `0.5` | Base SOL per new position |
| `positionSizePct` | `0.35` | Fraction of deployable balance to use |
| `maxDeployAmount` | `50` | Maximum SOL cap per position |
| `gasReserve` | `0.2` | Minimum SOL to keep for gas |
| `minSolToOpen` | `0.55` | Minimum wallet SOL before opening |
| `maxPositions` | `3` | Maximum concurrent positions |
| `stopLossPct` | `-50` | Close position if price drops by this % |
| `takeProfitPct` | `5` | Close position if price rises by this % |
| `trailingTakeProfit` | `true` | Enable trailing take-profit |
| `trailingTriggerPct` | `3` | PnL % to trigger trailing TP |
| `trailingDropPct` | `1.5` | Drop from peak to confirm exit |
| `outOfRangeWaitMinutes` | `30` | Minutes OOR before acting |
| `outOfRangeBinsToClose` | `10` | Bins above range to trigger close |
| `oorCooldownTriggerCount` | `3` | Consecutive OOR closes to trigger cooldown |
| `oorCooldownHours` | `12` | OOR cooldown duration (hours) |
| `minClaimAmount` | `5` | Minimum claimable fees (SOL) |
| `minFeePerTvl24h` | `7` | Min 24h fee/TVL to keep position open |
| `strategy` | `bid_ask` | Default LP strategy |

### Schedule

| Field | Default | Description |
|---|---|---|
| `managementIntervalMin` | `5` | Management cycle frequency (minutes) |
| `screeningIntervalMin` | `15` | Screening cycle frequency (minutes) |
| `healthCheckIntervalMin` | `60` | Health check frequency (minutes) |

### Models

| Field | Default | Description |
|---|---|---|
| `managementModel` | `minimax/minimax-m2.5` | LLM for management cycles |
| `screeningModel` | `minimax/minimax-m2.5` | LLM for screening cycles |
| `generalModel` | `minimax/minimax-m2.7` | LLM for REPL / chat |
| `temperature` | `0.373` | LLM temperature |
| `maxTokens` | `4096` | Max tokens per LLM response |
| `maxSteps` | `20` | Max ReAct steps per cycle |

Override at runtime: `node cli.js config set screeningModel anthropic/claude-opus-4-5`

---

## Architecture

```
index.js            Main entry: REPL + cron orchestration + Telegram bot polling
agent.js            ReAct loop: LLM → tool call → repeat
config.js           Runtime config from user-config.json + .env
prompt.js           System prompt builder (SCREENER / MANAGER / GENERAL roles)
state.js            Position registry (state.json)
decision-log.js     Structured decision log for deploy, close, skip, and no-deploy rationale
lessons.js          Learning engine: records performance, derives lessons, evolves thresholds
pool-memory.js      Per-pool deploy history + snapshots
strategy-library.js Saved LP strategies
telegram.js         Telegram bot: polling + notifications
telegram-formatter.js  HTML notification formatting
hivemind.js         Agent Meridian HiveMind sync
smart-wallets.js    KOL/alpha wallet tracker
token-blacklist.js  Permanent token blacklist
signal-weights.js   Dynamic signal weighting
cli.js              Direct CLI — every tool as a subcommand with JSON output

tools/
  definitions.js    Tool schemas (OpenAI format)
  executor.js       Tool dispatch + safety checks
  dlmm.js           Meteora DLMM SDK wrapper
  screening.js      Pool discovery
  wallet.js         SOL/token balances + Jupiter swap
  token.js          Token info, holders, narrative
  study.js          Top LPer study via LPAgent API
  chart-indicators.js  RSI/SuperTrend indicator presets

discord-listener/
  index.js          Selfbot Discord listener
  pre-checks.js     Signal pre-check pipeline

.claude/
  agents/
    screener.md     Claude Code screener sub-agent
    manager.md      Claude Code manager sub-agent
  commands/
    screen.md       /screen slash command
    manage.md       /manage slash command
    balance.md      /balance slash command
    positions.md    /positions slash command
    candidates.md   /candidates slash command
    study-pool.md   /study-pool slash command
    pool-ohlcv.md   /pool-ohlcv slash command
    pool-compare.md /pool-compare slash command
```

---

## Disclaimer

This software is provided as-is, with no warranty. Running an autonomous trading agent carries real financial risk — you can lose funds. Always start with `DRY_RUN=true` to verify behavior before going live. Never deploy more capital than you can afford to lose. This is not financial advice.

The authors are not responsible for any losses incurred through use of this software.
