import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { JsonObject } from "../src/contracts.js";
import { custodyFixture } from "./helpers/custody-fixture.js";
import { jsonChild } from "./helpers/json-child.js";

test(
  "two native writers serialize reservation and issue versus release with one durable winner",
  { timeout: 15_000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "jarvis-asset-race-")),
      h = custodyFixture(directory),
      children: ReturnType<typeof jsonChild>[] = [];
    const race = async (
      commands: { toolId: string; input: JsonObject; actorId?: string }[],
    ) => {
      const pair = commands.map((command, index) => {
        const path = join(directory, `race-${index}.json`);
        writeFileSync(
          path,
          JSON.stringify({
            path: join(directory, "operations.sqlite"),
            principals: h.principals,
            profile: h.initiatives.profile(h.actor()),
            ...command,
            context: {
              actorId: command.actorId ?? "manager",
              approvedBy: "reviewer",
              tenantId: "synthetic-a",
              operationKey: randomUUID(),
              runId: randomUUID(),
              stepId: "synthetic-race",
            },
          }),
        );
        const child = jsonChild(
          fileURLToPath(
            new URL("../scripts/asset-race-child.ts", import.meta.url),
          ),
          [path],
        );
        children.push(child);
        return child;
      });
      await Promise.all(pair.map((c) => c.waitFor("ready")));
      pair.forEach((c) => c.send("go\n"));
      const results = await Promise.all(pair.map((c) => c.waitFor("finished")));
      for (const c of pair) assert.equal((await c.exited).code, 0);
      assert.equal(results.filter((r) => r.ok === true).length, 1);
      assert.equal(results.filter((r) => r.ok === false).length, 1);
      assert.equal(results.find((r) => r.ok)?.verified, true);
      assert.equal(results.find((r) => !r.ok)?.code, "VERSION_CONFLICT");
    };
    try {
      const seed = await h.seed(),
        asset = h.get("assets", seed.assetId),
        allocation = (asset.data.allocations as JsonObject[])[0]!;
      await h.complete("ops.assets.release", {
        id: asset.id,
        expectedVersion: asset.version,
        allocationId: allocation.id!,
        expectedAllocationVersion: allocation.version!,
        reason: "Synthetic setup for native race",
      });
      const available = h.get("assets", asset.id),
        episode = h.workspace.listEmploymentEpisodes(
          h.actor(),
          seed.personId,
        )[0]!,
        profile = h.initiatives.profile(h.actor());
      const reserve = {
        id: asset.id,
        expectedVersion: available.version,
        personId: seed.personId,
        caseId: seed.caseId,
        employmentEpisodeId: episode.id,
        expectedEpisodeVersion: episode.version,
        profileVersion: profile.version,
        until: "2026-09-12",
      };
      await race(
        ["first", "second"].map((purpose) => ({
          toolId: "ops.assets.reserve",
          input: { ...reserve, purpose: `Synthetic ${purpose} demand` },
        })),
      );
      const reserved = h.get("assets", asset.id),
        active = (reserved.data.allocations as JsonObject[]).filter(
          (a) => a.status === "reserved",
        );
      assert.equal(active.length, 1);
      const issue = h.workspace.taskEquipment(h.actor("it-one"), seed.taskId)
        .allocations[0]!.commandBindings.issueForTask!;
      await race([
        {
          toolId: "ops.assets.issueForTask",
          actorId: "it-one",
          input: {
            ...issue,
            issuedOn: "2026-09-08",
            location: "Synthetic desk",
            condition: "good",
            handoverNote: "Synthetic native race",
            humanConfirmed: true,
          },
        },
        {
          toolId: "ops.assets.release",
          input: {
            id: asset.id,
            expectedVersion: reserved.version,
            allocationId: active[0]!.id!,
            expectedAllocationVersion: active[0]!.version!,
            reason: "Synthetic simultaneous release",
          },
        },
      ]);
      const custody = h.workspace.assetCustody(h.actor(), asset.id);
      assert.equal(custody.totalEvents, 4);
      assert.ok(
        ["issued", "available"].includes(h.get("assets", asset.id).status),
      );
    } finally {
      await Promise.all(children.map((c) => c.kill()));
      h.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
