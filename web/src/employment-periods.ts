import type { Entity } from "./types";

export interface EmploymentPeriod {
  id: string;
  personId: string;
  version: number;
  kind: "internal" | "contractor";
  status: "onboarding" | "active" | "offboarding" | "ended" | "cancelled";
  startDate: string;
  endDate: string | null;
  role: string;
  engagementRef?: { module: "sales" | "cases"; id: string } | null;
  engagementLabel?: string;
}
const permittedStates: Record<string, EmploymentPeriod["status"][]> = {
  "people.activate": ["onboarding"],
  "people.beginOffboarding": ["onboarding", "active"],
  "people.endEmployment": ["offboarding"],
  "assets.reserve": ["onboarding", "active"],
  "assets.issue": ["onboarding", "active"],
  "licenses.assign": ["onboarding", "active"],
  "licenses.revoke": ["onboarding", "active", "offboarding"],
};
export function requiresEmploymentPeriod(module: string, action: string) {
  return Object.hasOwn(permittedStates, `${module}.${action}`);
}
export function employmentPersonId(
  module: string,
  entity: Entity | undefined,
  values: Record<string, unknown>,
): string {
  return String(
    module === "people" ? (entity?.id ?? "") : (values.personId ?? ""),
  );
}
export function availableEmploymentPeriods(
  module: string,
  action: string,
  personId: string,
  episodes: EmploymentPeriod[],
): EmploymentPeriod[] {
  const states = permittedStates[`${module}.${action}`];
  return episodes.filter(
    (episode) =>
      episode.personId === personId &&
      (!states || states.includes(episode.status)),
  );
}
/** UI selection is required even when the endpoint returns exactly one period. */
export function selectedEmploymentInput(
  module: string,
  action: string,
  personId: string,
  selectedId: unknown,
  episodes: EmploymentPeriod[],
): { employmentEpisodeId: string; expectedEpisodeVersion: number } {
  const selected = availableEmploymentPeriods(
    module,
    action,
    personId,
    episodes,
  ).find((episode) => episode.id === selectedId);
  if (
    !selected ||
    !Number.isSafeInteger(selected.version) ||
    selected.version < 1
  )
    throw new Error("Wybierz aktualny okres współpracy dla tej osoby.");
  return {
    employmentEpisodeId: selected.id,
    expectedEpisodeVersion: selected.version,
  };
}
export function changeCommandField(
  values: Record<string, unknown>,
  key: string,
  value: unknown,
): Record<string, unknown> {
  return {
    ...values,
    [key]: value,
    ...(key === "personId" || key === "employmentEpisodeId"
      ? { expectedEpisodeVersion: undefined, caseId: "" }
      : {}),
    ...(key === "personId" ? { employmentEpisodeId: "" } : {}),
    ...(key === "kind" ? { parentId: "" } : {}),
  };
}
export function employmentCaseOptions(
  records: Entity[],
  personId: string,
  episodeId: unknown,
): { id: string; label: string }[] {
  return records
    .filter(
      (item) =>
        item.module === "cases" &&
        item.status !== "cancelled" &&
        item.data.personId === personId &&
        item.data.employmentEpisodeId === episodeId,
    )
    .map((item) => ({ id: item.id, label: item.title }));
}
