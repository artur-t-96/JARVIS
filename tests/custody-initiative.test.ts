import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { JsonObject } from "../src/contracts.js";
import { custodyFixture, custodyNow } from "./helpers/custody-fixture.js";

test("reservation initiative uses persisted expiry across timezone change, restart and repeated scans without freeing equipment", async () => {
  const directory = mkdtempSync(join(tmpdir(), "jarvis-custody-expiry-"));
  let now = custodyNow,
    h = custodyFixture(directory, { domainClock: () => now });
  try {
    const seed = await h.seed(),
      p = h.initiatives.profile(h.actor());
    const allocation = (
      h.get("assets", seed.assetId).data.allocations as JsonObject[]
    )[0]!;
    assert.equal(allocation.expiresAt, "2026-09-12T22:00:00.000Z");
    await h.complete("initiatives.configure", {
      companyName: p.companyName,
      timezone: "Pacific/Honolulu",
      licenseReminderDays: p.licenseReminderDays,
      quietHours: p.quietHours,
      rules: p.rules,
      roleBindings: p.roleBindings,
      processTemplates: p.processTemplates,
      employmentPolicy: p.employmentPolicy,
      expectedVersion: p.version,
    } as unknown as JsonObject);
    now = Date.parse(String(allocation.expiresAt)) - 1;
    h.initiatives.scan(h.actor());
    assert.equal(
      h.initiatives
        .list(h.actor())
        .filter((i) => i.rule === "expired_reservation").length,
      0,
    );
    now++;
    h.initiatives.scan(h.actor());
    const expired = h.initiatives
      .list(h.actor())
      .filter((i) => i.rule === "expired_reservation");
    assert.equal(expired.length, 1);
    assert.equal(expired[0]!.sourceItemId, allocation.id);
    assert.equal(h.get("assets", seed.assetId).status, "reserved");
    h.close();
    h = custodyFixture(directory, { domainClock: () => now });
    now += 60_000;
    h.initiatives.scan(h.actor());
    const repeated = h.initiatives
      .list(h.actor())
      .filter((i) => i.rule === "expired_reservation");
    assert.equal(repeated.length, 1);
    assert.equal(repeated[0]!.id, expired[0]!.id);
    assert.equal(repeated[0]!.version, expired[0]!.version);
    assert.equal(h.get("assets", seed.assetId).status, "reserved");
    assert.equal(
      (h.get("assets", seed.assetId).data.allocations as JsonObject[])[0]!
        .expiresAt,
      allocation.expiresAt,
    );
  } finally {
    h.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
