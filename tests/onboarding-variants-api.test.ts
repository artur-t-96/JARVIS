import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createApp } from "../src/app.js";
import type {
  JsonObject,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from "../src/contracts.js";
import { custodyFixture } from "./helpers/custody-fixture.js";
import {
  configureVariants,
  profileInput,
  startVariant,
  variants,
} from "./helpers/onboarding-variants-fixture.js";

test("variant catalog is private, bundle pinning checks tenant and version, and company permission alone cannot bind IT data", async () => {
  const directory = mkdtempSync(join(tmpdir(), "jarvis-profile-variants-api-")),
    f = custodyFixture(directory);
  const app = createApp({
    ...f,
    planner: {
      kind: "test",
      async plan() {
        throw Error("No model");
      },
    },
  });
  const headers = (id = "manager", tenant = "synthetic-a") => ({
    authorization: `Bearer synthetic-custody-${tenant}-${id}-aaaaaaaaaaaaaaaa`,
    origin: "http://127.0.0.1:4330",
  });
  try {
    assert.equal(
      (await app.inject({ url: "/api/company/templates" })).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          url: "/api/company/templates",
          headers: headers("it-one"),
        })
      ).statusCode,
      403,
    );
    const catalog = (
      await app.inject({ url: "/api/company/templates", headers: headers() })
    ).json().templates;
    assert.equal(catalog.length, 2);
    assert.equal(catalog[1].onboardingVariant.tasks[0].offsetDays, -3);
    const create = async (data: JsonObject) =>
      String(
        (
          await f.complete("ops.it.create", {
            title: "Synthetic access definition",
            data,
          })
        ).steps[0]!.output!.data.entityId,
      );
    const applicationId = await create({
      kind: "application",
      applicationKey: "synthetic-app",
      description: "Synthetic",
      supportedRoles: ["member"],
    });
    const bundleId = await create({
      kind: "access_bundle",
      accessKey: "variant-access",
      description: "Synthetic",
      members: [
        {
          key: "app",
          applicationId,
          applicationVersion: 1,
          role: "member",
          validityDays: 7,
        },
      ],
    });
    const v = variants();
    for (const variant of Object.values(v)) {
      const r = variant.requirements.find((r) => r.kind === "access_attested")!;
      if (r.kind === "access_attested")
        r.expected = {
          accessKey: "variant-access",
          bundleId,
          bundleVersion: 1,
        };
    }
    f.actor("it-two").scopes = ["company"];
    const denied = await app.inject({
      method: "POST",
      url: "/api/commands",
      headers: headers("it-two"),
      payload: {
        toolId: "initiatives.configure",
        input: profileInput(f, "synthetic-a", {
          onboardingVariants: v as unknown as JsonObject,
        }),
        idempotencyKey: randomUUID(),
      },
    });
    assert.equal(denied.statusCode, 403, denied.body);
    await configureVariants(f, v);
    const a = await startVariant(f, "internal");
    assert.equal(
      f.workspace
        .readiness(f.actor(), a.caseId)
        .definitions.find((r) => r.kind === "access_attested")!.expected
        .bundleId,
      bundleId,
    );
    const wrongTenant = await f.stage(
      "initiatives.configure",
      profileInput(f, "synthetic-b", {
        onboardingVariants: v as unknown as JsonObject,
      }),
      "manager",
      "synthetic-b",
    );
    f.approve(wrongTenant, "synthetic-b");
    await f.engine.tick();
    assert.equal(
      f.initiatives.profile(f.actor("manager", "synthetic-b")).version,
      0,
    );
    assert.match(
      f.engine.getRun(f.actor("manager", "synthetic-b"), wrongTenant.id)
        .steps[0]!.error!,
      /źródła w tej organizacji/,
    );
    const wrongVersion = structuredClone(v);
    for (const variant of Object.values(wrongVersion))
      for (const r of variant.requirements)
        if (r.kind === "access_attested") r.expected.bundleVersion = 2;
    const stale = await f.stage(
      "initiatives.configure",
      profileInput(f, "synthetic-a", {
        onboardingVariants: wrongVersion as unknown as JsonObject,
      }),
    );
    f.approve(stale);
    await f.engine.tick();
    assert.match(
      f.engine.getRun(f.actor(), stale.id).steps[0]!.error!,
      /zmienił wersję/,
    );
    assert.equal(f.initiatives.profile(f.actor()).version, 1);
  } finally {
    await app.close();
    f.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a committed start is reconciled from its durable receipt after a newer company profile, without another case or task", async () => {
  const directory = mkdtempSync(
    join(tmpdir(), "jarvis-profile-start-receipt-"),
  );
  let captured:
    | {
        tool: ToolDefinition;
        ctx: ToolContext;
        input: JsonObject;
        result: ToolResult;
      }
    | undefined;
  const f = custodyFixture(directory, {
    wrap: (tool) =>
      tool.id !== "ops.people.startEmployment"
        ? tool
        : {
            ...tool,
            async execute(ctx, input) {
              const result = await tool.execute(ctx, input);
              captured = { tool, ctx, input, result };
              return result;
            },
          },
  });
  try {
    await configureVariants(f);
    const a = await startVariant(f, "internal");
    const before = f.get("cases", a.caseId),
      person = f.get("people", a.personId);
    await configureVariants(f);
    assert.ok(captured);
    assert.deepEqual(
      await captured.tool.reconcile!(captured.ctx, captured.input),
      { status: "applied", result: captured.result },
    );
    assert.deepEqual(
      await captured.tool.execute(captured.ctx, captured.input),
      captured.result,
    );
    assert.equal(
      (
        await captured.tool.verify(
          captured.ctx,
          captured.input,
          captured.result,
        )
      ).ok,
      true,
    );
    assert.deepEqual(f.get("cases", a.caseId), before);
    assert.deepEqual(f.get("people", a.personId), person);
    assert.equal(
      f.workspace.listEmploymentEpisodes(f.actor(), a.personId).length,
      1,
    );
  } finally {
    f.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
