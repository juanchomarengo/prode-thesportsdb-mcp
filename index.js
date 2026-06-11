// Prode Sirius · TheSportsDB MCP server
// Remote MCP server that wraps TheSportsDB V2 API and exposes a small set of
// football tools tailored to predicting World Cup 2026 scorelines.
//
// Supports BOTH MCP transports so it works with any client:
//   - Streamable HTTP :  POST /mcp
//   - Legacy HTTP+SSE :  GET  /sse   (stream)  +  POST /messages?sessionId=...
//
// Secrets stay server-side via environment variables:
//   THESPORTSDB_KEY  (required)  your TheSportsDB PREMIUM key (enables V2)
//   MCP_AUTH_TOKEN   (optional)  if set, callers must send  Authorization: Bearer <token>
//                                (put this same value in the Prode "Token" field)
//   WC_LEAGUE_ID     (optional)  FIFA World Cup league id on TheSportsDB (default 4429)
//   WC_SEASON        (optional)  season string (default 2026)
//   PORT             (optional)  default 8080

import express from 'express';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { rows, compactEvent, formSummary } from './lib.js';

const KEY = process.env.THESPORTSDB_KEY;
const AUTH = process.env.MCP_AUTH_TOKEN || '';
const WC_LEAGUE_ID = process.env.WC_LEAGUE_ID || '4429';
const WC_SEASON = process.env.WC_SEASON || '2026';
const PORT = process.env.PORT || 8080;
const BASE = 'https://www.thesportsdb.com/api/v2/json';

if (!KEY) {
  console.error('FATAL: THESPORTSDB_KEY env var is required.');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- TheSportsDB V2 fetch (key in X-API-KEY header), with one 429 backoff retry ---
async function tsdb(path, retried = false) {
  const res = await fetch(`${BASE}${path}`, { headers: { 'X-API-KEY': KEY } });
  if (res.status === 429 && !retried) {
    await sleep(2500);
    return tsdb(path, true);
  }
  if (!res.ok) {
    throw new Error(`TheSportsDB returned HTTP ${res.status} for ${path}`);
  }
  return res.json();
}

// --- Build a fresh MCP server instance ---
function buildServer() {
  const server = new McpServer(
    { name: 'prode-thesportsdb', version: '1.0.0' },
    {
      instructions:
        'Football data from TheSportsDB for predicting FIFA World Cup 2026 scorelines. ' +
        'Typical flow: find_team to get a team id, then team_recent_form for form, ' +
        'head_to_head for the rivalry, and world_cup_matches for the current tournament state.',
    },
  );

  const text = (obj) => ({
    content: [{ type: 'text', text: JSON.stringify(obj) }],
  });
  const fail = (msg) => ({
    content: [{ type: 'text', text: JSON.stringify({ error: msg }) }],
    isError: true,
  });

  server.tool(
    'find_team',
    "Find a national team's TheSportsDB id by name (e.g. 'Argentina', 'South Korea'). Returns candidate teams with their ids. Use the id with the other tools.",
    { name: z.string().describe("Team name, e.g. 'Brazil' or 'Saudi Arabia'") },
    async ({ name }) => {
      try {
        const slug = encodeURIComponent(name.trim().replace(/\s+/g, '_'));
        const data = await tsdb(`/search/team/${slug}`);
        const out = rows(data)
          .filter((t) => !t.strSport || t.strSport === 'Soccer')
          .slice(0, 8)
          .map((t) => ({
            id: t.idTeam,
            team: t.strTeam,
            country: t.strCountry,
            league: t.strLeague,
            gender: t.strGender,
          }));
        return text({ query: name, candidates: out });
      } catch (e) {
        return fail(String(e.message || e));
      }
    },
  );

  server.tool(
    'team_recent_form',
    'Recent results (form) for a team by id: last matches with scores, plus a W/D/L + goals summary. Great for estimating attacking/defensive strength.',
    {
      teamId: z.string().describe('TheSportsDB team id (from find_team)'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe('How many recent matches (default 6)'),
    },
    async ({ teamId, limit }) => {
      try {
        const data = await tsdb(
          `/schedule/previous/team/${encodeURIComponent(teamId)}`,
        );
        const events = rows(data).map(compactEvent);
        const recent = events.slice(0, limit || 6);
        return text({
          teamId,
          summary: formSummary(teamId, recent),
          matches: recent,
        });
      } catch (e) {
        return fail(String(e.message || e));
      }
    },
  );

  server.tool(
    'team_next_matches',
    'Upcoming scheduled matches for a team by id (opponent, date, venue).',
    { teamId: z.string().describe('TheSportsDB team id (from find_team)') },
    async ({ teamId }) => {
      try {
        const data = await tsdb(
          `/schedule/next/team/${encodeURIComponent(teamId)}`,
        );
        return text({ teamId, matches: rows(data).map(compactEvent) });
      } catch (e) {
        return fail(String(e.message || e));
      }
    },
  );

  server.tool(
    'head_to_head',
    "Recent head-to-head meetings between two teams (derived from teamA's recent matches filtered to teamB). Pass both team ids from find_team.",
    {
      teamAId: z.string().describe('First team id'),
      teamBId: z.string().describe('Second team id'),
    },
    async ({ teamAId, teamBId }) => {
      try {
        const data = await tsdb(
          `/schedule/previous/team/${encodeURIComponent(teamAId)}`,
        );
        const meetings = rows(data)
          .map(compactEvent)
          .filter(
            (e) =>
              String(e.homeId) === String(teamBId) ||
              String(e.awayId) === String(teamBId),
          );
        return text({ teamAId, teamBId, meetings });
      } catch (e) {
        return fail(String(e.message || e));
      }
    },
  );

  server.tool(
    'world_cup_matches',
    "FIFA World Cup 2026 fixtures and results from TheSportsDB. Filter by 'all' | 'results' (already played) | 'upcoming' (not yet played), and optionally by team name substring. Use this to see how the tournament is actually unfolding.",
    {
      filter: z
        .enum(['all', 'results', 'upcoming'])
        .optional()
        .describe("Default 'all'"),
      team: z
        .string()
        .optional()
        .describe("Optional team name substring, e.g. 'Argentina'"),
    },
    async ({ filter, team }) => {
      try {
        const data = await tsdb(
          `/schedule/league/${WC_LEAGUE_ID}/${WC_SEASON}`,
        );
        let events = rows(data).map(compactEvent);
        const f = filter || 'all';
        if (f === 'results') events = events.filter((e) => e.score != null);
        if (f === 'upcoming') events = events.filter((e) => e.score == null);
        if (team) {
          const q = team.toLowerCase();
          events = events.filter(
            (e) =>
              (e.home && e.home.toLowerCase().includes(q)) ||
              (e.away && e.away.toLowerCase().includes(q)),
          );
        }
        return text({
          season: WC_SEASON,
          filter: f,
          count: events.length,
          matches: events,
        });
      } catch (e) {
        return fail(String(e.message || e));
      }
    },
  );

  server.tool(
    'world_cup_live',
    'Live, in-progress World Cup 2026 matches with current scores (if any are being played right now).',
    {},
    async () => {
      try {
        let data;
        try {
          data = await tsdb(`/livescore/${WC_LEAGUE_ID}`);
        } catch {
          data = await tsdb(`/livescore/soccer`);
        }
        const live = rows(data)
          .map(compactEvent)
          .filter((e) => !e.league || /world cup/i.test(e.league));
        return text({ live });
      } catch (e) {
        return fail(String(e.message || e));
      }
    },
  );

  return server;
}

// --- Auth helper ---
function checkAuth(req, res) {
  if (!AUTH) return true;
  const hdr = req.headers['authorization'] || '';
  const bearer = hdr.startsWith('Bearer ') ? hdr.slice(7) : '';
  const alt = req.headers['x-mcp-token'] || req.headers['x-api-key'] || '';
  if (bearer === AUTH || alt === AUTH) return true;
  res.status(401).json({
    jsonrpc: '2.0',
    error: { code: -32001, message: 'Unauthorized' },
    id: null,
  });
  return false;
}

// --- HTTP layer ---
const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) =>
  res.json({ ok: true, service: 'prode-thesportsdb-mcp' }),
);

// Transport 1: Streamable HTTP (stateless) at POST /mcp
app.post('/mcp', async (req, res) => {
  if (!checkAuth(req, res)) return;
  try {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('MCP (streamable) error:', err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
});
const notAllowed = (_req, res) =>
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed.' },
    id: null,
  });
app.get('/mcp', notAllowed);
app.delete('/mcp', notAllowed);

// Transport 2: legacy HTTP+SSE at GET /sse  +  POST /messages
const sseTransports = {};
app.get('/sse', async (req, res) => {
  if (!checkAuth(req, res)) return;
  try {
    const transport = new SSEServerTransport('/messages', res);
    sseTransports[transport.sessionId] = transport;
    res.on('close', () => {
      delete sseTransports[transport.sessionId];
    });
    const server = buildServer();
    await server.connect(transport);
  } catch (err) {
    console.error('MCP (sse) error:', err);
  }
});
app.post('/messages', async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = sseTransports[sessionId];
  if (!transport) {
    res.status(400).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'No active SSE session for sessionId' },
      id: null,
    });
    return;
  }
  await transport.handlePostMessage(req, res, req.body);
});

app.listen(PORT, () => {
  console.log(`prode-thesportsdb-mcp listening on :${PORT}`);
  console.log(`  Streamable HTTP: POST /mcp`);
  console.log(`  Legacy SSE:      GET /sse  +  POST /messages`);
  console.log(
    `  Auth: ${AUTH ? 'ENABLED (Bearer token required)' : 'disabled'}`,
  );
});
