import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import { ChatGptWebSendRateLimiter } from "../src/adapters/chatgpt-web/rate-limiter";

const namespace = "a".repeat(64);

describe("ChatGPT Web account send limiter", () => {
  test("spaces newly created browser sends without delaying the first send", async () => {
    let now = 1_000;
    const waits: number[] = [];
    const limiter = new ChatGptWebSendRateLimiter(
      undefined,
      namespace,
      () => now,
      async delayMs => {
        waits.push(delayMs);
        now += delayMs;
      },
    );

    await limiter.beforeSend(2_000, 30_000);
    await limiter.beforeSend(2_000, 30_000);

    expect(waits).toEqual([2_000]);
    expect(now).toBe(3_000);
  });

  test("a 429 observed by another turn cancels a send that is still waiting", async () => {
    let now = 1_000;
    let limiter!: ChatGptWebSendRateLimiter;
    limiter = new ChatGptWebSendRateLimiter(
      undefined,
      "b".repeat(64),
      () => now,
      async delayMs => {
        now += 100;
        limiter.recordRateLimit(30_000);
        now += delayMs - 100;
      },
    );
    await limiter.beforeSend(2_000, 30_000);

    const error = await limiter.beforeSend(2_000, 30_000).catch(caught => caught);
    expect(error).toBeInstanceOf(ChatGptWebAdapterError);
    expect((error as ChatGptWebAdapterError).code).toBe("rate_limit_cooldown");
    expect((error as ChatGptWebAdapterError).retryable).toBe(false);
  });

  test("persists cooldown across limiter and process-style restarts", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cgw-rate-limit-restart-"));
    try {
      const path = join(directory, "rate-limit.json");
      let now = 1_000;
      const first = new ChatGptWebSendRateLimiter(path, "c".repeat(64), () => now);
      first.recordRateLimit(30_000);

      now = 2_000;
      const restarted = new ChatGptWebSendRateLimiter(path, "c".repeat(64), () => now);
      const blocked = await restarted.beforeSend(0, 30_000).catch(caught => caught);
      expect(blocked).toBeInstanceOf(ChatGptWebAdapterError);
      expect(restarted.remainingCooldownMs()).toBe(29_000);

      now = 31_001;
      await restarted.beforeSend(0, 30_000);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("quarantines corrupt state and refuses the first send with a safety cooldown", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cgw-rate-limit-corrupt-"));
    try {
      const path = join(directory, "rate-limit.json");
      writeFileSync(path, "not-json-sensitive-evidence");
      const limiter = new ChatGptWebSendRateLimiter(path, "d".repeat(64), () => 10_000);

      const blocked = await limiter.beforeSend(0, 30_000).catch(caught => caught);
      expect(blocked).toBeInstanceOf(ChatGptWebAdapterError);
      expect((blocked as ChatGptWebAdapterError).code).toBe("rate_limit_cooldown");
      expect(readFileSync(path, "utf8")).not.toContain("sensitive-evidence");
      expect(readdirSync(directory).some(name => name.startsWith("rate-limit.json.corrupt-"))).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects schema-valid timestamps that could pin the account far into the future", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cgw-rate-limit-future-"));
    try {
      const path = join(directory, "rate-limit.json");
      writeFileSync(path, JSON.stringify({
        version: 1,
        entries: {
          [namespace]: {
            nextSendAt: Number.MAX_SAFE_INTEGER,
            cooldownUntil: Number.MAX_SAFE_INTEGER,
            updatedAt: 10_000,
          },
        },
      }));
      const limiter = new ChatGptWebSendRateLimiter(path, namespace, () => 10_000);

      const blocked = await limiter.beforeSend(0, 30_000).catch(caught => caught);
      expect(blocked).toBeInstanceOf(ChatGptWebAdapterError);
      expect((blocked as ChatGptWebAdapterError).code).toBe("rate_limit_cooldown");
      expect(readdirSync(directory).some(name => name.startsWith("rate-limit.json.corrupt-"))).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
