import type { JsonObject } from "../../src/contracts.js";
import type { CustodyFixture } from "./custody-fixture.js";
import type { OnboardingFixture } from "./onboarding-fixture.js";
export function cancellationInput(
  f: CustodyFixture,
  caseId: string,
  tenant = "synthetic-a",
): JsonObject {
  const p = f.actor("manager", tenant),
    c = f.get("cases", caseId, tenant),
    person = f.get("people", String(c.data.personId), tenant),
    episode = f.workspace
      .listEmploymentEpisodes(p, person.id)
      .find((e) => e.id === c.data.employmentEpisodeId)!;
  const o = f.workspace.onboarding(p, caseId),
    r = f.workspace.readiness(p, caseId);
  return {
    id: person.id,
    expectedVersion: person.version,
    employmentEpisodeId: episode.id,
    expectedEpisodeVersion: episode.version,
    onboardingCaseId: caseId,
    expectedCaseVersion: c.version,
    scopeRevision: r.scopeRevision,
    scopeHash: r.scopeHash,
    resourceHash: o.cancellation?.resourceHash ?? "0".repeat(64),
    reason: "Synthetic cancellation: this cooperation never started",
    humanDecision: true,
    workNeverStarted: true,
  };
}
export async function clearOnboardingResources(
  f: CustodyFixture,
  s: OnboardingFixture,
) {
  const allocations = f.workspace.assetCustody(
    f.actor("manager", s.tenant),
    s.assetId,
  ).allocations;
  for (const a of allocations.filter(
    (a) =>
      a.employmentEpisodeId === s.episodeId &&
      ["reserved", "issued"].includes(a.status),
  ))
    await s.complete(
      "ops.assets." + (a.status === "reserved" ? "release" : "return"),
      {
        id: s.assetId,
        expectedVersion: f.get("assets", s.assetId, s.tenant).version,
        allocationId: a.id,
        expectedAllocationVersion: a.version,
        ...(a.status === "reserved"
          ? { reason: "Synthetic reservation released" }
          : {
              returnedOn: "2026-09-08",
              location: "Synthetic return desk",
              condition: "good",
              receiptNote: "Synthetic physical return checked",
              humanConfirmed: true,
            }),
      },
    );
  for (const g of f.workspace
    .caseAccess(f.actor("manager", s.tenant), s.caseId)
    .grants.filter((g) => g.status === "active"))
    await s.complete("ops.cases.revokeAccess", {
      id: s.caseId,
      expectedVersion: s.getCase().version,
      grantId: g.id,
      expectedGrantVersion: g.version,
      revokedOn: "2026-09-08",
      note: "Synthetic absence of access checked",
      verificationMethod: "Synthetic local account check",
      humanConfirmed: true,
    });
  await s.complete("ops.licenses.revoke", {
    id: s.licenseId,
    expectedVersion: f.get("licenses", s.licenseId, s.tenant).version,
    personId: s.personId,
    employmentEpisodeId: s.episodeId,
    expectedEpisodeVersion: f.workspace
      .listEmploymentEpisodes(f.actor("manager", s.tenant), s.personId)
      .find((e) => e.id === s.episodeId)!.version,
    caseId: s.caseId,
    reason: "Synthetic place revoked after unstarted cooperation",
  });
}
