import assert from "node:assert/strict";
import type { JsonObject, Principal } from "../../src/contracts.js";
import type { WorkspaceStore } from "../../src/workspace.js";

/** Only synthetic fixtures with explicit/unique relationships may fill these
 * defaults. Production always chooses these identities before planning. */
export function custodyPins(
  store: WorkspaceStore,
  actor: Principal,
  action: string,
  input: JsonObject,
): JsonObject {
  if (
    !["reserve", "issue", "return", "release", "expireReservation"].includes(
      action,
    )
  )
    return input;
  let result = { ...input };
  if (["reserve", "issue"].includes(action) && result.caseId === undefined) {
    const episodes = store
      .listEmploymentEpisodes(actor, String(result.personId))
      .filter((e) =>
        result.employmentEpisodeId
          ? e.id === result.employmentEpisodeId
          : e.status !== "ended",
      );
    assert.equal(
      episodes.length,
      1,
      "fixture must explicitly select one period before its case",
    );
    assert.ok(episodes[0]!.onboardingCaseId);
    result = { caseId: episodes[0]!.onboardingCaseId!, ...result };
  }
  if (action !== "reserve") {
    const asset = store.get(actor, "assets", String(result.id));
    const allocations = (asset.data.allocations as JsonObject[]).filter((a) =>
      result.allocationId
        ? a.id === result.allocationId
        : ["reserved", "issued"].includes(String(a.status)),
    );
    assert.equal(
      allocations.length,
      1,
      "fixture must explicitly select one allocation",
    );
    result = {
      allocationId: allocations[0]!.id!,
      expectedAllocationVersion: allocations[0]!.version!,
      ...(["issue", "return"].includes(action)
        ? { location: "Synthetic fixture handover station", condition: "good" }
        : {}),
      ...result,
    };
  }
  return result;
}
