import type { JsonObject } from "../../src/contracts.js";
import { type CustodyFixture } from "./custody-fixture.js";

export async function seedAccess(
  f: CustodyFixture,
  tenant = "synthetic-a",
  licensed = false,
) {
  const seed = await f.seed(tenant);
  const create = async (module: string, title: string, data: JsonObject) => {
    const run = await f.complete(
      `ops.${module}.create`,
      { title, data },
      "manager",
      tenant,
    );
    return String(run.steps[0]!.output!.data.entityId);
  };
  let licenseId: string | undefined, licenseSeatId: string | undefined;
  if (licensed) {
    licenseId = await create("licenses", "Synthetic seat", {
      product: "Synthetic local app",
      totalSeats: 2,
      expiresOn: "2026-10-01",
    });
    await f.complete(
      "ops.licenses.assign",
      {
        id: licenseId,
        expectedVersion: 1,
        personId: seed.personId,
        employmentEpisodeId: seed.episodeId,
        expectedEpisodeVersion: 1,
        caseId: seed.caseId,
        note: "Synthetic licence only",
      },
      "manager",
      tenant,
    );
    licenseSeatId = String(
      (
        f.get("licenses", licenseId, tenant).data.assignments as JsonObject[]
      )[0]!.id,
    );
  }
  const apps: string[] = [];
  for (const key of ["mail", "wiki"])
    apps.push(
      await create("it", `Synthetic ${key}`, {
        kind: "application",
        applicationKey: key,
        description: "Synthetic configuration; no connector",
        supportedRoles: ["member", "reader"],
      }),
    );
  const members = apps.map((applicationId, i) => ({
    key: i === 0 ? "mail" : "wiki",
    applicationId,
    applicationVersion: 1,
    role: i === 0 ? "member" : "reader",
    validityDays: 7,
    ...(i === 0 && licenseId ? { licenseId } : {}),
  }));
  const bundleId = await create("it", "Synthetic employee access", {
    kind: "access_bundle",
    accessKey: "employee-workspace",
    description: "Synthetic bundle",
    members,
  });
  await reviseAccess(f, seed.caseId, bundleId, tenant);
  return { ...seed, apps, members, bundleId, licenseId, licenseSeatId, tenant };
}
export async function reviseAccess(
  f: CustodyFixture,
  caseId: string,
  bundleId: string,
  tenant = "synthetic-a",
) {
  const c = f.get("cases", caseId, tenant);
  const definitions = f.workspace.readiness(
    f.actor("manager", tenant),
    caseId,
  ).definitions;
  await f.complete(
    "ops.cases.revise",
    {
      id: caseId,
      expectedVersion: c.version,
      brief: String(c.data.brief),
      acceptanceCriteria: String(c.data.acceptanceCriteria),
      reason: "Synthetic pinned access scope",
      requirements: definitions.map((r) =>
        r.kind === "access_attested"
          ? {
              ...r,
              expected: {
                accessKey: String(f.get("it", bundleId, tenant).data.accessKey),
                bundleId,
                bundleVersion: f.get("it", bundleId, tenant).version,
              },
            }
          : r,
      ) as unknown as JsonObject[],
    },
    "manager",
    tenant,
  );
}
export function accessInput(
  f: CustodyFixture,
  seed: Awaited<ReturnType<typeof seedAccess>>,
  member = 0,
): JsonObject {
  const c = f.get("cases", seed.caseId, seed.tenant);
  const requirement = f.workspace.caseAccess(
    f.actor("manager", seed.tenant),
    seed.caseId,
  ).requirements[0]!;
  return {
    id: c.id,
    expectedVersion: c.version,
    requirementId: requirement.id,
    memberKey: member === 0 ? "mail" : "wiki",
    accountRef: `synthetic-${seed.episodeId}-${member}`,
    observedOn: "2026-09-08",
    validUntil: "2026-09-14",
    verificationMethod: "Synthetic fixture: account and assigned role checked",
    note: "Synthetic evidence only",
    humanConfirmed: true,
    ...(member === 0 && seed.licenseSeatId
      ? { licenseSeatId: seed.licenseSeatId }
      : {}),
  };
}
export function accessBindInput(
  f: CustodyFixture,
  seed: Awaited<ReturnType<typeof seedAccess>>,
): JsonObject {
  const c = f.get("cases", seed.caseId, seed.tenant);
  return {
    id: c.id,
    expectedVersion: c.version,
    requirementId: f.workspace.caseAccess(
      f.actor("manager", seed.tenant),
      seed.caseId,
    ).requirements[0]!.id,
    sourceModule: "it",
    sourceId: seed.bundleId,
    sourceVersion: f.get("it", seed.bundleId, seed.tenant).version,
  };
}
