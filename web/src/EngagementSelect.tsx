import { useState } from "react";
import { useResource } from "./hooks";
import type { Entity } from "./types";

export type EngagementReference = { module: "sales" | "cases"; id: string };
export function agreedEngagementOptions(records: Entity[]) {
  return records
    .filter((record) =>
      record.module === "cases"
        ? record.data.caseType === "delivery" &&
          ["open", "awaiting_acceptance", "accepted"].includes(record.status)
        : record.module === "sales" &&
          ((record.data.kind === "offer" &&
            ["accepted", "handed_over"].includes(record.status)) ||
            (record.data.kind === "deal" && record.status === "won")),
    )
    .map((record) => ({
      key: `${record.module}:${record.id}`,
      reference: { module: record.module as "sales" | "cases", id: record.id },
      label: `${record.title} · ${record.module === "cases" ? "Realizacja" : record.data.kind === "offer" ? "Zaakceptowana oferta" : "Wygrana szansa"}`,
    }));
}
export function EngagementSelect({
  value,
  disabled,
  onSelect,
}: {
  value: unknown;
  disabled: boolean;
  onSelect: (reference: EngagementReference | undefined) => void;
}) {
  const [revision, setRevision] = useState(0);
  const cases = useResource<{ items: Entity[] }>(
    "/api/workspace/cases",
    revision,
  );
  const sales = useResource<{ items: Entity[] }>(
    "/api/workspace/sales",
    revision,
  );
  const loading = cases.loading || sales.loading;
  const options = agreedEngagementOptions([
    ...(cases.error ? [] : (cases.data?.items ?? [])),
    ...(sales.error ? [] : (sales.data?.items ?? [])),
  ]);
  const reference =
    value && typeof value === "object"
      ? (value as Partial<EngagementReference>)
      : undefined;
  const selected = options.find(
    (option) =>
      option.reference.module === reference?.module &&
      option.reference.id === reference?.id,
  );
  return (
    <div className="field wide" aria-busy={loading}>
      <label htmlFor="field-engagementRef">Uzgodniony projekt lub oferta</label>
      <select
        id="field-engagementRef"
        disabled={disabled || loading}
        value={selected?.key ?? ""}
        onChange={(event) =>
          onSelect(
            options.find((option) => option.key === event.target.value)
              ?.reference,
          )
        }
      >
        <option value="">
          {loading
            ? "Pobieranie dostępnych projektów…"
            : "Bez powiązania / wybierz projekt…"}
        </option>
        {options.map((option) => (
          <option value={option.key} key={option.key}>
            {option.label}
          </option>
        ))}
      </select>
      <small>
        Przy równoległych projektach konsultanta powiązanie jest wymagane. Każda
        otwarta współpraca musi dotyczyć innego uzgodnionego projektu.
      </small>
      {(cases.error || sales.error) && (
        <p className="small" role="status">
          Część projektów jest niedostępna. Lista zawiera tylko rekordy, które
          udało się odczytać z Twoimi uprawnieniami.
        </p>
      )}
      {!loading && !options.length && (
        <p className="small muted">
          Brak uzgodnionych projektów. Najpierw zaakceptuj ofertę, oznacz szansę
          jako wygraną lub przygotuj sprawę realizacji.
        </p>
      )}
      <button
        type="button"
        className="text-button"
        disabled={disabled || loading}
        onClick={() => {
          onSelect(undefined);
          setRevision((value) => value + 1);
        }}
      >
        Odśwież projekty
      </button>
    </div>
  );
}
