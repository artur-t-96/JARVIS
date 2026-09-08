import { useEffect, useState } from "react";
import { api } from "./api";
import { dateLabel, type Entity, type Field } from "./types";

export const referenceModule: Record<string, string> = {
  personId: "people",
  ownerId: "people",
  assigneeId: "people",
  supplierId: "purchases",
  parentId: "sales",
  vacancyId: "recruitment",
  linkedCaseId: "cases",
  relatedAssetId: "assets",
  onboardingCaseId: "cases",
  offboardingCaseId: "cases",
  caseId: "cases",
};
export const optionLabels: Record<string, string> = {
  internal: "Pracownik wewnętrzny",
  contractor: "Konsultant / kontraktor",
  general: "Sprawa ogólna",
  onboarding: "Onboarding",
  offboarding: "Offboarding",
  procurement: "Zakup",
  delivery: "Realizacja",
  it: "IT",
  laptop: "Laptop",
  phone: "Telefon",
  monitor: "Monitor",
  other: "Inne",
  good: "Sprawny",
  repair: "Wymaga naprawy",
  supplier: "Dostawca",
  order: "Zamówienie",
  client: "Klient",
  deal: "Szansa sprzedaży",
  offer: "Oferta",
  vacancy: "Rekrutacja",
  application: "Aplikacja",
  policy: "Polityka / procedura",
  contract: "Umowa",
  report: "Raport",
  observation: "Obserwacja",
  incident: "Incydent",
  lab_case: "Sprawa laboratoryjna",
  low: "Niski",
  medium: "Średni",
  high: "Wysoki",
  critical: "Krytyczny",
  local: "Lokalne",
  lab: "Laboratorium",
  accepted: "Akceptuję rezultat",
  rejected: "Kieruję do poprawy",
  people: "Kadry i osoby",
  sales: "Sprzedaż",
  documents: "Dokumenty",
};
export const optionLabel = (value: string) => optionLabels[value] ?? value;
export const rows = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value)
    ? value.filter(
        (row): row is Record<string, unknown> =>
          !!row && typeof row === "object" && !Array.isArray(row),
      )
    : [];

export function useReferences(fields: Field[], entity?: Entity) {
  const modules = [
    ...new Set(
      fields
        .map(
          (field) =>
            referenceModule[field.key] ??
            (field.key === "employmentEpisodeId" ? "people" : ""),
        )
        .filter(Boolean),
    ),
  ]
    .sort()
    .join(",");
  const [records, setRecords] = useState<Record<string, Entity[]>>({});
  const [errors, setErrors] = useState<string[]>([]);
  useEffect(() => {
    let active = true;
    setRecords({});
    setErrors([]);
    void Promise.allSettled(
      modules
        .split(",")
        .filter(Boolean)
        .map(async (module) => ({
          module,
          result: await api<{ items: Entity[] }>(`/api/workspace/${module}`),
        })),
    ).then((results) => {
      if (!active) return;
      const result: Record<string, Entity[]> = {};
      const failures: string[] = [];
      results.forEach((entry) => {
        if (entry.status === "fulfilled")
          result[entry.value.module] = entry.value.result.items;
        else
          failures.push(
            "Nie udało się odczytać części powiązanych rekordów. Sprawdź dostęp do odpowiedniego obszaru.",
          );
      });
      setRecords(result);
      setErrors([...new Set(failures)]);
    });
    return () => {
      active = false;
    };
  }, [modules, entity?.id]);
  const label = (key: string, id: unknown): string => {
    const module = referenceModule[key];
    const found = module && records[module]?.find((item) => item.id === id);
    return found
      ? found.title
      : id
        ? "Powiązany rekord (szczegóły niedostępne)"
        : "—";
  };
  return { records, errors, label };
}

export function referenceOptions(
  key: string,
  records: Record<string, Entity[]>,
  values: Record<string, unknown>,
  entity?: Entity,
): { id: string; label: string }[] | null {
  if (key === "taskId" || key === "dependsOn")
    return rows(entity?.data.tasks)
      .filter((task) => key !== "taskId" || task.status === "open")
      .map((task) => ({
        id: String(task.id),
        label: `${String(task.title)}${task.status === "completed" ? " · ukończone" : ""}`,
      }));
  if (key === "employmentEpisodeId") {
    const person = records.people?.find((item) => item.id === values.personId);
    return rows(person?.data.employmentEpisodes).map((episode) => ({
      id: String(episode.id),
      label: `${String(episode.role ?? optionLabel(String(episode.kind)))} · od ${dateLabel(String(episode.startDate))}`,
    }));
  }
  const module = referenceModule[key];
  if (!module) return null;
  let options = records[module] ?? [];
  if (key === "supplierId")
    options = options.filter((item) => item.data.kind === "supplier");
  if (key === "vacancyId")
    options = options.filter((item) => item.data.kind === "vacancy");
  if (key === "parentId")
    options = options.filter(
      (item) =>
        item.data.kind === (values.kind === "offer" ? "deal" : "client"),
    );
  return options.map((item) => ({ id: item.id, label: item.title }));
}

export const referenceLabel = (key: string, fallback: string): string =>
  (
    ({
      personId: "Osoba",
      ownerId: "Właściciel",
      assigneeId: "Osoba odpowiedzialna",
      supplierId: "Dostawca",
      parentId: "Powiązany klient lub szansa",
      vacancyId: "Rekrutacja",
      linkedCaseId: "Powiązana sprawa",
      relatedAssetId: "Powiązany sprzęt",
      employmentEpisodeId: "Okres współpracy",
      taskId: "Zadanie",
    }) as Record<string, string>
  )[key] ?? fallback;
