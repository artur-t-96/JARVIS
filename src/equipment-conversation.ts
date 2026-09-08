import {
  ContextBroker,
  type ContextKind,
  type ContextRecord,
  type ContextTurn,
} from "./context-broker.js";
import type {
  DraftClaim,
  NeedDraft,
  PreparedProposal,
} from "./assistant-drafts.js";
import { DomainError, type JsonObject } from "./contracts.js";
import { actionSchemas, date } from "./workspace-models.js";

type Selection = "person" | "episode" | "case" | "asset";
type Slot = "company" | Selection;
interface EquipmentState {
  records: Partial<Record<Slot, ContextRecord>>;
  candidates: ContextRecord[];
  query?: string;
  page?: { kind: "person" | "episode" | "case"; cursor: string };
}
export interface EquipmentTurnInput {
  broker: ContextBroker;
  turn: ContextTurn;
  claim: DraftClaim;
  text: string;
  choiceRef?: string;
  clock?: () => number;
}
const fold = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ł/gi, "l")
    .toLowerCase();
const slotOrder: Selection[] = ["person", "episode", "case", "asset"];
const expired = (error: unknown) =>
  error instanceof DomainError &&
  ["CONTEXT_SOURCE_STALE", "CONTEXT_REFERENCE_EXPIRED"].includes(error.code);
const summaryChoice = (record: ContextRecord) => ({
  ref: record.ref,
  label: record.label,
  ...(record.kind === "episode"
    ? {
        detail: [
          record.data.role,
          record.data.engagementLabel,
          record.data.status,
          record.data.endDate ? `Do ${record.data.endDate}` : null,
        ]
          .filter(Boolean)
          .join(" · "),
      }
    : record.kind === "person"
      ? {
          detail: [record.data.department, record.data.jobTitle]
            .filter(Boolean)
            .join(" · "),
        }
      : record.kind === "asset"
        ? {
            detail: [record.data.location, "Dostępny teraz"]
              .filter(Boolean)
              .join(" · "),
          }
        : {}),
});

/** A calendar date in the confirmed company timezone, with no guessed expiry. */
export function equipmentDate(
  text: string,
  timezone: string,
  now: number,
): string | undefined {
  const explicit = text.match(/\b\d{4}-\d{2}-\d{2}\b/g);
  const value = fold(text);
  const relative = [...value.matchAll(/\b(pojutrze|jutro|dzisiaj|dzis)\b/g)];
  if (explicit)
    return explicit.length === 1 &&
      !relative.length &&
      date.safeParse(explicit[0]).success
      ? explicit[0]
      : undefined;
  if (relative.length !== 1) return undefined;
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(now));
  const part = (type: string) =>
    parts.find((entry) => entry.type === type)!.value;
  const today = `${part("year")}-${part("month")}-${part("day")}`;
  const days =
    relative[0]![1] === "pojutrze" ? 2 : relative[0]![1] === "jutro" ? 1 : 0;
  return new Date(Date.parse(`${today}T12:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}
function personQuery(text: string): string | undefined {
  const named =
    text.match(
      /\bdla\s+([\p{L}' -]+?)(?=\s+(?:na|do|od|laptop\p{L}*|telefon\p{L}*|monitor\p{L}*|sprz[eę]t\p{L}*)\b|[,.!?]|$)/iu,
    )?.[1] ??
    text.match(
      /\b(?:przygotuj|zarezerwuj)\s+([\p{L}' -]+?)\s+(?:laptop\p{L}*|telefon\p{L}*|monitor\p{L}*|sprz[eę]t\p{L}*)\b/iu,
    )?.[1];
  return named?.trim().slice(0, 120);
}
const assetType = (text: string): NeedDraft["assetType"] => {
  const value = fold(text);
  if (/\blaptop\p{L}*/u.test(value)) return "laptop";
  if (/\btelefon\p{L}*/u.test(value)) return "phone";
  if (/\bmonitor\p{L}*/u.test(value)) return "monitor";
  if (/^(?:inny|inne|other)(?: sprzet)?$/.test(value.trim())) return "other";
  return undefined;
};

/** Deterministic, local proposal only. Core owns approval, execution and evidence. */
export function advanceEquipment({
  broker,
  turn,
  claim,
  text,
  choiceRef,
  clock = Date.now,
}: EquipmentTurnInput): PreparedProposal {
  broker.assertCurrent(turn);
  if (
    claim.conversationId !== turn.conversationId ||
    claim.principal.id !== turn.principal.id ||
    claim.principal.tenantId !== turn.principal.tenantId
  )
    throw new DomainError(
      "EQUIPMENT_CONTEXT_MISMATCH",
      "Tura nie należy do tej rozmowy.",
      403,
    );
  const draft: NeedDraft = structuredClone(claim.draft);
  const state: EquipmentState = structuredClone(
    (claim.state.equipment as unknown as EquipmentState | undefined) ?? {
      records: {},
      candidates: [],
    },
  );
  draft.intent = "equipment_request";
  delete draft.blockedReason;
  const sources = () => {
    const records = [
      ...Object.values(state.records),
      ...state.candidates,
    ].filter((record): record is ContextRecord => !!record);
    const unique = new Map(
      records.map((record) => [`${record.kind}:${record.source.id}`, record]),
    );
    draft.sources = [...unique.values()].map((record) => ({
      label: record.label,
      module: record.source.module,
      version: record.source.version,
      observedAt: record.source.observedAt,
      ...(record.source.updatedAt
        ? { updatedAt: record.source.updatedAt }
        : {}),
      freshness: "current" as const,
    }));
  };
  const result = (
    message: string,
    kind: PreparedProposal["kind"] = "needs_input",
    plan?: PreparedProposal["plan"],
  ): PreparedProposal => {
    sources();
    return {
      draft,
      message,
      kind,
      ...(plan ? { plan } : {}),
      state: {
        ...claim.state,
        equipment: JSON.parse(JSON.stringify(state)) as JsonObject,
      },
    };
  };
  const ask = (field: string, question: string) => {
    if (field === "readyOn") delete draft.readyOn;
    if (field === "reservationUntil") delete draft.reservationUntil;
    if (field === "readyOn" || field === "reservationUntil") clearFrom("asset");
    draft.phase = "collecting";
    draft.missingFields = [field];
    draft.clarification = { kind: field, question, options: [] };
    state.candidates = [];
    delete state.page;
    return result(question);
  };
  const block = (field: string, reason: string) => {
    draft.phase = "blocked";
    draft.missingFields = [field];
    draft.blockedReason = reason;
    delete draft.clarification;
    state.candidates = [];
    delete state.page;
    return result(reason);
  };
  const clearFrom = (slot: Selection) => {
    for (const field of slotOrder.slice(slotOrder.indexOf(slot))) {
      delete draft[field];
      delete state.records[field];
    }
    state.candidates = [];
    delete state.page;
    delete draft.clarification;
  };
  const choose = (
    slot: Selection,
    items: ContextRecord[],
    prefix = "",
    nextCursor?: string,
  ) => {
    const questions: Record<Selection, string> = {
      person: "Wybierz osobę, dla której przygotowujemy sprzęt.",
      episode: "Wybierz konkretny okres współpracy, którego dotyczy sprzęt.",
      case: "Wybierz sprawę tej osoby i tego okresu współpracy.",
      asset: "Wybierz konkretny dostępny sprzęt do rezerwacji.",
    };
    draft.phase = "needs_choice";
    draft.missingFields = [slot];
    draft.clarification = {
      kind: slot,
      question: prefix + questions[slot],
      options: items.map(summaryChoice),
      ...(nextCursor ? { hasNextPage: true } : {}),
    };
    state.candidates = items;
    if (nextCursor && slot !== "asset")
      state.page = { kind: slot, cursor: nextCursor };
    else delete state.page;
    return result(draft.clarification.question);
  };
  const readCompany = () => {
    const company = broker.read(turn, "context.company", {
      purpose: "equipment_request",
    }).items[0]!;
    state.records.company = company;
    return company;
  };
  const queryPeople = (query: string, prefix = "", cursor?: string) => {
    state.query = query;
    const found = broker.read(turn, "context.findPeople", {
      query,
      limit: 5,
      ...(cursor ? { cursor } : {}),
    });
    if (!found.items.length)
      return ask(
        "person",
        "Nie znalazłem dostępnej osoby. Podaj imię i nazwisko; nie wpisuj identyfikatora.",
      );
    return choose(
      "person",
      found.items,
      prefix +
        (found.nextCursor
          ? "Możesz zawęzić nazwisko lub przejść do kolejnych wyników. "
          : ""),
      found.nextCursor,
    );
  };
  const episodes = (prefix = "", cursor?: string) => {
    const items = broker.read(turn, "context.personWork", {
      personRef: state.records.person!.ref,
      purpose: "equipment_request",
      ...(cursor ? { cursor } : {}),
    });
    const eligible = items.items.filter((item) =>
      ["onboarding", "active"].includes(String(item.data.status)),
    );
    if (!eligible.length && !items.nextCursor)
      return block(
        "episode",
        "Brak okresu współpracy dopuszczającego sprzęt na tej stronie. Osoba odpowiedzialna za HR musi wskazać lub rozpocząć właściwy okres w Osobach.",
      );
    return choose(
      "episode",
      eligible,
      prefix +
        (!eligible.length
          ? "Ta strona nie zawiera aktywnego okresu. Przejdź do kolejnych wyników. "
          : ""),
      items.nextCursor,
    );
  };
  const cases = (prefix = "", cursor?: string) => {
    const found = broker.read(turn, "context.findCases", {
      personRef: state.records.person!.ref,
      episodeRef: state.records.episode!.ref,
      state: "open",
      limit: 5,
      ...(cursor ? { cursor } : {}),
    });
    if (!found.items.length)
      return block(
        "case",
        "Brak dostępnej otwartej sprawy tej osoby i tego okresu współpracy. Utwórz lub uzupełnij powiązaną sprawę w Sprawach, a następnie wróć do rozmowy.",
      );
    return choose("case", found.items, prefix, found.nextCursor);
  };
  const assets = (prefix = "") => {
    const found = broker.read(turn, "context.availableAssets", {
      assetType: draft.assetType!,
      readyOn: draft.readyOn!,
      episodeRef: state.records.episode!.ref,
      limit: 5,
    });
    if (!found.items.length)
      return block(
        "asset",
        "Brak dostępnego sprzętu tego rodzaju. Przygotuj zapotrzebowanie zakupowe lub poczekaj na zwrot sprzętu, a następnie ponów sprawdzenie. Żaden sprzęt nie został zarezerwowany.",
      );
    return choose(
      "asset",
      found.items,
      prefix +
        "Pokazuję do pięciu dostępnych sztuk. Dostępność dotyczy chwili odczytu, nie gwarancji na przyszły termin. ",
    );
  };
  const refresh = (slot: Slot) => {
    const prefix =
      "Poprzednie źródło zmieniło się lub odwołanie wygasło. Potwierdź aktualny wybór. ";
    if (slot === "company") {
      readCompany();
      clearFrom("person");
      return ask(
        "person",
        "Profil firmy lub jego odwołanie zmieniło się. Podaj ponownie osobę, aby potwierdzić zakres według aktualnego profilu.",
      );
    }
    const previous = state.records[slot];
    clearFrom(slot);
    if (slot === "person") {
      const item = broker.reference(
        turn,
        { module: "people", id: previous!.source.id },
        "equipment_request",
      ).items[0]!;
      return choose("person", [item], prefix);
    }
    if (slot === "episode") return episodes(prefix);
    if (slot === "case") return cases(prefix);
    return assets(prefix);
  };

  // Saved labels and versions never substitute for fresh ACL and source checks.
  for (const slot of ["company", ...slotOrder] as Slot[]) {
    const record = state.records[slot];
    if (!record) continue;
    try {
      record.source = broker.resolve(
        turn,
        record.ref,
        slot as ContextKind,
      ).source;
    } catch (error) {
      if (expired(error)) return refresh(slot);
      throw error;
    }
  }
  const company = state.records.company ?? readCompany();
  if (
    company.data.approved !== true ||
    !["2", "3"].includes(String(company.data.definitionVersion))
  )
    return block(
      "company",
      "Konfiguracja firmy wymaga zatwierdzonego profilu z rolami procesu. Uzupełnij i zatwierdź profil w Ustawieniach.",
    );
  const timezone = String(company.data.timezone);
  new Intl.DateTimeFormat("en", { timeZone: timezone });
  const now = clock();
  if (!choiceRef && fold(text.trim()) === "pokaz kolejne") {
    const page = state.page;
    if (
      !page ||
      draft.clarification?.kind !== page.kind ||
      !draft.clarification.hasNextPage
    )
      throw new DomainError(
        "CONTEXT_PAGE_UNAVAILABLE",
        "Nie ma zapisanej kolejnej strony tego pytania.",
        409,
      );
    // The browser sends only an action label; the cursor stays private and bound to this query.
    try {
      if (page.kind === "person")
        return queryPeople(state.query!, "", page.cursor);
      if (page.kind === "episode") return episodes("", page.cursor);
      return cases("", page.cursor);
    } catch (error) {
      if (!expired(error)) throw error;
      const prefix =
        "Lista zmieniła się. Wybierz ponownie z aktualnych wyników. ";
      if (page.kind === "person") return queryPeople(state.query!, prefix);
      if (page.kind === "episode") return episodes(prefix);
      return cases(prefix);
    }
  }

  let selected = false;
  if (choiceRef) {
    const visible = draft.clarification?.options.find(
      (option) => option.ref === choiceRef,
    );
    const candidate = state.candidates.find((item) => item.ref === choiceRef);
    const slot = draft.clarification?.kind as Selection | undefined;
    if (
      !visible ||
      !candidate ||
      !slot ||
      !slotOrder.includes(slot) ||
      visible.label !== text.trim() ||
      candidate.kind !== slot
    )
      throw new DomainError(
        "INVALID_CHOICE",
        "Wybierz pozycję z aktualnego pytania.",
        400,
      );
    try {
      broker.resolve(turn, choiceRef, slot);
    } catch (error) {
      if (!expired(error)) throw error;
      // Keep the trusted old source identifier only to obtain a new explicit choice.
      state.records[slot] = candidate;
      return refresh(slot);
    }
    clearFrom(slot);
    state.records[slot] = candidate;
    draft[slot] = summaryChoice(candidate);
    selected = true;
  }
  if (!draft.assetType) {
    const recognizedType = assetType(text);
    if (recognizedType) draft.assetType = recognizedType;
  }
  if (!state.records.person) {
    const query =
      personQuery(text) ??
      (!choiceRef &&
      claim.draft.clarification?.kind === "person" &&
      /^[\p{L}' -]{2,120}$/u.test(text.trim())
        ? text.trim()
        : undefined);
    if (!query)
      return ask(
        "person",
        "Dla kogo przygotować sprzęt? Podaj imię i nazwisko; wskażę dostępne osoby do wyboru.",
      );
    if (!draft.readyOn && /\bna\s+/i.test(text)) {
      const readyOn = equipmentDate(text, timezone, now);
      if (readyOn) draft.readyOn = readyOn;
    }
    return queryPeople(query);
  }
  if (!state.records.episode) return episodes();
  if (!draft.assetType) {
    return ask(
      "assetType",
      "Jakiego sprzętu potrzebujesz: laptopa, telefonu, monitora czy innego rodzaju?",
    );
  }
  if (!draft.readyOn) {
    const value = !selected ? equipmentDate(text, timezone, now) : undefined;
    if (!value)
      return ask(
        "readyOn",
        "Na jaki dzień sprzęt ma być gotowy? Podaj datę RRRR-MM-DD, dziś lub jutro. To termin gotowości, nie koniec rezerwacji.",
      );
    if (value < equipmentDate("dziś", timezone, now)!)
      return ask(
        "readyOn",
        "Termin gotowości jest w przeszłości. Podaj aktualną lub przyszłą datę.",
      );
    draft.readyOn = value;
    return ask(
      "reservationUntil",
      "Do którego dnia utrzymać rezerwację? Podaj osobną datę RRRR-MM-DD, dziś lub jutro.",
    );
  }
  if (draft.readyOn < equipmentDate("dziś", timezone, now)!)
    return ask(
      "readyOn",
      "Termin gotowości jest w przeszłości. Podaj aktualną lub przyszłą datę.",
    );
  if (!draft.reservationUntil) {
    const value =
      !selected && claim.draft.clarification?.kind === "reservationUntil"
        ? equipmentDate(text, timezone, now)
        : undefined;
    if (!value)
      return ask(
        "reservationUntil",
        "Do którego dnia utrzymać rezerwację? Podaj osobną datę RRRR-MM-DD, dziś lub jutro.",
      );
    if (value < draft.readyOn || value < equipmentDate("dziś", timezone, now)!)
      return ask(
        "reservationUntil",
        "Koniec rezerwacji nie może poprzedzać terminu gotowości ani dzisiejszego dnia. Podaj poprawną datę.",
      );
    draft.reservationUntil = value;
  }
  if (!state.records.case) return cases();
  if (!state.records.asset) return assets();
  const person = broker.resolve(turn, state.records.person.ref, "person");
  const episode = broker.resolve(turn, state.records.episode.ref, "episode");
  const caseRecord = broker.resolve(turn, state.records.case.ref, "case");
  const asset = broker.resolve(turn, state.records.asset.ref, "asset");
  const profile = broker.resolve(turn, company.ref, "company");
  if (episode.personId !== person.id)
    throw new DomainError(
      "CONTEXT_RELATION_MISMATCH",
      "Osoba i okres współpracy nie są powiązane.",
      409,
    );
  if (
    draft.reservationUntil < draft.readyOn ||
    draft.reservationUntil < equipmentDate("dziś", timezone, now)!
  )
    return ask(
      "reservationUntil",
      "Termin rezerwacji wymaga aktualizacji. Podaj datę nie wcześniejszą niż gotowość i dzisiejszy dzień.",
    );
  const input = actionSchemas.assets.reserve!.parse({
    id: asset.id,
    expectedVersion: asset.version,
    personId: person.id,
    employmentEpisodeId: episode.id,
    expectedEpisodeVersion: episode.version,
    caseId: caseRecord.id,
    profileVersion: profile.version,
    purpose: `Sprzęt gotowy na ${draft.readyOn}; rezerwacja do ${draft.reservationUntil}.`,
    until: draft.reservationUntil,
  }) as JsonObject;
  draft.phase = "ready_to_plan";
  draft.missingFields = [];
  delete draft.clarification;
  state.candidates = [];
  return result(
    "Przygotowałem plan rezerwacji wskazanego sprzętu. Rezerwacja nastąpi dopiero po uruchomieniu planu i zatwierdzeniu dokładnej operacji.",
    "ready",
    {
      title: `Rezerwacja sprzętu dla ${draft.person!.label}`.slice(0, 160),
      summary: `Gotowość: ${draft.readyOn}. Koniec rezerwacji: ${draft.reservationUntil}. Plan rezerwuje wskazany sprzęt teraz; wydanie i odbiór wymagają odrębnego potwierdzenia.`,
      steps: [
        {
          id: "reserve_equipment",
          title: "Zarezerwuj wybrany sprzęt",
          toolId: "ops.assets.reserve",
          input,
        },
      ],
    },
  );
}
