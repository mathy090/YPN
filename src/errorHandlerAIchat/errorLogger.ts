// src/errorHandlerAIchat/errorLogger.ts
// Centralised error logger for AI chat failures.
// Keeps the last 50 entries in memory (no disk write — lightweight).

type LogLevel = "warn" | "error";

type LogEntry = {
  ts: number;
  level: LogLevel;
  context: string;
  messageId?: string;
  error: string;
};

const MAX_ENTRIES = 50;
const _log: LogEntry[] = [];

export function logChatError(
  context: string,
  error: unknown,
  opts: { messageId?: string; level?: LogLevel } = {},
): void {
  const entry: LogEntry = {
    ts: Date.now(),
    level: opts.level ?? "error",
    context,
    messageId: opts.messageId,
    error:
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error),
  };

  _log.push(entry);
  if (_log.length > MAX_ENTRIES) _log.shift();

  const tag = `[TeamYPN:${context}]`;
  if (entry.level === "warn") {
    console.warn(tag, entry.error, opts.messageId ?? "");
  } else {
    console.error(tag, entry.error, opts.messageId ?? "");
  }
}

export function getRecentErrors(): Readonly<LogEntry[]> {
  return [..._log];
}

export function clearErrorLog(): void {
  _log.length = 0;
}
