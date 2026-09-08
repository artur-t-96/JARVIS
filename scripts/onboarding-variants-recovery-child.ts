import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import {
  custodyFixture,
  custodyNow,
} from "../tests/helpers/custody-fixture.js";
import {
  configureVariants,
  profileInput,
  variants,
} from "../tests/helpers/onboarding-variants-fixture.js";
import type { JsonObject } from "../src/contracts.js";

const [mode, directory, operation, runId] = process.argv.slice(2);
if (
  !directory ||
  !["seed", "apply", "resume"].includes(mode ?? "") ||
  !["configure", "start"].includes(operation ?? "")
)
  throw Error("Synthetic profile recovery arguments required");
const toolId =
  operation === "configure"
    ? "initiatives.configure"
    : "ops.people.startEmployment";
const calls = new DatabaseSync(join(directory, "calls.sqlite"));
calls.exec(
  "PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS calls(id INTEGER PRIMARY KEY)",
);
const emit = (event: object) =>
  process.stdout.write(`${JSON.stringify(event)}\n`);
let hold: ReturnType<typeof setInterval> | undefined;
const f = custodyFixture(directory, {
  clock: () =>
    custodyNow + (mode === "apply" ? 1000 : mode === "resume" ? 2000 : 0),
  wrap: (tool) =>
    tool.id !== toolId
      ? tool
      : {
          ...tool,
          async execute(...args) {
            calls.prepare("INSERT INTO calls DEFAULT VALUES").run();
            const result = await tool.execute(...args);
            if (mode === "apply") {
              hold = setInterval(() => {}, 1000);
              emit({ type: "effect_applied" });
              await new Promise<void>(() => {});
            }
            return result;
          },
        },
});
try {
  if (mode === "seed") {
    let input: JsonObject;
    if (operation === "configure")
      input = profileInput(f, "synthetic-a", {
        onboardingVariants: variants() as unknown as JsonObject,
      });
    else {
      await configureVariants(f);
      const person = await f.complete("ops.people.create", {
        title: "Synthetic crash start",
        data: { personCategory: "internal" },
      });
      input = {
        id: person.steps[0]!.output!.data.entityId!,
        expectedVersion: 1,
        employmentKind: "internal",
        startDate: "2026-09-08",
        role: "Synthetic role",
        humanDecision: true,
      };
    }
    const run = await f.stage(toolId, input);
    hold = setInterval(() => {}, 1000);
    emit({ type: "waiting", runId: run.id });
    await new Promise<void>(() => {});
  }
  if (!runId) throw Error("Run required");
  if (mode === "apply") {
    f.approve(f.engine.getRun(f.actor(), runId));
    await f.engine.tick();
    throw Error("Expected SIGKILL");
  }
  for (let i = 0; i < 6; i++) await f.engine.tick();
  const run = f.engine.getRun(f.actor(), runId),
    profile = f.initiatives.profile(f.actor());
  const db = new DatabaseSync(join(directory, "operations.sqlite"), {
    readOnly: true,
  });
  try {
    const count = (table: string) =>
      Number(db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n);
    emit({
      type: "finished",
      status: run.status,
      verified: run.steps[0]!.verification?.ok,
      attempts: run.steps[0]!.attempts,
      executeCalls: calls.prepare("SELECT count(*) n FROM calls").get()!.n,
      profileVersion: profile.version,
      definitionVersion: profile.definitionVersion,
      variants: Object.keys(profile.onboardingVariants ?? {}).sort(),
      episodes: count("ops_employment"),
      tasks: count("ops_tasks"),
      requirements: count("ops_case_requirements"),
      otherTenantVersion: f.initiatives.profile(
        f.actor("manager", "synthetic-b"),
      ).version,
    });
  } finally {
    db.close();
  }
} finally {
  if (hold) clearInterval(hold);
  f.close();
  calls.close();
}
