import { useState } from "react";
import { download } from "./api";
import { errorMessage, navigate } from "./hooks";
import { dateLabel, displayValue, type Entity } from "./types";
import {
  optionLabel,
  referenceModule,
  rows,
  useReferences,
} from "./references";
import { Badge, Empty, Icon, Notice } from "./ui";
import { AssetCustody } from "./AssetCustody";
import { AssetRegister } from "./AssetRegister";

const sectionLabels: Record<string, string> = {
  worklogs: "Zgłoszona praca i koszty",
  versions: "Wersje dokumentu",
  sources: "Źródła dokumentu",
  actions: "Działania IT",
  seats: "Przydziały licencji",
  evidence: "Dowody zgłoszone przez człowieka",
  acceptances: "Odbiory biznesowe",
  scopeHistory: "Historia zakresu",
  employmentEpisodes: "Okresy współpracy",
  allocations: "Przydziały",
  assignments: "Przydziały licencji",
  revisions: "Wersje dokumentu",
  decisions: "Decyzje",
  history: "Historia",
  deliveries: "Dostawy",
};
const labels: Record<string, string> = {
  description: "Opis",
  minutes: "Liczba minut",
  performedOn: "Dzień pracy",
  amount: "Kwota",
  currency: "Waluta",
  approvedBy: "Zatwierdził",
  module: "Obszar źródła",
  version: "Wersja",
  observedAt: "Odczytano",
  verifiedAt: "Sprawdzono zapis",
  assignedAt: "Przydzielono",
  revokedAt: "Odebrano",
  contentHash: "Odcisk treści",
  contextHash: "Odcisk źródeł i klasyfikacji",
  createdBy: "Autor rewizji",
  title: "Nazwa",
  note: "Notatka",
  reference: "Źródło / odnośnik",
  reportedBy: "Zgłosił",
  createdAt: "Data",
  kind: "Rodzaj",
  revision: "Wersja",
  scopeRevision: "Wersja zakresu",
  brief: "Zakres",
  acceptanceCriteria: "Kryteria odbioru",
  reason: "Powód",
  decision: "Decyzja",
  decidedBy: "Decyzję podjął",
  status: "Stan",
  role: "Rola",
  startDate: "Od",
  endDate: "Do",
  personId: "Osoba",
  assigneeId: "Odpowiedzialny",
  issuedOn: "Wydano",
  returnedOn: "Zwrócono",
  reservedUntil: "Rezerwacja do",
  content: "Treść",
  evidenceNote: "Potwierdzenie",
  completedBy: "Potwierdził",
  completedAt: "Potwierdzono",
  humanConfirmed: "Potwierdzenie człowieka",
  quantity: "Liczba",
  quantityReceived: "Otrzymana liczba",
  receivedOn: "Otrzymano",
};

export function RecordDownload({ item }: { item: Entity }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [format, setFormat] = useState("pdf");
  if (!["cases", "documents"].includes(item.module)) return null;
  async function save() {
    setBusy(true);
    setError("");
    try {
      await download(
        item.module === "cases"
          ? `/api/cases/${item.id}/package`
          : `/api/documents/${item.id}/export?format=${format}`,
        `${item.module === "cases" ? "sprawa" : "dokument"}-${item.id}.${item.module === "cases" ? "json" : format}`,
      );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card export-card">
      {item.module === "documents" && (
        <label className="field">
          <span>Format dokumentu</span>
          <select
            value={format}
            disabled={busy}
            onChange={(event) => setFormat(event.target.value)}
          >
            <option value="pdf">PDF — do przekazania</option>
            <option value="docx">DOCX — do pracy z treścią</option>
            <option value="md">Markdown — zapis tekstowy</option>
          </select>
        </label>
      )}
      <button
        className="button secondary full-width"
        disabled={
          busy || (item.module === "cases" && item.status !== "accepted")
        }
        onClick={() => void save()}
      >
        <Icon name="documents" size={17} />
        {busy
          ? "Przygotowywanie…"
          : item.module === "cases"
            ? "Pobierz pakiet audytowy"
            : "Pobierz dokument"}
      </button>
      {error && <Notice tone="error">{error}</Notice>}
      <p className="small muted">
        {item.module === "cases"
          ? "Pakiet jest dostępny po biznesowym odbiorze sprawy. Obejmuje zakres, zadania, dowody i decyzje."
          : "Eksport bieżącej rewizji zachowuje treść, status odbioru i rejestr źródeł. Oryginalne załączniki pobierzesz z sekcji plików."}
      </p>
    </section>
  );
}

export function EntityContent({
  item,
  onAction,
  allowedTool,
  hideTasks = false,
  canReadPurchases = false,
}: {
  item: Entity;
  onAction: (action: string, values?: Record<string, unknown>) => void;
  allowedTool: (action: string) => boolean;
  hideTasks?: boolean;
  canReadPurchases?: boolean;
}) {
  const tasks = rows(item.data.tasks);
  const refs = useReferences(
    [{ key: "personId", label: "Osoba", type: "text" }],
    item,
  );
  const renderValue = (key: string, value: unknown) =>
    referenceModule[key] ? (
      refs.label(key, value)
    ) : key === "status" ? (
      <Badge status={String(value)} />
    ) : ["kind", "decision"].includes(key) ? (
      optionLabel(String(value))
    ) : /(?:At|Date|On|Until)$/.test(key) ? (
      dateLabel(String(value), key.endsWith("At"))
    ) : (
      displayValue(value)
    );
  const links = [
    "onboardingCaseId",
    "offboardingCaseId",
    "handoffCaseId",
    "deliveryCaseId",
  ].filter((key) => typeof item.data[key] === "string");
  return (
    <div className="record-content">
      {item.module === "assets" && (
        <AssetRegister
          key={`register-${item.id}`}
          item={item}
          canReadPurchases={canReadPurchases}
        />
      )}
      {item.module === "assets" && (
        <AssetCustody
          key={item.id}
          item={item}
          onAction={onAction}
          allowedTool={allowedTool}
        />
      )}
      {item.data.settlementDraft != null &&
        typeof item.data.settlementDraft === "object" && (
          <SettlementDraft
            value={item.data.settlementDraft as Record<string, unknown>}
          />
        )}
      {links.length > 0 && (
        <section className="card">
          <div className="card-heading">
            <h2>Powiązane sprawy</h2>
          </div>
          {links.map((key) => (
            <button
              className="action-row"
              key={key}
              onClick={() => navigate(`module/cases/${String(item.data[key])}`)}
            >
              <span>
                {
                  (
                    {
                      onboardingCaseId: "Sprawa onboardingu",
                      offboardingCaseId: "Sprawa offboardingu",
                      handoffCaseId: "Przekazanie do realizacji",
                      deliveryCaseId: "Sprawa realizacji",
                    } as Record<string, string>
                  )[key]
                }
              </span>
              <Icon name="arrow" size={17} />
            </button>
          ))}
        </section>
      )}
      {item.module === "cases" && !hideTasks && (
        <section className="card">
          <div className="card-heading">
            <div>
              <h2>Zadania i zależności</h2>
              <p>
                Zakres {displayValue(item.data.scopeRevision)} ·{" "}
                {tasks.filter((task) => task.status === "completed").length} z{" "}
                {tasks.length} ukończonych
              </p>
            </div>
            {allowedTool("addTask") && (
              <button
                className="button secondary"
                onClick={() => onAction("addTask")}
              >
                <Icon name="plus" size={16} />
                Dodaj zadanie
              </button>
            )}
          </div>
          {tasks.length ? (
            <div className="nested-records">
              {tasks.map((task) => {
                const dependencies = Array.isArray(task.dependsOn)
                  ? task.dependsOn.map(String)
                  : [];
                const blocked = dependencies.some(
                  (id) =>
                    !tasks.some(
                      (candidate) =>
                        candidate.id === id && candidate.status === "completed",
                    ),
                );
                return (
                  <article className="nested-entry" key={String(task.id)}>
                    <div className="task-heading">
                      <div>
                        <h3>{String(task.title)}</h3>
                        <div className="heading-meta">
                          <Badge status={String(task.status)} />
                          <span>
                            {task.required
                              ? "Wymagane do odbioru"
                              : "Opcjonalne"}
                          </span>
                          {!!task.dueDate && (
                            <span>
                              Termin: {dateLabel(String(task.dueDate))}
                            </span>
                          )}
                        </div>
                      </div>
                      {task.status === "open" &&
                        allowedTool("completeTask") && (
                          <button
                            className="button secondary"
                            disabled={blocked}
                            title={
                              blocked
                                ? "Najpierw ukończ zależne zadania"
                                : "Zarejestruj potwierdzenie człowieka"
                            }
                            onClick={() =>
                              onAction("completeTask", { taskId: task.id })
                            }
                          >
                            Potwierdź wykonanie
                          </button>
                        )}
                    </div>
                    {!!task.assigneeId && (
                      <p className="small muted">
                        Odpowiedzialny:{" "}
                        {refs.label("personId", task.assigneeId)}
                      </p>
                    )}
                    {dependencies.length > 0 && (
                      <p className="small muted">
                        Poprzedzają:{" "}
                        {dependencies
                          .map((id) =>
                            String(
                              tasks.find((candidate) => candidate.id === id)
                                ?.title ?? "Zadanie niedostępne",
                            ),
                          )
                          .join(", ")}
                        {blocked ? " · oczekuje na ukończenie" : ""}
                      </p>
                    )}
                    {typeof task.evidenceNote === "string" && (
                      <div className="human-evidence">
                        <span className="eyebrow">POTWIERDZENIE CZŁOWIEKA</span>
                        <p>{task.evidenceNote}</p>
                        <small>
                          {String(task.completedBy ?? "")} ·{" "}
                          {dateLabel(String(task.completedAt ?? ""), true)}
                        </small>
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          ) : (
            <Empty icon="cases" title="Zaplanuj pracę w tej sprawie">
              Dodaj zadania, osoby odpowiedzialne, terminy i wymagane
              poprzedniki.
            </Empty>
          )}
          <p className="small muted">
            Potwierdzenie zadania zapisuje oświadczenie człowieka. Odbiór całej
            sprawy jest osobną decyzją biznesową.
          </p>
        </section>
      )}
      {Object.entries(sectionLabels).map(([key, title]) => {
        if (item.module === "assets" && key === "allocations") return null;
        const entries = rows(item.data[key]);
        if (!entries.length) return null;
        return (
          <section className="card" key={key}>
            <div className="card-heading">
              <h2>{title}</h2>
              <span className="count-bubble">{entries.length}</span>
            </div>
            <div className="nested-records">
              {[...entries].reverse().map((entry, index) => (
                <article
                  className="nested-entry"
                  key={String(entry.id ?? index)}
                >
                  {key === "sources" &&
                    typeof entry.module === "string" &&
                    typeof entry.id === "string" && (
                      <button
                        className="text-button"
                        onClick={() =>
                          navigate(`module/${entry.module}/${entry.id}`)
                        }
                      >
                        Otwórz rekord źródłowy
                        <Icon name="arrow" size={15} />
                      </button>
                    )}
                  <dl className="data-grid">
                    {Object.entries(entry)
                      .filter(
                        ([key, value]) =>
                          key !== "id" &&
                          value !== null &&
                          value !== undefined &&
                          labels[key],
                      )
                      .map(([key, value]) => (
                        <div
                          key={key}
                          className={
                            [
                              "note",
                              "brief",
                              "acceptanceCriteria",
                              "content",
                              "evidenceNote",
                            ].includes(key)
                              ? "wide"
                              : ""
                          }
                        >
                          <dt>{labels[key]}</dt>
                          <dd>{renderValue(key, value)}</dd>
                        </div>
                      ))}
                  </dl>
                </article>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function SettlementDraft({ value }: { value: Record<string, unknown> }) {
  return (
    <section className="card settlement-card">
      <div className="card-heading">
        <div>
          <span className="eyebrow">PRZYGOTOWANIE ROZLICZENIA</span>
          <h2>Szkic po odbiorze sprawy</h2>
        </div>
        <span className="badge neutral">Szkic</span>
      </div>
      <dl className="data-grid">
        <div>
          <dt>Zgłoszony czas</dt>
          <dd>{displayValue(value.declaredMinutes)} min</dd>
        </div>
        <div>
          <dt>Wersja zakresu</dt>
          <dd>{displayValue(value.scopeRevision)}</dd>
        </div>
        <div className="wide">
          <dt>Zgłoszone koszty</dt>
          <dd>
            {rows(value.declaredCosts).length
              ? rows(value.declaredCosts)
                  .map(
                    (cost) =>
                      `${displayValue(cost.amount)} ${String(cost.currency)}`,
                  )
                  .join(" · ")
              : "Brak zgłoszonych kosztów"}
          </dd>
        </div>
      </dl>
      <Notice>
        Szkic opiera się na zgłoszonej pracy i kosztach. Nie stanowi
        zaksięgowania ani wykonanej płatności.
      </Notice>
    </section>
  );
}
