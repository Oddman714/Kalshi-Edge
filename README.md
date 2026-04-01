# Kalshi Edge — AI-Powered Prediction Market Bot

Automated trading bot for Kalshi prediction markets using Claude AI signal generation, Kelly criterion sizing, and RSA-PSS authentication. Fully legal for US users.

## Quick Deploy to Railway

### Step 1: Kalshi Account
1. Sign up at https://kalshi.com
2. Complete identity verification (KYC)
3. Deposit starting funds ($25-50)
4. Go to **Account & Security → API Keys → Create Key**
5. Save the `.key` file and copy the API Key ID

### Step 2: GitHub Repo
1. Create new repo: `kalshi-edge` (private recommended)
2. Upload all files from this project
3. Commit and push

### Step 3: Railway Deploy
1. Go to https://railway.app → New Project → Deploy from GitHub
2. Select your `kalshi-edge` repo
3. Add environment variables (see below)
4. Railway auto-deploys on every push

### Step 4: Environment Variables

**Required:**
| Variable | Value | Notes |
|---|---|---|
| `KALSHI_API_KEY_ID` | `your-key-id` | From Kalshi API settings |
| `KALSHI_PRIVATE_KEY` | Full PEM contents | Paste entire `.key` file contents. Replace newlines with `\n` |
| `CLAUDE_API_KEY` | `sk-ant-...` | Anthropic API key |

**Trading Config (defaults shown):**
| Variable | Default | Description |
|---|---|---|
| `DRY_RUN` | `true` | Set to `false` for live trading |
| `BANKROLL` | `50` | Starting bankroll in dollars |
| `KELLY_FRACTION` | `0.35` | Kelly criterion fraction (0.25=conservative, 0.5=aggressive) |
| `CLAUDE_EDGE` | `0.07` | Minimum edge to trigger trade (7%) |
| `MAX_POSITION` | `5` | Max dollars per trade |
| `MAX_DAILY_LOSS` | `8` | Daily loss limit in dollars |
| `MAX_CONCURRENT` | `5` | Max simultaneous positions |
| `POLL_INTERVAL` | `45` | Seconds between scans |
| `MIN_VOLUME` | `3000` | Min market volume (cents) |

**Optional:**
| Variable | Description |
|---|---|
| `TELEGRAM_TOKEN` | Bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | Your chat ID for alerts |
| `KALSHI_BASE_URL` | Override for demo: `https://demo-api.kalshi.co` |

### Step 5: Test in Demo First
Set `KALSHI_BASE_URL=https://demo-api.kalshi.co` and create demo API keys at https://demo.kalshi.com to test everything before going live.

### Step 6: Go Live
1. Switch API keys to production keys
2. Remove the `KALSHI_BASE_URL` override (or set to `https://api.elections.kalshi.com`)
3. Set `DRY_RUN=false`
4. Monitor via the dashboard

## Dashboard
Access at your Railway URL (e.g., `kalshi-edge.up.railway.app`)
- **Dashboard**: Balance, P&L, win rate, recent trades
- **Positions**: Current open positions
- **Signals**: Latest Claude AI analysis
- **Logs**: System activity

## Strategy
The bot uses three complementary edges:
1. **News-driven mispricing** — Claude AI spots markets slow to react to headlines
2. **Favourite-longshot bias** — Avoids cheap "lottery" contracts, favors high-probability plays
3. **Maker advantage** — Uses limit orders only (zero fees on Kalshi for makers)

## Architecture
```
server.js        — Express server + trading engine + API
dashboard.html   — iOS 26-style PWA dashboard
state.json       — Persistent trade/position state
```
