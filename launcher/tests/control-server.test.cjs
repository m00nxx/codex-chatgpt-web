const test = require("node:test");
const assert = require("node:assert/strict");
const { BrowserControlServer } = require("../electron/control-server.cjs");

test("browser control server authenticates and owns turn visibility", async () => {
  const calls = [];
  const logs = [];
  const host = {
    beginTurn: (...args) => {
      calls.push(["start", ...args]);
      return { surfaceId: "launcher_surface_id_0123456789AB", tabId: "tab-1" };
    },
    heartbeatTurn: (...args) => calls.push(["heartbeat", ...args]),
    endTurn: (...args) => calls.push(["end", ...args]),
  };
  const server = await new BrowserControlServer({
    logger: {
      info: (event, detail) => logs.push(["info", event, detail]),
      warn: (event, detail) => logs.push(["warn", event, detail]),
    },
    getBrowserHost: () => host,
    getPreferences: () => ({ showBrowserDuringTurns: true }),
  }).start();
  const descriptor = server.descriptor();
  try {
    const unauthenticated = await fetch(`${descriptor.endpoint}/v1/turn/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phase: "start", traceId: "abcdef123456" }),
    });
    assert.equal(unauthenticated.status, 401);

    const invalidOwner = await fetch(`${descriptor.endpoint}/v1/turn/start`, {
      method: "POST",
      headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" },
      body: JSON.stringify({ phase: "start", traceId: "abcdef123456", helperPid: 0 }),
    });
    assert.equal(invalidOwner.status, 400);

    const start = await fetch(`${descriptor.endpoint}/v1/turn/start`, {
      method: "POST",
      headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" },
      body: JSON.stringify({ phase: "start", traceId: "abcdef123456", helperPid: process.pid }),
    });
    assert.equal(start.status, 200);

    const heartbeat = await fetch(`${descriptor.endpoint}/v1/turn/heartbeat`, {
      method: "POST",
      headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        phase: "heartbeat",
        traceId: "abcdef123456",
        helperPid: process.pid,
        continuumMode: "full",
        continuumReason: "browser_marker_mismatch",
      }),
    });
    assert.equal(heartbeat.status, 200);

    const invalidContinuumStatus = await fetch(`${descriptor.endpoint}/v1/turn/heartbeat`, {
      method: "POST",
      headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        phase: "heartbeat",
        traceId: "abcdef123456",
        helperPid: process.pid,
        continuumMode: "full",
        continuumReason: "untrusted_task_content",
      }),
    });
    assert.equal(invalidContinuumStatus.status, 400);

    const ownerlessEnd = await fetch(`${descriptor.endpoint}/v1/turn/end`, {
      method: "POST",
      headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" },
      body: JSON.stringify({ phase: "end", traceId: "abcdef123456", status: "failed" }),
    });
    assert.equal(ownerlessEnd.status, 400);

    const end = await fetch(`${descriptor.endpoint}/v1/turn/end`, {
      method: "POST",
      headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        phase: "end",
        traceId: "abcdef123456",
        helperPid: process.pid,
        status: "completed",
      }),
    });
    assert.equal(end.status, 200);
    assert.deepEqual(calls, [
      ["start", "abcdef123456", true, process.pid],
      ["heartbeat", "abcdef123456", process.pid, "full", "browser_marker_mismatch"],
      ["end", "abcdef123456", process.pid, "completed", true, undefined],
    ]);
    assert.equal(logs.some(([, event]) => event === "browser.turn_started"), true);
    assert.equal(logs.some(([, event]) => event === "browser.turn_ended"), true);
  } finally {
    await server.close();
  }
});

test("browser control server binds an opaque Continuum task key to its retained surface", async () => {
  const calls = [];
  const taskKey = "c".repeat(64);
  const server = await new BrowserControlServer({
    logger: { info() {}, warn() {} },
    getBrowserHost: () => ({
      beginTurn: (...args) => {
        calls.push(args);
        return {
          surfaceId: "launcher_surface_id_0123456789AB",
          tabId: "tab-continuum",
          resumed: true,
        };
      },
    }),
    getPreferences: () => ({ showBrowserDuringTurns: false }),
  }).start();
  const descriptor = server.descriptor();
  try {
    const response = await fetch(`${descriptor.endpoint}/v1/turn/start`, {
      method: "POST",
      headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        phase: "start",
        traceId: "continuum123",
        helperPid: process.pid,
        taskKey,
      }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      surfaceId: "launcher_surface_id_0123456789AB",
      tabId: "tab-continuum",
      resumed: true,
    });
    assert.deepEqual(calls, [["continuum123", false, process.pid, taskKey]]);
  } finally {
    await server.close();
  }
});
