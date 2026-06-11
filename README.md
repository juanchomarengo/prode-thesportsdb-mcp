# Prode Sirius · TheSportsDB MCP server

A small **remote MCP server** that wraps the **TheSportsDB V2 API** and gives your
Prode Sirius agent live football data to predict World Cup 2026 scorelines.

Your TheSportsDB premium key stays **server-side** (an environment variable). It is
never typed into the Prode page and never leaves your host.

## Tools exposed to the agent

| Tool | What it returns |
|------|-----------------|
| `find_team` | A team's TheSportsDB id from its name (use it with the other tools) |
| `team_recent_form` | Last matches + a W/D/L and goals-for/against summary (attack/defence signal) |
| `team_next_matches` | A team's upcoming fixtures |
| `head_to_head` | Recent meetings between two teams |
| `world_cup_matches` | WC 2026 fixtures/results — filter `all` / `results` / `upcoming`, optional team |
| `world_cup_live` | Matches being played right now |

The agent may make up to 10 tool calls per prediction, which is plenty for: resolve
both teams → pull each team's form → check head-to-head → check current tournament state.

## What you need

- A **TheSportsDB premium key** (the $9/mo tier — it's what unlocks the V2 API and full search).
  Find it on your TheSportsDB profile page.
- A place to host this (free options below). The server must be reachable at a public
  **https** URL, because the Prode agent calls it over the internet.

## Run locally (to try it)

```bash
cp .env.example .env        # then edit .env and paste your THESPORTSDB_KEY
npm install
npm start                   # serves MCP at http://localhost:8080/mcp
npm test                    # protocol + data-mapping smoke test (no key needed)
```

## Deploy (pick one)

The actual deploy needs **your** account login, so you do this last step yourself.
Everything is ready — it's a couple of clicks plus pasting your key.

### Option A — Render (Docker, free tier)
1. Push this folder to a GitHub repo.
2. Render → **New → Blueprint** → select the repo (it reads `render.yaml`).
3. In the service's **Environment** tab set `THESPORTSDB_KEY` (and optionally `MCP_AUTH_TOKEN`), then **Manual Deploy**.
4. Your endpoint is `https://<your-service>.onrender.com/mcp`.

### Option B — Railway / Fly.io
- **Railway:** New Project → Deploy from repo → it builds the Dockerfile → add the env vars → deploy. Use the generated `https://…/mcp`.
- **Fly.io:** `fly launch` (uses the Dockerfile) → `fly secrets set THESPORTSDB_KEY=… MCP_AUTH_TOKEN=…` → `fly deploy`.

### Verify it's up
```bash
curl https://YOUR-HOST/health
# -> {"ok":true,"service":"prode-thesportsdb-mcp"}
```

## Connect it in Prode

On `https://prode.sirius.com.ar/agent`, under **Servidores MCP → Agregar servidor**:

- **Nombre:** `TheSportsDB`
- **URL (https):** `https://YOUR-HOST/mcp`
- **Token (opcional):** the value you set for `MCP_AUTH_TOKEN` (leave blank if you didn't set one)

Save, then **Crear agente** (or **Probar agente** to test first). The agent's prompt is
already written to call these tools and fold the live data into a Poisson-style scoreline.

## Security notes

- The TheSportsDB key lives only in the server env — not in Prode, not in the URL.
- Set `MCP_AUTH_TOKEN` so only your agent (which sends the matching bearer token) can use
  your endpoint and burn your API quota.
- TheSportsDB rate limits premium keys at ~100 requests/min; the server retries once on a 429.
# prode-thesportsdb-mcp
