import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import {
  makeAntigravityUsageProbe,
  parseAntigravityCliUsageOutput,
} from "./antigravityUsageLimits.ts";

const CHECKED_AT = "2026-11-26T03:00:00.000Z";

const SAMPLE_CLI_OUTPUT = JSON.stringify({
  conversation_id: "",
  status: "SUCCESS",
  response: "Gemini Models\tWeekly Limit Remaining\t80%",
  duration_seconds: 0,
  num_turns: 0,
  command: {
    name: "usage",
    data: {
      groups: [
        {
          name: "Gemini Models",
          buckets: [
            {
              id: "gemini-weekly",
              name: "Weekly Limit Remaining",
              description: "You have used some of your weekly limit.",
              window: "weekly",
              remaining_fraction: 0.8,
              reset_time: "2026-11-30T23:46:45Z",
            },
            {
              id: "gemini-5h",
              name: "Five Hour Limit Remaining",
              description: "You have used some of your 5-hour limit.",
              window: "5h",
              remaining_fraction: 0.95,
              reset_time: "2026-11-26T05:39:50Z",
            },
          ],
        },
        {
          name: "Claude and GPT models",
          buckets: [
            {
              id: "3p-weekly",
              name: "Weekly Limit Remaining",
              window: "weekly",
              remaining_fraction: 1,
              reset_time: "1970-01-01T00:00:00Z",
            },
            {
              id: "3p-5h",
              name: "Five Hour Limit Remaining",
              window: "5h",
              remaining_fraction: 1,
              reset_time: "1970-01-01T00:00:00Z",
            },
          ],
        },
      ],
    },
  },
});

describe("parseAntigravityCliUsageOutput", () => {
  it("maps Gemini and 3p buckets and omits epoch-0 reset_time for untouched buckets", () => {
    const limits = parseAntigravityCliUsageOutput(SAMPLE_CLI_OUTPUT, CHECKED_AT);
    expect(limits.unavailable).toBeUndefined();
    expect(limits.checkedAt).toBe(CHECKED_AT);
    expect(limits.windows).toEqual([
      {
        id: "3p-5h",
        label: "Claude & GPT (shared) · 5-hour",
        kind: "session",
        usedPercent: 0,
        windowDurationMins: 300,
      },
      {
        id: "gemini-5h",
        label: "Gemini · 5-hour",
        kind: "session",
        usedPercent: expect.closeTo(5, 5),
        resetsAt: "2026-11-26T05:39:50.000Z",
        windowDurationMins: 300,
      },
      {
        id: "3p-weekly",
        label: "Claude & GPT (shared) · Weekly",
        kind: "weekly",
        usedPercent: 0,
        windowDurationMins: 10080,
      },
      {
        id: "gemini-weekly",
        label: "Gemini · Weekly",
        kind: "weekly",
        usedPercent: expect.closeTo(20, 5),
        resetsAt: "2026-11-30T23:46:45.000Z",
        windowDurationMins: 10080,
      },
    ]);
  });

  it("extracts trailing JSON when stdout contains leading warning lines", () => {
    const noisy = `WARNING: some notice\n${SAMPLE_CLI_OUTPUT}\n`;
    const limits = parseAntigravityCliUsageOutput(noisy, CHECKED_AT);
    expect(limits.unavailable).toBeUndefined();
    expect(limits.windows).toHaveLength(4);
  });

  it("returns probeFailed when CLI reports non-SUCCESS status", () => {
    const limits = parseAntigravityCliUsageOutput(
      JSON.stringify({ status: "ERROR", response: "Not signed in." }),
      CHECKED_AT,
    );
    expect(limits.unavailable).toEqual({
      reason: "probeFailed",
      message: "Not signed in.",
    });
  });

  it("returns probeFailed for invalid JSON", () => {
    const limits = parseAntigravityCliUsageOutput("not json at all", CHECKED_AT);
    expect(limits.unavailable?.reason).toBe("probeFailed");
  });
});

describe("makeAntigravityUsageProbe", () => {
  it.effect("caches successful CLI results within TTL and re-runs on force or clear", () =>
    Effect.gen(function* () {
      let spawnCount = 0;
      const spawner = ChildProcessSpawner.make(() =>
        Effect.sync(() => {
          spawnCount++;
          return ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1000 + spawnCount),
            stdin: {} as ChildProcessSpawner.ChildProcessHandle["stdin"],
            stdout: Stream.succeed(new TextEncoder().encode(SAMPLE_CLI_OUTPUT)),
            stderr: Stream.empty,
            all: Stream.empty,
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            getInputFd: () => ({}) as ChildProcessSpawner.ChildProcessHandle["stdin"],
            getOutputFd: () => Stream.empty,
          });
        }),
      );

      const probe = yield* makeAntigravityUsageProbe({
        resolveExecutable: Effect.succeed({ executablePath: "/usr/local/bin/agy" }),
        profileDirectory: "/tmp/t3-agy-profile",
        authMethod: "oauth-personal",
        baseEnv: {},
        cacheTtlMs: 300_000,
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

      const first = yield* probe.probe();
      const second = yield* probe.probe();
      expect(first.windows).toHaveLength(4);
      expect(second).toEqual(first);
      expect(spawnCount).toBe(1);

      yield* probe.probe({ force: true });
      expect(spawnCount).toBe(2);

      yield* probe.clear;
      yield* probe.probe();
      expect(spawnCount).toBe(3);
    }),
  );

  it.effect("returns unsupported for api-key auth without spawning agy", () =>
    Effect.gen(function* () {
      let spawnCount = 0;
      const spawner = ChildProcessSpawner.make(() =>
        Effect.sync(() => {
          spawnCount++;
          throw new Error("should not spawn");
        }),
      );

      const probe = yield* makeAntigravityUsageProbe({
        resolveExecutable: Effect.succeed({ executablePath: "/usr/local/bin/agy" }),
        profileDirectory: "/tmp/t3-agy-profile",
        authMethod: "gemini-api-key",
        baseEnv: {},
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

      const limits = yield* probe.probe();
      expect(limits.unavailable?.reason).toBe("unsupported");
      expect(spawnCount).toBe(0);
    }),
  );
});
