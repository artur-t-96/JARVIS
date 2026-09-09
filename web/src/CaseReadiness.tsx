import { useState, type FormEvent } from "react";
import { post, requestKey } from "./api";
import { errorMessage, navigate, useResource } from "./hooks";
import {
  dateLabel,
  statusLabel,
  type Context,
  type Entity,
  type Run,
} from "./types";
import { Empty, Icon, Loading, Notice, Sheet } from "./ui";
import { PurchaseForm } from "./Purchasing";
import type { DeliveryView } from "./PurchaseDeliveries";

export type RequirementKind =
  | "asset_issued"
  | "document_approved"
  | "access_attested"
  | "delivery_received"
  | "test_passed";
export interface CaseRequirement {
  id: string;
  kind: RequirementKind;
  title: string;
  required: boolean;
  status: "satisfied" | "missing" | "stale" | "failed" | "exception";
  reason: string;
  nextAction: string;
  source?: {
    module: string;
    id: string;
    title: string;
    version: number;
    hash: string;
    observedAt: string;
    runId?: string;
  };
}
export interface Readiness {
  caseId: string;
  scopeRevision: number;
  scopeHash: string;
  bindingsHash: string;
  ready: boolean;
  acceptanceCurrent: boolean;
  requirements: CaseRequirement[];
  taskBlockers?: string[];
}
const kinds: Record<
  RequirementKind,
  { label: string; icon: string; module?: string }
> = {
  asset_issued: { label: "Wydany sprzęt", icon: "assets", module: "assets" },
  document_approved: {
    label: "Zaakceptowany dokument",
    icon: "documents",
    module: "documents",
  },
  access_attested: { label: "Potwierdzony dostęp", icon: "licenses" },
  delivery_received: {
    label: "Przyjęta dostawa",
    icon: "purchases",
    module: "purchases",
  },
  test_passed: { label: "Potwierdzony wynik testu", icon: "pulse" },
};
const states = {
  satisfied: "Potwierdzone",
  missing: "Brakuje",
  stale: "Wymaga ponownego sprawdzenia",
  failed: "Warunek niespełniony",
  exception: "Wyjątek do sprawdzenia",
};

export function ReadinessCard({
  readiness,
  onBind,
  historical = false,
  onPurchase,
}: {
  readiness: Readiness;
  onBind?: (requirement: CaseRequirement) => void;
  historical?: boolean;
  onPurchase?: (requirement: CaseRequirement) => void;
}) {
  const sorted = [...readiness.requirements].sort(
    (a, b) =>
      Number(a.status === "satisfied") - Number(b.status === "satisfied"),
  );
  return (
    <section className="card readiness-card" aria-label="Gotowość do odbioru">
      <div className="card-heading">
        <div>
          <span className="eyebrow">
            ODBIÓR BIZNESOWY · ZAKRES {readiness.scopeRevision}
          </span>
          <h2>
            {historical
              ? "Historia warunków odbioru"
              : readiness.ready
                ? "Warunki gotowości potwierdzone"
                : "Co blokuje odbiór"}
          </h2>
          <p>
            {historical
              ? "Sprawa jest anulowana. Powiązane źródła pokazują obecny stan dowodów; nie wymagają dalszej pracy w tej sprawie."
              : readiness.acceptanceCurrent
                ? "Odbiór odpowiada aktualnym warunkom i dowodom."
                : readiness.ready
                  ? "Uprawniona osoba może teraz ocenić i odebrać tę rewizję."
                  : "Uzupełnij właściwe rezultaty przed przekazaniem sprawy do odbioru."}
          </p>
        </div>
        {!historical && (
          <span
            className={`readiness-indicator ${readiness.ready ? "confirmed" : "attention"}`}
          >
            <Icon name={readiness.ready ? "check" : "alert"} size={18} />
            {readiness.ready ? "Gotowe do oceny" : "Odbiór zablokowany"}
          </span>
        )}
      </div>
      {!historical && (readiness.taskBlockers ?? []).length > 0 && (
        <div className="readiness-task-blockers">
          <strong>Praca do zakończenia</strong>
          <ul>
            {readiness.taskBlockers!.map((reason, index) => (
              <li key={index}>{reason}</li>
            ))}
          </ul>
        </div>
      )}
      {sorted.length ? (
        <div className="requirement-list">
          {sorted.map((requirement) => {
            const kind = kinds[requirement.kind];
            return (
              <article className="requirement-row" key={requirement.id}>
                <span
                  className={`requirement-symbol ${requirement.status === "satisfied" ? "confirmed" : "attention"}`}
                >
                  <Icon name={kind?.icon ?? "shield"} size={20} />
                </span>
                <div className="requirement-body">
                  <div className="task-heading">
                    <div>
                      <span className="small muted">
                        {kind?.label ?? "Warunek odbioru"} ·{" "}
                        {requirement.required ? "wymagane" : "opcjonalne"}
                      </span>
                      <h3>{requirement.title}</h3>
                    </div>
                    <span className={`requirement-state ${requirement.status}`}>
                      {states[requirement.status] ?? "Stan niepotwierdzony"}
                    </span>
                  </div>
                  <p>{requirement.reason}</p>
                  {!historical &&
                    requirement.status !== "satisfied" &&
                    requirement.nextAction && (
                      <p className="requirement-next">
                        <strong>Następny krok:</strong> {requirement.nextAction}
                      </p>
                    )}
                  {requirement.source ? (
                    <details className="requirement-source">
                      <summary>
                        Źródło: {requirement.source.title} · wersja{" "}
                        {requirement.source.version}
                      </summary>
                      <dl>
                        <div>
                          <dt>Odczytano</dt>
                          <dd>
                            {dateLabel(requirement.source.observedAt, true)}
                          </dd>
                        </div>
                        <div>
                          <dt>Skrót treści</dt>
                          <dd>
                            <code>{requirement.source.hash}</code>
                          </dd>
                        </div>
                      </dl>
                      <button
                        className="text-button"
                        onClick={() =>
                          navigate(
                            requirement.source!.runId
                              ? `runs/${encodeURIComponent(requirement.source!.runId)}`
                              : `module/${encodeURIComponent(requirement.source!.module)}/${encodeURIComponent(requirement.source!.id)}`,
                          )
                        }
                      >
                        Otwórz źródło <Icon name="arrow" size={14} />
                      </button>
                    </details>
                  ) : (
                    <p className="small muted">
                      {!historical && requirement.kind === "access_attested"
                        ? "Poświadcz wszystkie pozycje zestawu i powiąż dowód w sekcji dostępów tej sprawy."
                        : "Brak dostępnego powiązania źródłowego."}
                    </p>
                  )}
                  {!historical && onBind && kind?.module && (
                    <button
                      className="button secondary"
                      onClick={() => onBind(requirement)}
                    >
                      {requirement.source
                        ? "Zmień powiązane źródło"
                        : "Wskaż źródło"}
                      <Icon name="arrow" size={15} />
                    </button>
                  )}
                  {!historical &&
                    onPurchase &&
                    ["asset_issued", "delivery_received"].includes(
                      requirement.kind,
                    ) &&
                    requirement.status !== "satisfied" && (
                      <button
                        className="button secondary"
                        onClick={() => onPurchase(requirement)}
                      >
                        Przygotuj zapotrzebowanie
                      </button>
                    )}
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <Empty title="Brak typowanych wymagań">
          Sam opis zakresu ani dawny protokół nie potwierdza gotowości nowego
          onboardingu.
        </Empty>
      )}
      <p className="small muted readiness-explanation">
        Zgoda na zapis pozwala wykonać konkretną operację. Gotowość wynika z
        aktualnych źródeł, a odbiór sprawy jest osobną decyzją człowieka.
      </p>
    </section>
  );
}

export function issuedProofChoices(item: Entity, asset?: Entity) {
  const rows = Array.isArray(asset?.data.allocations)
    ? asset.data.allocations
    : [];
  return rows.filter(
    (row): row is Record<string, unknown> =>
      !!row &&
      typeof row === "object" &&
      !Array.isArray(row) &&
      row.status === "issued" &&
      row.provenance === "p05" &&
      typeof row.id === "string" &&
      typeof row.issueEventId === "string" &&
      row.caseId === item.id &&
      (!item.data.personId || row.personId === item.data.personId) &&
      (!item.data.employmentEpisodeId ||
        row.employmentEpisodeId === item.data.employmentEpisodeId),
  );
}

function BindingForm({
  item,
  requirement,
  onClose,
}: {
  item: Entity;
  requirement: CaseRequirement;
  onClose: () => void;
}) {
  const module = kinds[requirement.kind]?.module;
  const resource = useResource<{ items: Entity[] }>(
    module ? `/api/workspace/${module}` : null,
  );
  const [sourceId, setSourceId] = useState("");
  const [allocationId, setAllocationId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [key] = useState(requestKey);
  const source = resource.data?.items.find(
    (candidate) => candidate.id === sourceId,
  );
  const delivery = useResource<{ deliveries: DeliveryView }>(
    module === "purchases" && source
      ? `/api/purchases/${source.id}/deliveries`
      : null,
  );
  const deliveryProof = delivery.data?.deliveries.proof;
  const deliveryMatches =
    deliveryProof?.identity.current === true &&
    deliveryProof.identity.caseId === item.id &&
    deliveryProof.identity.caseScopeRevision === item.data.scopeRevision;
  const issueChoices = issuedProofChoices(item, source);
  const issue = issueChoices.find((entry) => entry.id === allocationId);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (
      !source ||
      !module ||
      (module === "assets" && !issue) ||
      (module === "purchases" && !deliveryMatches)
    )
      return;
    setBusy(true);
    setError("");
    try {
      const { run } = await post<{ run: Run }>("/api/commands", {
        toolId: "ops.cases.bindEvidence",
        input: {
          id: item.id,
          expectedVersion: item.version,
          requirementId: requirement.id,
          sourceModule: module,
          sourceId: source.id,
          sourceVersion:
            module === "purchases" ? deliveryProof!.version : source.version,
          ...(module === "purchases"
            ? { sourceProofHash: deliveryProof!.hash }
            : {}),
          ...(module === "assets" && issue
            ? { allocationId: issue.id, issueEventId: issue.issueEventId }
            : {}),
        },
        idempotencyKey: key,
      });
      onClose();
      navigate(`runs/${run.id}`);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet
      title="Wskaż źródło potwierdzenia"
      subtitle={requirement.title}
      onClose={onClose}
    >
      <form className="command-form" onSubmit={submit}>
        <div className="sheet-body">
          {error && <Notice tone="error">{error}</Notice>}
          {resource.error && <Notice tone="error">{resource.error}</Notice>}
          <p>
            Powiąż istniejący rekord z tym wymaganiem. JARVIS sprawdzi jego
            rzeczywisty stan, osobę, współpracę i wersję.
          </p>
          <label className="field">
            <span>
              {module === "assets"
                ? "Sprzęt"
                : module === "purchases"
                  ? "Zamówienie z poświadczoną dostawą"
                  : "Dokument"}
            </span>
            <select
              required
              disabled={busy || resource.loading || !!resource.error}
              value={sourceId}
              onChange={(event) => {
                setSourceId(event.target.value);
                setAllocationId("");
              }}
            >
              <option value="">Wybierz dostępny rekord…</option>
              {resource.data?.items
                .filter(
                  (entry) =>
                    module !== "purchases" || entry.data.kind === "order",
                )
                .map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.title} · {statusLabel(entry.status)} · wersja{" "}
                    {entry.version}
                  </option>
                ))}
            </select>
          </label>
          {module === "purchases" && source && (
            <Notice>
              {delivery.error ||
                (delivery.loading
                  ? "Sprawdzam przyjęcie dostawy…"
                  : deliveryMatches
                    ? "Właściwa dostawa jest kompletna i nie ma otwartych rozbieżności."
                    : "Brak kompletnego poświadczenia dla bieżącego zakresu tej sprawy.")}
            </Notice>
          )}
          {module === "assets" && source && (
            <label className="field">
              <span>Poświadczone wydanie dla tej sprawy</span>
              <select
                required
                disabled={busy || !issueChoices.length}
                value={allocationId}
                onChange={(event) => setAllocationId(event.target.value)}
              >
                <option value="">Wybierz konkretne wydanie…</option>
                {issueChoices.map((entry) => (
                  <option key={String(entry.id)} value={String(entry.id)}>
                    Wydano {dateLabel(String(entry.issuedOn))} ·{" "}
                    {String(source.data.serial ?? source.title)}
                  </option>
                ))}
              </select>
              {!issueChoices.length && (
                <Notice>
                  Brak aktualnego poświadczenia wydania tego sprzętu dla osoby,
                  współpracy i zakresu tej sprawy. Rezerwacja oraz historyczny
                  wpis bez autora nie są dowodem wydania.
                </Notice>
              )}
            </label>
          )}
          {!resource.loading &&
            !resource.error &&
            !resource.data?.items.length && (
              <Notice>
                Brak dostępnych źródeł w tym obszarze. Najpierw przygotuj
                właściwy rekord.
              </Notice>
            )}
          <p className="small muted">
            Samo powiązanie źródła nie oznacza spełnienia wymagania. Zapis
            będzie wymagał sprawdzenia planu i zgody.
          </p>
        </div>
        <div className="sheet-footer">
          <button
            type="button"
            className="button secondary"
            onClick={onClose}
            disabled={busy}
          >
            Anuluj
          </button>
          <button
            className="button primary"
            type="submit"
            disabled={
              busy ||
              !source ||
              !!resource.error ||
              (module === "assets" && !issue) ||
              (module === "purchases" && !deliveryMatches)
            }
          >
            {busy ? "Przygotowywanie…" : "Przygotuj powiązanie"}
          </button>
        </div>
      </form>
    </Sheet>
  );
}

export function CaseReadiness({
  item,
  context,
  revision,
}: {
  item: Entity;
  context: Context;
  revision: number;
}) {
  const resource = useResource<{ readiness: Readiness }>(
    `/api/cases/${encodeURIComponent(item.id)}/readiness`,
    revision + item.version,
    7000,
  );
  const [binding, setBinding] = useState<CaseRequirement | null>(null);
  const [purchase, setPurchase] = useState<CaseRequirement | null>(null);
  const allowed =
    item.status !== "cancelled" &&
    context.principal.roles.includes("operator") &&
    context.tools.some((tool) => tool.id === "ops.cases.bindEvidence");
  if (resource.error)
    return (
      <Notice tone="error">
        Nie można potwierdzić gotowości: {resource.error}
      </Notice>
    );
  if (!resource.data) return <Loading />;
  return (
    <>
      {purchase && (
        <PurchaseForm
          mode="create"
          context={context}
          sourceCase={item}
          sourceRequirementId={purchase.id}
          onClose={() => setPurchase(null)}
        />
      )}
      {binding && (
        <BindingForm
          item={item}
          requirement={binding}
          onClose={() => setBinding(null)}
        />
      )}
      <ReadinessCard
        readiness={resource.data.readiness}
        historical={item.status === "cancelled"}
        onBind={allowed ? setBinding : undefined}
        onPurchase={
          allowed &&
          ["open", "needs_changes"].includes(item.status) &&
          context.tools.some((t) => t.id === "ops.purchases.create")
            ? setPurchase
            : undefined
        }
      />
    </>
  );
}
