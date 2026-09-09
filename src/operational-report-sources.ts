import { DomainError, type JsonObject } from "./contracts.js";
import { hash } from "./engine.js";
import type { Entity, WorkspaceStore } from "./workspace.js";
import type { AcceptanceReadiness } from "./case-readiness.js";
import type { OnboardingOverview } from "./onboarding.js";
import {
  reportPeriodIncludes,
  reportMoneyLabel,
  type ReportDefinition,
  type OperationalReportRow,
  type ReportReference,
  type ReportMoney,
} from "./operational-reports.js";

export interface ReportSourceReaders {
  /** Complete filtered set or an explicit limit error; never a truncated workspace list. */
  select(
    definition: ReportDefinition,
    module: "assets" | "cases" | "purchases" | "licenses",
  ): Entity[];
  record(module: string, id: string): Entity;
  reference(entity: Entity): ReportReference;
  scopes(entity: Entity): string[];
  holds(id: string): ReturnType<WorkspaceStore["assetInventoryHolds"]>;
  onboarding(
    id: string,
  ): Pick<
    OnboardingOverview,
    "person" | "episode" | "engagement" | "stage" | "tasks"
  > | null;
  readiness(id: string): AcceptanceReadiness;
  deliveries(id: string): ReturnType<WorkspaceStore["purchaseDeliveries"]>;
  license(id: string): ReturnType<WorkspaceStore["licenseContracts"]>;
}
const object = (value: unknown): JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
const objects = (value: unknown): JsonObject[] =>
  Array.isArray(value) ? value.map(object) : [];
const string = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value : null;
const number = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const label = (value: unknown): string | null => {
  const s = string(value);
  if (s === null) return null;
  return (
    (
      {
        available: "Dostępny",
        reserved: "Zarezerwowany",
        issued: "Wydany",
        maintenance: "W serwisie",
        retired: "Wycofany",
        good: "Sprawny",
        repair: "Wymaga naprawy",
        active: "Aktywny",
        ordered: "Zamówiony",
        partially_received: "Dostawa częściowa",
        received: "Dostawa przyjęta",
        needs_resolution: "Rozbieżność do wyjaśnienia",
        draft: "Szkic",
        approved: "Zatwierdzona propozycja",
        rejected: "Odrzucony",
        cancelled: "Anulowany",
        internal: "Pracownik wewnętrzny",
        contractor: "Konsultant",
        onboarding: "Przygotowanie startu",
        offboarding: "Zakończenie współpracy",
        ended: "Współpraca zakończona",
      } as Record<string, string>
    )[s] ?? s
  );
};
const fields = (values: Record<string, string | number | boolean | null>) =>
  Object.entries(values).map(([label, value]) => ({ label, value }));
function row(
  readers: ReportSourceReaders,
  root: Entity,
  additional: Entity[],
  values: OperationalReportRow["fields"],
  warnings: string[],
  basis: unknown,
  money?: ReportMoney,
): OperationalReportRow {
  const unique = new Map<string, Entity>();
  for (const entity of [root, ...additional])
    unique.set(`${entity.module}:${entity.id}`, entity);
  const records = [...unique.values()].sort((a, b) =>
    `${a.module}:${a.id}`.localeCompare(`${b.module}:${b.id}`),
  );
  const references = records.map((e) => readers.reference(e));
  return {
    key: `${root.module}:${root.id}`,
    title: root.title,
    fields: values,
    warnings,
    references,
    accessScopes: [
      ...new Set(records.flatMap((e) => [e.module, ...readers.scopes(e)])),
    ].sort(),
    basisHash: hash({ references, basis }),
    ...(money ? { money } : {}),
  };
}
function related(
  readers: ReportSourceReaders,
  e: Entity,
  module: string,
  field: string,
): Entity[] {
  const id = string(e.data[field]);
  return id ? [readers.record(module, id)] : [];
}
function equipment(
  readers: ReportSourceReaders,
  e: Entity,
): OperationalReportRow {
  const d = e.data,
    holds = readers.holds(e.id),
    allocations = objects(d.allocations),
    active = allocations.filter((a) =>
      ["reserved", "issued"].includes(String(a.status)),
    );
  if (active.length > 1)
    throw new DomainError(
      "REPORT_SOURCE_INCONSISTENT",
      "Urządzenie ma więcej niż jeden aktywny przydział.",
      409,
    );
  const warnings: string[] = [];
  if (holds.length)
    warnings.push(
      `Otwarte rozbieżności spisu: ${holds.length}. Dostępność wymaga wyjaśnienia.`,
    );
  if (d.condition === "repair") warnings.push("Sprzęt wymaga naprawy.");
  if (!string(d.location)) warnings.push("Brak lokalizacji w ewidencji.");
  const source = object(d.importSource),
    allocation = active[0],
    extra = holds.map((h) => readers.record("inventory", h.stocktakeId));
  if (allocation?.status === "issued" && !allocation.issueEventId)
    warnings.push(
      "Historyczny przydział nie ma niezależnego poświadczenia fizycznego wydania.",
    );
  return row(
    readers,
    e,
    extra,
    fields({
      "Numer seryjny": string(d.serial),
      Lokalizacja: string(d.location),
      "Stan ewidencji": label(e.status),
      "Stan techniczny": label(d.condition),
      "Aktywne przekazanie":
        allocation?.status === "issued"
          ? allocation.issueEventId
            ? "Wydanie poświadczone"
            : "Historyczny zapis wydania bez poświadczenia"
          : allocation?.status === "reserved"
            ? "Rezerwacja bez wydania"
            : "Brak aktywnego przydziału",
      "Identyfikator przydziału": allocation
        ? string(allocation.id)
        : "Nie dotyczy",
      "Identyfikator współpracy": allocation
        ? string(allocation.employmentEpisodeId)
        : "Nie dotyczy",
      "Koniec rezerwacji":
        allocation?.status === "reserved"
          ? string(allocation.expiresAt)
          : "Nie dotyczy",
      "Otwarte rozbieżności": holds.length,
      "Ostatni zapis lokalny": e.updatedAt,
      "Data źródła importu": d.importSource
        ? string(source.observedOn)
        : "Nie dotyczy — zapis lokalny",
      "Nazwa źródła": string(source.sourceName) ?? "Lokalna ewidencja JARVIS",
    }),
    warnings,
    { holds, allocations },
  );
}
function start(readers: ReportSourceReaders, e: Entity): OperationalReportRow {
  const overview = readers.onboarding(e.id),
    ready = readers.readiness(e.id),
    extra = related(readers, e, "people", "personId");
  const warnings = ready.requirements
    .filter((r) => r.required && r.status !== "satisfied")
    .map((r) => `${r.title}: ${r.reason}`);
  warnings.push(...ready.taskBlockers);
  if (!overview)
    warnings.push(
      "Brak potwierdzonego okresu współpracy; gotowość startu pozostaje nieustalona.",
    );
  if (e.status === "accepted" && !ready.acceptanceCurrent)
    warnings.push("Wcześniejszy odbiór wymaga ponownej oceny.");
  for (const requirement of ready.requirements) {
    const source = requirement.source;
    if (source && source.module !== "laboratory")
      extra.push(readers.record(source.module, source.id));
  }
  if (overview?.engagement)
    extra.push(
      readers.record(overview.engagement.module, overview.engagement.id),
    );
  const tasks = overview?.tasks ?? [];
  const values = fields({
    Osoba:
      overview?.person.title ??
      extra.find((x) => x.module === "people")?.title ??
      null,
    "Okres współpracy":
      overview?.episode.id ?? string(e.data.employmentEpisodeId),
    "Rodzaj współpracy": label(overview?.episode.kind),
    "Planowany start":
      overview?.episode.startDate ?? string(e.data.employmentStartDate),
    Rola: overview?.episode.role ?? null,
    Projekt: overview?.engagement?.title ?? null,
    Etap: overview?.stage.title ?? null,
    "Gotowość potwierdzona": overview ? ready.ready : null,
    "Aktualny odbiór": ready.acceptanceCurrent,
    "Zadania wymagane": overview
      ? tasks.filter((t) => t.required).length
      : null,
    "Zadania wymagane zakończone": overview
      ? tasks.filter((t) => t.required && t.status === "completed").length
      : null,
    "Zadania zaległe": overview ? tasks.filter((t) => t.overdue).length : null,
  });
  return row(readers, e, extra, values, warnings, {
    readiness: ready,
    episode: overview?.episode ?? null,
    stage: overview?.stage ?? null,
    tasks,
  });
}
function delivery(
  readers: ReportSourceReaders,
  e: Entity,
): OperationalReportRow {
  const view = readers.deliveries(e.id),
    t = view.totals,
    extra = [
      ...view.receipts,
      ...related(readers, e, "purchases", "supplierId"),
      ...related(readers, e, "purchases", "requestId"),
    ];
  const warnings: string[] = [];
  if (t.outstandingQuantity > 0)
    warnings.push(`Brakujące ilości: ${t.outstandingQuantity}.`);
  if (t.unresolvedQuantity > 0)
    warnings.push(`Odrzucone ilości do rozliczenia: ${t.unresolvedQuantity}.`);
  if (t.unverifiedLegacyQuantity > 0)
    warnings.push(
      `Ilości historyczne bez pełnego poświadczenia: ${t.unverifiedLegacyQuantity}.`,
    );
  if (!e.data.expectedDelivery)
    warnings.push(
      "Brak potwierdzonego terminu dostawy; pozycja pozostała w raporcie.",
    );
  const supplier = extra.find((x) => x.id === e.data.supplierId);
  return row(
    readers,
    e,
    extra,
    fields({
      Dostawca: supplier?.title ?? null,
      "Planowany termin": string(e.data.expectedDelivery),
      "Stan zamówienia": label(e.status),
      Zamówiono: number(e.data.quantity),
      "Fizycznie otrzymano (z poświadczeniami historycznymi)":
        t.physicalQuantity,
      "Przyjęto do realizacji": t.acceptedQuantity,
      "Potwierdzono protokołem": t.confirmedQuantity,
      Odrzucono: t.rejectedQuantity,
      "Zwrócono po odrzuceniu": t.rejectedQuantity - t.unresolvedQuantity,
      "Nierozliczone odrzucenia": t.unresolvedQuantity,
      "Brakujące ilości": t.outstandingQuantity,
      "Ilości bez pełnego dowodu": t.unverifiedLegacyQuantity,
      "Odrębne dokumenty dostawy": view.receipts.length,
      "Dostawa kompletna i potwierdzona": view.proof.identity.current === true,
    }),
    warnings,
    { totals: t, identity: view.proof.identity },
  );
}
function orderCommitment(
  readers: ReportSourceReaders,
  e: Entity,
): OperationalReportRow {
  const extra = [
      ...related(readers, e, "purchases", "supplierId"),
      ...related(readers, e, "purchases", "requestId"),
    ],
    d = e.data,
    known = d.procurementVersion === 1;
  const supplier = extra.find((x) => x.id === d.supplierId),
    warnings: string[] = [];
  if (!known)
    warnings.push(
      "Historyczny zapis bez pełnej decyzji kosztowej; kwota nie wchodzi do sumy.",
    );
  if (!d.expectedDelivery)
    warnings.push("Brak planowanego terminu; pozycja pozostała w raporcie.");
  if (d.dispatch === "not_sent_local_record")
    warnings.push("Zapis zamówienia nie potwierdza wysłania go do dostawcy.");
  const money: ReportMoney | undefined = known
    ? {
        minor: Number(d.totalMinor),
        currency: d.currency as ReportMoney["currency"],
        basis: d.priceBasis as ReportMoney["basis"],
        category: "purchase_order",
      }
    : undefined;
  return row(
    readers,
    e,
    extra,
    fields({
      "Rodzaj zobowiązania": "Lokalny zapis zamówienia",
      Dostawca: supplier?.title ?? null,
      Termin: string(d.expectedDelivery),
      Zarejestrowano: string(d.orderedAt),
      Stan: label(e.status),
      "Pełna kwota": money ? reportMoneyLabel(money) : null,
      Waluta: money?.currency ?? null,
      "Podstawa kosztu": money
        ? money.basis === "net"
          ? "Netto"
          : "Brutto"
        : null,
      "Dowód płatności": "Poza zakresem JARVIS",
    }),
    warnings,
    { costDecision: d.costDecision ?? null, quotation: d.quotation ?? null },
    money,
  );
}
function licenseCommitment(
  readers: ReportSourceReaders,
  e: Entity,
  definition: ReportDefinition,
): OperationalReportRow | null {
  const view = readers.license(e.id);
  if (view.truncated)
    throw new DomainError(
      "REPORT_SCOPE_TOO_LARGE",
      "Historia licencji przekracza pełny zakres odczytu raportu.",
      409,
    );
  const activeId = string(e.data.activeTermsId),
    active = activeId
      ? view.terms.find((t) => t.record.id === activeId)?.record
      : null;
  if (activeId && !active)
    throw new DomainError(
      "REPORT_SOURCE_INCONSISTENT",
      "Brak wskazanej aktywnej umowy licencji.",
      409,
    );
  const terms = object(active?.data.terms),
    confirmation = object(active?.data.confirmation);
  if (
    !reportPeriodIncludes(
      definition,
      string(terms.validFrom),
      string(terms.expiresOn),
    )
  )
    return null;
  const known =
    !!active &&
    active.status === "active" &&
    typeof confirmation.hash === "string";
  const extra = [
      ...(active ? [active] : []),
      ...related(readers, e, "purchases", "supplierId"),
    ],
    warnings: string[] = [];
  if (!known)
    warnings.push(
      "Brak poświadczonej umowy z kosztem; nie podstawiono kwoty zero.",
    );
  if (e.data.pendingTermsId)
    warnings.push(
      "Istnieje oddzielna propozycja nowych warunków; jej koszt nie został doliczony.",
    );
  const money: ReportMoney | undefined = known
    ? {
        minor: Number(terms.totalCostMinor),
        currency: terms.currency as ReportMoney["currency"],
        basis: terms.priceBasis as ReportMoney["basis"],
        category: "license_contract",
      }
    : undefined;
  return row(
    readers,
    e,
    extra,
    fields({
      "Rodzaj zobowiązania": known
        ? "Bieżąca poświadczona umowa licencji"
        : "Licencja bez poświadczonej umowy",
      Produkt: string(e.data.product),
      Umowa: string(terms.agreementReference),
      "Dokument poświadczenia": string(confirmation.documentReference),
      "Początek okresu": string(terms.validFrom),
      "Koniec okresu": string(terms.expiresOn),
      "Pełna kwota": money ? reportMoneyLabel(money) : null,
      Waluta: money?.currency ?? null,
      "Podstawa kosztu": money
        ? money.basis === "net"
          ? "Netto"
          : "Brutto"
        : null,
      "Miejsca licencyjne": number(e.data.totalSeats),
      "Zajęte miejsca": view.usedSeats,
      Właściciel: string(e.data.ownerPrincipalId),
      "Dowód płatności": "Poza zakresem JARVIS",
    }),
    warnings,
    { terms, confirmation, usedSeats: view.usedSeats },
    money,
  );
}
export function collectReportRows(
  readers: ReportSourceReaders,
  definition: ReportDefinition,
): OperationalReportRow[] {
  if (definition.kind === "equipment")
    return readers
      .select(definition, "assets")
      .map((e) => equipment(readers, e));
  if (definition.kind === "starts")
    return readers
      .select(definition, "cases")
      .filter((e) =>
        reportPeriodIncludes(definition, string(e.data.employmentStartDate)),
      )
      .map((e) => start(readers, e));
  if (definition.kind === "deliveries")
    return readers
      .select(definition, "purchases")
      .filter((e) =>
        reportPeriodIncludes(definition, string(e.data.expectedDelivery)),
      )
      .map((e) => delivery(readers, e));
  return [
    ...readers
      .select(definition, "purchases")
      .filter((e) =>
        reportPeriodIncludes(definition, string(e.data.expectedDelivery)),
      )
      .map((e) => orderCommitment(readers, e)),
    ...readers.select(definition, "licenses").flatMap((e) => {
      const item = licenseCommitment(readers, e, definition);
      return item ? [item] : [];
    }),
  ];
}
