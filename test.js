// Smoke test: boots the server with a dummy key and exercises the MCP protocol
// over Streamable HTTP (initialize -> tools/list). Also unit-tests the data
// mapping/form logic against a real TheSportsDB sample. No premium key needed.

import { spawn } from "node:child_process";

const PORT = 8791;
const URL = `http://127.0.0.1:${PORT}/mcp`;

function rpc(method, params, id) {
  return fetch(URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // Streamable HTTP requires the client to accept both content types:
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
}

// Streamable HTTP responses may come back as SSE; extract the JSON payload.
async function readResult(res) {
  const ctype = res.headers.get("content-type") || "";
  const body = await res.text();
  if (ctype.includes("text/event-stream")) {
    const line = body.split("\n").find((l) => l.startsWith("data:"));
    return line ? JSON.parse(line.slice(5).trim()) : null;
  }
  return JSON.parse(body);
}

function assert(cond, msg) {
  if (!cond) throw new Error("ASSERT FAILED: " + msg);
  console.log("  ok -", msg);
}

const child = spawn(process.execPath, ["index.js"], {
  env: { ...process.env, THESPORTSDB_KEY: "dummy-for-test", PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (d) => process.stdout.write("[srv] " + d));
child.stderr.on("data", (d) => process.stderr.write("[srv-err] " + d));

async function waitForHealth() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("server did not become healthy");
}

let sessionId = null;

try {
  await waitForHealth();
  console.log("\n[1] MCP initialize");
  const initRes = await rpc(
    "initialize",
    {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "smoke-test", version: "0.0.1" },
    },
    1
  );
  sessionId = initRes.headers.get("mcp-session-id");
  const init = await readResult(initRes);
  assert(init?.result?.serverInfo?.name === "prode-thesportsdb", "server identifies itself");

  console.log("\n[2] tools/list");
  const listRes = await fetch(URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  });
  const list = await readResult(listRes);
  const names = (list?.result?.tools || []).map((t) => t.name).sort();
  console.log("  tools:", names.join(", "));
  const expected = [
    "find_team",
    "head_to_head",
    "team_next_matches",
    "team_recent_form",
    "world_cup_live",
    "world_cup_matches",
  ];
  assert(JSON.stringify(names) === JSON.stringify(expected), "all 6 tools discoverable");

  console.log("\n[3] data-mapping unit test (real TheSportsDB sample)");
  // Two finished matches for Manchester United (id 133612): a 2-0 win, a 0-2 loss.
  const sampleEvents = [
    { dateEvent: "2025-05-25", strHomeTeam: "Manchester United", strAwayTeam: "Aston Villa", idHomeTeam: "133612", idAwayTeam: "133601", intHomeScore: "2", intAwayScore: "0", strStatus: "Match Finished" },
    { dateEvent: "2025-05-11", strHomeTeam: "Manchester United", strAwayTeam: "West Ham", idHomeTeam: "133612", idAwayTeam: "133636", intHomeScore: "0", intAwayScore: "2", strStatus: "Match Finished" },
    { dateEvent: "2026-06-20", strHomeTeam: "Manchester United", strAwayTeam: "TBD", idHomeTeam: "133612", idAwayTeam: "0", intHomeScore: null, intAwayScore: null, strStatus: "Not Started" },
  ];
  const { compactEvent, formSummary } = await import("./lib.js");
  const compact = sampleEvents.map(compactEvent);
  assert(compact[0].score === "2-0", "finished match maps score 2-0");
  assert(compact[2].score === null, "unplayed match has null score");
  const sum = formSummary("133612", compact);
  assert(sum.w === 1 && sum.l === 1 && sum.d === 0, "W/D/L computed from team perspective (1-0-1)");
  assert(sum.goalsFor === 2 && sum.goalsAgainst === 2, "goals for/against tallied");

  console.log("\nALL TESTS PASSED ✔");
  child.kill();
  process.exit(0);
} catch (err) {
  console.error("\nTEST FAILED:", err.message);
  child.kill();
  process.exit(1);
}
