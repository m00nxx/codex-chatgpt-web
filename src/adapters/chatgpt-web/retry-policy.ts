import { ChatGptWebAdapterError } from "./adapter-error";

/** Safe default: a failed ChatGPT browser send never causes an automatic second message. */
export const DEFAULT_CHATGPT_WEB_TURN_RETRIES = 0;
/** Backward-compatible exported budget name; now reflects the safe default. */
export const MAX_CHATGPT_WEB_TURN_RETRIES = DEFAULT_CHATGPT_WEB_TURN_RETRIES;
/** Configuration guardrail; this is not a recommendation to retry browser sends. */
export const MAX_CONFIGURED_CHATGPT_WEB_TURN_RETRIES = 10;
const RETRY_BUDGET_TTL_MS = 30 * 60_000;

interface RetryBudgetEntry {
  retries: number;
  updatedAt: number;
  nextAttemptAt: number;
  lastError: {
    message: string;
    status: number;
    errorType: string;
    code: string;
  };
}

function exhaustedError(entry: RetryBudgetEntry, allowedRetries: number): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    `${entry.lastError.message} Automatic browser-turn retry budget is ${allowedRetries}; refusing to send another message.`,
    {
      status: entry.lastError.status,
      errorType: entry.lastError.errorType,
      code: entry.lastError.code,
      retryable: false,
    },
  );
}

/**
 * Tracks only retryable ChatGPT browser failures across adapter instances. The HTTP bridge creates
 * one adapter per request, so this process-local budget must live outside createChatGptWebAdapter.
 */
export class ChatGptWebTurnRetryPolicy {
  private readonly entries = new Map<string, RetryBudgetEntry>();

  constructor(private readonly ttlMs = RETRY_BUDGET_TTL_MS) {}

  recordRetryableFailure(
    key: string,
    error: ChatGptWebAdapterError,
    allowedRetries = DEFAULT_CHATGPT_WEB_TURN_RETRIES,
    backoffBaseMs = 2_000,
    now = Date.now(),
  ): ChatGptWebAdapterError {
    this.assertAllowedRetries(allowedRetries);
    if (!Number.isInteger(backoffBaseMs) || backoffBaseMs < 0 || backoffBaseMs > 60_000) {
      throw new Error("ChatGPT browser retry backoff must be an integer from 0 to 60000 milliseconds");
    }
    this.prune(now);
    const previous = this.entries.get(key);
    const entry: RetryBudgetEntry = {
      retries: (previous?.retries ?? 0) + 1,
      updatedAt: now,
      nextAttemptAt: now + Math.min(60_000, backoffBaseMs * 2 ** (previous?.retries ?? 0)),
      lastError: {
        message: error.message,
        status: error.status,
        errorType: error.errorType,
        code: error.code,
      },
    };
    this.entries.set(key, entry);
    return entry.retries > allowedRetries ? exhaustedError(entry, allowedRetries) : error;
  }

  retryDelayMs(
    key: string,
    allowedRetries = DEFAULT_CHATGPT_WEB_TURN_RETRIES,
    now = Date.now(),
  ): number {
    this.assertAllowedRetries(allowedRetries);
    this.prune(now);
    const entry = this.entries.get(key);
    if (!entry || entry.retries > allowedRetries) return 0;
    return Math.max(0, entry.nextAttemptAt - now);
  }

  exhaustedError(
    key: string,
    allowedRetries = DEFAULT_CHATGPT_WEB_TURN_RETRIES,
    now = Date.now(),
  ): ChatGptWebAdapterError | undefined {
    this.assertAllowedRetries(allowedRetries);
    this.prune(now);
    const entry = this.entries.get(key);
    return entry && entry.retries > allowedRetries ? exhaustedError(entry, allowedRetries) : undefined;
  }

  clear(key: string): void {
    this.entries.delete(key);
  }

  private prune(now: number): void {
    for (const [key, entry] of this.entries) {
      if (now - entry.updatedAt >= this.ttlMs) this.entries.delete(key);
    }
  }

  private assertAllowedRetries(value: number): void {
    if (!Number.isInteger(value) || value < 0 || value > MAX_CONFIGURED_CHATGPT_WEB_TURN_RETRIES) {
      throw new Error(
        `ChatGPT browser turn retries must be an integer from 0 to ${MAX_CONFIGURED_CHATGPT_WEB_TURN_RETRIES}`,
      );
    }
  }
}

export const chatGptWebTurnRetryPolicy = new ChatGptWebTurnRetryPolicy();
