import type {
  AntigravitySettings,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { collectUint8StreamText } from "@t3tools/provider-core/server/collectStreamText";
import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";

const ANTIGRAVITY_USAGE_CACHE_TTL_MS = 5 * 60_000;
const CLI_USAGE_TIMEOUT = "15 seconds";
const MAX_STDOUT_BYTES = 512 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;

const SUMMARY_WINDOW_MINS = new Map<string, number>([
  ["5h", 5 * 60],
  ["weekly", 7 * 24 * 60],
]);

const STRIPPED_ENV_KEYS = new Set([
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GEMINI_HOME",
  "AGY_ACP_FORCE_FILE_STORAGE",
  "AGY_CLI_DISABLE_AUTO_UPDATE",
  "ELECTRON_RUN_AS_NODE",
  "CHROME_CRASHPAD_PIPE_NAME",
]);

const CliUsageBucket = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  window: Schema.optional(Schema.String),
  remaining_fraction: Schema.optional(Schema.Number),
  reset_time: Schema.optional(Schema.String),
});

const CliUsageGroup = Schema.Struct({
  name: Schema.optional(Schema.String),
  buckets: Schema.optional(Schema.Array(CliUsageBucket)),
});

const CliUsageOutput = Schema.Struct({
  status: Schema.String,
  response: Schema.optional(Schema.String),
  command: Schema.optional(
    Schema.Struct({
      name: Schema.optional(Schema.String),
      data: Schema.optional(
        Schema.Struct({
          groups: Schema.optional(Schema.Array(CliUsageGroup)),
        }),
      ),
    }),
  ),
});

const decodeCliUsageOutput = Schema.decodeUnknownOption(CliUsageOutput);

function parseJsonObjectFromStdout(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    // Fallback if agy prints non-JSON warnings before/after the final JSON payload.
    const lastBrace = trimmed.lastIndexOf("}");
    if (lastBrace === -1) return undefined;
    let cursor = trimmed.lastIndexOf("{", lastBrace);
    while (cursor !== -1) {
      try {
        return JSON.parse(trimmed.slice(cursor, lastBrace + 1));
      } catch {
        cursor = trimmed.lastIndexOf("{", cursor - 1);
      }
    }
    return undefined;
  }
}

function normalizeResetTime(
  resetTime: string | undefined,
  remainingFraction: number,
  description: string | undefined,
): string | undefined {
  if (!resetTime) return undefined;
  const parsedMs = Date.parse(resetTime);
  // Untouched 100% buckets report epoch 0 (1970-01-01T00:00:00Z); omit so UI shows no countdown.
  if (!Number.isFinite(parsedMs) || parsedMs <= 0) return undefined;
  if (remainingFraction >= 1 && !description?.trim()) return undefined;
  const dt = DateTime.make(resetTime);
  return Option.isSome(dt) ? DateTime.formatIso(dt.value) : undefined;
}

function bucketFamilyLabel(bucketId: string, groupName: string | undefined): string {
  if (bucketId.startsWith("gemini-argon-")) return groupName?.trim() || "Gemini Argon";
  if (bucketId.startsWith("gemini-carbon-")) return groupName?.trim() || "Gemini Carbon";
  if (bucketId.startsWith("gemini-")) return "Gemini";
  if (bucketId.startsWith("3p-")) return "Claude & GPT (shared)";
  return groupName?.trim() || bucketId;
}

export function parseAntigravityCliUsageOutput(
  stdout: string,
  checkedAt: string,
): ServerProviderUsageLimits {
  const raw = parseJsonObjectFromStdout(stdout);
  const decoded = decodeCliUsageOutput(raw);
  if (Option.isNone(decoded)) {
    return makeUnavailableUsageLimits({
      checkedAt,
      reason: "probeFailed",
      message: "Could not parse Antigravity CLI usage output.",
    });
  }
  const payload = decoded.value;
  if (payload.status !== "SUCCESS") {
    return makeUnavailableUsageLimits({
      checkedAt,
      reason: "probeFailed",
      message:
        payload.response?.trim() ||
        "Antigravity CLI did not return usage limits. Check Google sign-in.",
    });
  }
  const windows = new Map<string, ServerProviderUsageWindow>();
  for (const group of payload.command?.data?.groups ?? []) {
    for (const bucket of group.buckets ?? []) {
      if (bucket.remaining_fraction === undefined || !Number.isFinite(bucket.remaining_fraction)) {
        continue;
      }
      const family = bucketFamilyLabel(bucket.id, group.name);
      const weekly = bucket.window === "weekly";
      const session = bucket.window === "5h";
      const windowDurationMins = SUMMARY_WINDOW_MINS.get(bucket.window ?? "");
      const resetsAt = normalizeResetTime(
        bucket.reset_time,
        bucket.remaining_fraction,
        bucket.description,
      );
      windows.set(bucket.id, {
        id: bucket.id,
        label: `${family} · ${weekly ? "Weekly" : session ? "5-hour" : bucket.name?.trim() || "Quota"}`,
        kind: weekly ? "weekly" : session ? "session" : "other",
        usedPercent: clampPercent((1 - Math.max(0, Math.min(1, bucket.remaining_fraction))) * 100),
        ...(resetsAt ? { resetsAt } : {}),
        ...(windowDurationMins === undefined ? {} : { windowDurationMins }),
      });
    }
  }
  if (windows.size === 0) {
    return makeUnavailableUsageLimits({
      checkedAt,
      reason: "probeFailed",
      message: "Antigravity did not return usable quota information.",
    });
  }
  return makeUsageLimits({ checkedAt, windows: windows.values() });
}

function buildCliUsageEnvironment(
  baseEnv: NodeJS.ProcessEnv,
  profileDirectory: string,
  authMethod: AntigravitySettings["authMethod"],
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (!STRIPPED_ENV_KEYS.has(key.toUpperCase())) env[key] = value;
  }
  return {
    ...env,
    ...(authMethod === "oauth-personal"
      ? { SSH_CONNECTION: baseEnv.SSH_CONNECTION || "127.0.0.1 0 127.0.0.1 0" }
      : {}),
    GEMINI_HOME: profileDirectory,
    AGY_ACP_FORCE_FILE_STORAGE: "1",
    AGY_CLI_DISABLE_AUTO_UPDATE: "true",
  };
}

export const makeAntigravityUsageProbe = Effect.fn("makeAntigravityUsageProbe")(function* (input: {
  readonly resolveExecutable: Effect.Effect<{ readonly executablePath: string }, Error>;
  readonly profileDirectory: string;
  readonly authMethod: AntigravitySettings["authMethod"];
  readonly baseEnv?: NodeJS.ProcessEnv;
  readonly cacheTtlMs?: number;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const cacheTtlMs = input.cacheTtlMs ?? ANTIGRAVITY_USAGE_CACHE_TTL_MS;
  const baseEnv = input.baseEnv ?? process.env;

  let generation = 0;
  let cached:
    | {
        readonly limits: ServerProviderUsageLimits;
        readonly cachedAtMs: number;
        readonly generation: number;
      }
    | undefined;
  let inFlight:
    | {
        readonly deferred: Deferred.Deferred<ServerProviderUsageLimits>;
        readonly generation: number;
      }
    | undefined;

  const readCliOnce = Effect.fn("AntigravityUsageProbe.readCliOnce")(
    function* () {
      const checkedAt = DateTime.formatIso(yield* DateTime.now);
      if (input.authMethod !== "oauth-personal" && input.authMethod !== "oauth-business") {
        return makeUnavailableUsageLimits({
          checkedAt,
          reason: "unsupported",
          message: "Antigravity limits are only available for Google account sign-ins.",
        });
      }
      const executable = yield* input.resolveExecutable;
      const env = buildCliUsageEnvironment(baseEnv, input.profileDirectory, input.authMethod);
      const { stdout, exitCode } = yield* Effect.scoped(
        Effect.gen(function* () {
          const child = yield* spawner.spawn(
            ChildProcess.make(
              executable.executablePath,
              ["-p", "/usage", "--output-format", "json"],
              {
                env,
                extendEnv: false,
                shell: false,
                stdin: "ignore",
              },
            ),
          );
          const [out, _err, code] = yield* Effect.all(
            [
              collectUint8StreamText({ stream: child.stdout, maxBytes: MAX_STDOUT_BYTES }),
              collectUint8StreamText({ stream: child.stderr, maxBytes: MAX_STDERR_BYTES }),
              child.exitCode,
            ],
            { concurrency: "unbounded" },
          );
          return { stdout: out.text, exitCode: Number(code) };
        }),
      );
      if (exitCode !== 0 && !stdout.trim()) {
        return makeUnavailableUsageLimits({
          checkedAt,
          reason: "probeFailed",
          message: "Antigravity CLI exited with an error while reading usage limits.",
        });
      }
      return parseAntigravityCliUsageOutput(stdout, checkedAt);
    },
    Effect.timeout(CLI_USAGE_TIMEOUT),
    Effect.catch(() =>
      Effect.gen(function* () {
        return makeUnavailableUsageLimits({
          checkedAt: DateTime.formatIso(yield* DateTime.now),
          reason: "probeFailed",
          message: "Could not read Antigravity limits via agy CLI. Refresh to retry.",
        });
      }),
    ),
  );

  const probe = Effect.fn("AntigravityUsageProbe.probe")(function* (options?: {
    readonly force?: boolean;
  }) {
    const force = options?.force === true;
    const now = yield* Clock.currentTimeMillis;
    if (
      !force &&
      cached !== undefined &&
      cached.generation === generation &&
      !cached.limits.unavailable &&
      now - cached.cachedAtMs < cacheTtlMs
    ) {
      return cached.limits;
    }
    if (!force && inFlight !== undefined && inFlight.generation === generation) {
      return yield* Deferred.await(inFlight.deferred);
    }
    const runGeneration = generation;
    const deferred = yield* Deferred.make<ServerProviderUsageLimits>();
    const current = { deferred, generation: runGeneration };
    inFlight = current;
    return yield* readCliOnce().pipe(
      Effect.tap((limits) =>
        Effect.gen(function* () {
          const completedAt = yield* Clock.currentTimeMillis;
          if (generation === runGeneration && !limits.unavailable) {
            cached = { limits, cachedAtMs: completedAt, generation: runGeneration };
          }
          yield* Deferred.succeed(deferred, limits);
        }),
      ),
      Effect.onInterrupt(() =>
        Effect.gen(function* () {
          const fallback = makeUnavailableUsageLimits({
            checkedAt: DateTime.formatIso(yield* DateTime.now),
            reason: "probeFailed",
            message: "Antigravity usage limit check was interrupted.",
          });
          yield* Deferred.succeed(deferred, fallback).pipe(Effect.ignore);
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          if (inFlight === current) inFlight = undefined;
        }),
      ),
    );
  });

  return {
    probe,
    clear: Effect.sync(() => {
      cached = undefined;
      inFlight = undefined;
      generation++;
    }),
  };
});
