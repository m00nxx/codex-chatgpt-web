import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { atomicWriteFile } from "../../config";
import { ChatGptWebAdapterError } from "./adapter-error";

const RATE_LIMIT_STATE_VERSION = 1;
const RATE_LIMIT_STATE_TTL_MS = 24 * 60 * 60_000;
const MAX_RATE_LIMIT_NAMESPACES = 16;
const MAX_PERSISTED_FUTURE_MS = 3_600_000;
const MAX_UPDATED_AT_CLOCK_SKEW_MS = 60_000;
const sharedLimiters = new Map<string, ChatGptWebSendRateLimiter>();

interface StoredRateLimitEntry {
  nextSendAt: number;
  cooldownUntil: number;
  updatedAt: number;
}

interface StoredRateLimitFile {
  version: typeof RATE_LIMIT_STATE_VERSION;
  entries: Record<string, StoredRateLimitEntry>;
}

type Wait = (delayMs: number, signal?: AbortSignal) => Promise<void>;

function abortableWait(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException("ChatGPT browser send gate aborted", "AbortError"));
  return new Promise<void>((resolveWait, rejectWait) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolveWait();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      rejectWait(new DOMException("ChatGPT browser send gate aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function finiteTimestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Invalid persisted ChatGPT Web ${label}`);
  }
  return value as number;
}

function validateEntry(value: unknown, now: number): StoredRateLimitEntry {
  const parsed = record(value);
  if (!parsed) throw new Error("Invalid persisted ChatGPT Web rate-limit entry");
  const entry = {
    nextSendAt: finiteTimestamp(parsed.nextSendAt, "next-send timestamp"),
    cooldownUntil: finiteTimestamp(parsed.cooldownUntil, "cooldown timestamp"),
    updatedAt: finiteTimestamp(parsed.updatedAt, "rate-limit update timestamp"),
  };
  if (entry.updatedAt > now + MAX_UPDATED_AT_CLOCK_SKEW_MS
    || entry.nextSendAt > now + MAX_PERSISTED_FUTURE_MS
    || entry.cooldownUntil > now + MAX_PERSISTED_FUTURE_MS) {
    throw new Error("Persisted ChatGPT Web rate-limit state is implausibly far in the future");
  }
  return entry;
}

function cooldownError(remainingMs: number): ChatGptWebAdapterError {
  const seconds = Math.max(1, Math.ceil(remainingMs / 1_000));
  return new ChatGptWebAdapterError(
    `ChatGPT Web account cooldown is active for about ${seconds} more second${seconds === 1 ? "" : "s"}; refusing to start another browser send.`,
    {
      status: 429,
      errorType: "rate_limit_error",
      code: "rate_limit_cooldown",
      retryable: false,
    },
  );
}

function assertInterval(value: number, label: string, minimum: number, maximum: number): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum} milliseconds`);
  }
}

/**
 * Account-scoped send gate. It spaces newly created browser turns and persists a terminal cooldown
 * after ChatGPT reports a rate limit. A request observed during cooldown fails immediately; it is
 * never queued to become an automatic send later.
 */
export class ChatGptWebSendRateLimiter {
  private loaded = false;
  private recoveredCorruptState = false;
  private readonly entries = new Map<string, StoredRateLimitEntry>();

  constructor(
    private readonly path: string | undefined,
    private readonly namespace: string,
    private readonly now: () => number = Date.now,
    private readonly wait: Wait = abortableWait,
  ) {
    if (!/^[a-f0-9]{64}$/.test(namespace)) {
      throw new Error("ChatGPT Web rate limiter requires a 64-character account namespace");
    }
  }

  async beforeSend(
    minimumIntervalMs: number,
    recoveryCooldownMs: number,
    signal?: AbortSignal,
    onWait?: (delayMs: number) => void,
  ): Promise<void> {
    assertInterval(minimumIntervalMs, "ChatGPT browser minimum send interval", 0, 60_000);
    assertInterval(recoveryCooldownMs, "ChatGPT rate-limit cooldown", 30_000, 3_600_000);
    this.load();
    const initialNow = this.now();
    this.prune(initialNow);
    if (this.recoveredCorruptState) {
      this.recoveredCorruptState = false;
      this.setCooldown(initialNow + recoveryCooldownMs, initialNow);
      throw cooldownError(recoveryCooldownMs);
    }
    const current = this.entries.get(this.namespace) ?? {
      nextSendAt: 0,
      cooldownUntil: 0,
      updatedAt: initialNow,
    };
    if (current.cooldownUntil > initialNow) {
      throw cooldownError(current.cooldownUntil - initialNow);
    }

    const sendAt = Math.max(initialNow, current.nextSendAt);
    this.entries.delete(this.namespace);
    this.entries.set(this.namespace, {
      nextSendAt: sendAt + minimumIntervalMs,
      cooldownUntil: current.cooldownUntil,
      updatedAt: initialNow,
    });
    this.prune(initialNow);
    this.persist();

    const delayMs = Math.max(0, sendAt - initialNow);
    if (delayMs > 0) {
      onWait?.(delayMs);
      await this.wait(delayMs, signal);
    }
    if (signal?.aborted) throw new DOMException("ChatGPT browser send gate aborted", "AbortError");

    // A different in-flight turn may have observed a 429 while this reservation was waiting.
    const finalNow = this.now();
    const latest = this.entries.get(this.namespace);
    if (latest && latest.cooldownUntil > finalNow) {
      throw cooldownError(latest.cooldownUntil - finalNow);
    }
  }

  recordRateLimit(cooldownMs: number): number {
    assertInterval(cooldownMs, "ChatGPT rate-limit cooldown", 30_000, 3_600_000);
    this.load();
    const now = this.now();
    const until = now + cooldownMs;
    this.setCooldown(until, now);
    return until;
  }

  remainingCooldownMs(now = this.now()): number {
    this.load();
    return Math.max(0, (this.entries.get(this.namespace)?.cooldownUntil ?? 0) - now);
  }

  private setCooldown(until: number, now: number): void {
    const current = this.entries.get(this.namespace);
    const cooldownUntil = Math.max(current?.cooldownUntil ?? 0, until);
    this.entries.delete(this.namespace);
    this.entries.set(this.namespace, {
      nextSendAt: Math.max(current?.nextSendAt ?? 0, cooldownUntil),
      cooldownUntil,
      updatedAt: now,
    });
    this.prune(now);
    this.persist();
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.path || !existsSync(this.path)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<StoredRateLimitFile>;
      const entries = record(parsed.entries);
      if (parsed.version !== RATE_LIMIT_STATE_VERSION || !entries) {
        throw new Error("Invalid persisted ChatGPT Web rate-limit state");
      }
      const loadedAt = this.now();
      const cutoff = loadedAt - RATE_LIMIT_STATE_TTL_MS;
      const validated = Object.entries(entries)
        .map(([namespace, value]) => {
          if (!/^[a-f0-9]{64}$/.test(namespace)) {
            throw new Error("Invalid persisted ChatGPT Web rate-limit namespace");
          }
          return [namespace, validateEntry(value, loadedAt)] as const;
        })
        .filter(([, entry]) => entry.updatedAt >= cutoff)
        .sort((left, right) => left[1].updatedAt - right[1].updatedAt)
        .slice(-MAX_RATE_LIMIT_NAMESPACES);
      for (const [namespace, entry] of validated) this.entries.set(namespace, entry);
    } catch {
      this.entries.clear();
      this.recoveredCorruptState = true;
      try {
        renameSync(
          this.path,
          `${this.path}.corrupt-${this.now()}-${process.pid}-${randomBytes(4).toString("hex")}`,
        );
      } catch {
        // Keep the original evidence when it cannot be archived. This process still refuses the
        // first send and never trusts any value parsed from the invalid file.
      }
      console.warn("[chatgpt-web] invalid rate-limit state was rejected; applying a safety cooldown");
    }
  }

  private prune(now: number): void {
    const cutoff = now - RATE_LIMIT_STATE_TTL_MS;
    for (const [namespace, entry] of this.entries) {
      if (entry.updatedAt < cutoff && entry.cooldownUntil <= now) this.entries.delete(namespace);
    }
    while (this.entries.size > MAX_RATE_LIMIT_NAMESPACES) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (!oldest) break;
      this.entries.delete(oldest);
    }
  }

  private persist(): void {
    if (!this.path) return;
    const payload: StoredRateLimitFile = {
      version: RATE_LIMIT_STATE_VERSION,
      entries: Object.fromEntries(this.entries),
    };
    atomicWriteFile(this.path, `${JSON.stringify(payload, null, 2)}\n`);
  }
}

export function sharedChatGptWebSendRateLimiter(
  path: string | undefined,
  namespace: string,
): ChatGptWebSendRateLimiter {
  const key = `${path ?? "<memory>"}\0${namespace}`;
  let limiter = sharedLimiters.get(key);
  if (!limiter) {
    limiter = new ChatGptWebSendRateLimiter(path, namespace);
    sharedLimiters.set(key, limiter);
  }
  return limiter;
}
