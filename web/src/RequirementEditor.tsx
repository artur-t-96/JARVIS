import { Icon, Notice } from "./ui";
import type { RequirementKind } from "./CaseReadiness";
import { useResource } from "./hooks";
import type { Entity } from "./types";

type RequirementBase = { key: string; title: string; required: boolean };
export type RequirementDefinition = RequirementBase &
  (
    | {
        kind: "asset_issued";
        expected: {
          assetType?: "laptop" | "phone" | "monitor" | "other";
          assetId?: string;
        };
      }
    | {
        kind: "document_approved";
        expected: {
          documentType: "policy" | "contract" | "offer" | "report" | "other";
          documentId?: string;
          documentRevision?: number;
          contentHash?: string;
          currentVersionRequired: true;
          fileRequired?: boolean;
        };
      }
    | {
        kind: "access_attested";
        expected: {
          accessKey: string;
          bundleId?: string;
          bundleVersion?: number;
        };
      }
    | { kind: "delivery_received"; expected: { purchaseId?: string } }
    | { kind: "test_passed"; expected: { testKey: string } }
  );

const labels: Record<RequirementKind, string> = {
  asset_issued: "Wydany sprzęt",
  document_approved: "Zaakceptowany dokument",
  access_attested: "Potwierdzony dostęp",
  delivery_received: "Przyjęta dostawa",
  test_passed: "Pozytywny wynik testu",
};
const defaults: Record<RequirementKind, RequirementDefinition["expected"]> = {
  asset_issued: { assetType: "laptop" },
  document_approved: { documentType: "contract", currentVersionRequired: true },
  access_attested: { accessKey: "workspace" },
  delivery_received: {},
  test_passed: { testKey: "acceptance" },
};

/** Missing definitions must block revision editing; assessments are not definitions. */
export function cloneRequirementDefinitions(
  input: unknown,
): RequirementDefinition[] | null {
  if (!Array.isArray(input) || input.length > 50) return null;
  if (
    !input.every((item) => {
      if (
        !item ||
        typeof item !== "object" ||
        typeof item.key !== "string" ||
        typeof item.title !== "string" ||
        typeof item.required !== "boolean" ||
        !Object.hasOwn(labels, item.kind) ||
        !item.expected ||
        typeof item.expected !== "object" ||
        Array.isArray(item.expected)
      )
        return false;
      switch (item.kind) {
        case "document_approved":
          return (
            typeof item.expected.documentType === "string" &&
            item.expected.currentVersionRequired === true
          );
        case "access_attested":
          return typeof item.expected.accessKey === "string";
        case "test_passed":
          return typeof item.expected.testKey === "string";
        default:
          return true;
      }
    })
  )
    return null;
  return structuredClone(input) as RequirementDefinition[];
}

export function newRequirement(
  kind: RequirementKind,
  existing: RequirementDefinition[],
): RequirementDefinition {
  let suffix = 1;
  while (existing.some((item) => item.key === `warunek-${suffix}`)) suffix += 1;
  return {
    key: `warunek-${suffix}`,
    title: labels[kind],
    kind,
    required: true,
    expected: structuredClone(defaults[kind]),
  } as RequirementDefinition;
}

/** Editing a visible expectation keeps any confirmed source/revision/hash constraints. */
export function updateRequirementExpected(
  item: RequirementDefinition,
  field: string,
  value: unknown,
): RequirementDefinition {
  const expected = { ...item.expected } as Record<string, unknown>;
  if (value === undefined) delete expected[field];
  else expected[field] = value;
  return { ...item, expected } as RequirementDefinition;
}

export function RequirementEditor({
  value,
  onChange,
  disabled = false,
  onboarding = false,
}: {
  value: RequirementDefinition[];
  onChange: (value: RequirementDefinition[]) => void;
  disabled?: boolean;
  onboarding?: boolean;
}) {
  const bundles = useResource<{ items: Entity[] }>(
    value.some((r) => r.kind === "access_attested")
      ? "/api/workspace/it"
      : null,
  );
  const change = (index: number, next: RequirementDefinition) =>
    onChange(value.map((item, i) => (i === index ? next : item)));
  return (
    <section
      className="requirement-editor"
      aria-label="Warunki odbioru nowej rewizji"
    >
      <h3>Warunki odbioru nowej rewizji</h3>
      <p className="small muted">
        Określ oczekiwany rezultat. Dowody ze sprzętu i dokumentów wskażesz po
        zapisaniu rewizji w sekcji gotowości sprawy.
      </p>
      {onboarding && (
        <Notice>
          Onboarding wymaga obowiązkowego sprzętu, dokumentu i dostępu. Zmiana
          zakresu zachowa historię i będzie wymagać nowego odbioru.
        </Notice>
      )}
      {value.map((item, index) => {
        const setExpected = (field: string, next: unknown) =>
          change(index, updateRequirementExpected(item, field, next));
        const pinnedSource = [
          "assetId",
          "documentId",
          "documentRevision",
          "contentHash",
          "purchaseId",
        ].some((field) => Object.hasOwn(item.expected, field));
        return (
          <fieldset
            className="requirement-editor-row"
            key={index}
            disabled={disabled}
          >
            <legend>Warunek {index + 1}</legend>
            <div className="form-grid">
              <label className="field">
                <span>Rodzaj rezultatu</span>
                <select
                  value={item.kind}
                  onChange={(event) => {
                    const kind = event.target.value as RequirementKind;
                    change(index, {
                      ...item,
                      kind,
                      expected: structuredClone(defaults[kind]),
                    } as RequirementDefinition);
                  }}
                >
                  {Object.entries(labels).map(([kind, label]) => (
                    <option key={kind} value={kind}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Klucz warunku</span>
                <input
                  required
                  maxLength={60}
                  pattern="[a-z](?:[a-z0-9_]|-){0,59}"
                  value={item.key}
                  onChange={(event) =>
                    change(index, { ...item, key: event.target.value })
                  }
                />
                <small>
                  Stała nazwa używana w szablonie zadań, np. equipment.
                </small>
              </label>
              <label className="field wide">
                <span>Nazwa warunku</span>
                <input
                  required
                  maxLength={200}
                  value={item.title}
                  onChange={(event) =>
                    change(index, { ...item, title: event.target.value })
                  }
                />
              </label>
              {item.kind === "asset_issued" && (
                <label className="field wide">
                  <span>Oczekiwany rodzaj sprzętu</span>
                  <select
                    value={item.expected.assetType ?? ""}
                    onChange={(event) =>
                      setExpected("assetType", event.target.value || undefined)
                    }
                  >
                    <option value="">Dowolny rodzaj sprzętu</option>
                    <option value="laptop">Laptop</option>
                    <option value="phone">Telefon</option>
                    <option value="monitor">Monitor</option>
                    <option value="other">Inny sprzęt</option>
                  </select>
                </label>
              )}
              {item.kind === "document_approved" && (
                <>
                  <label className="field wide">
                    <span>Oczekiwany rodzaj dokumentu</span>
                    <select
                      value={item.expected.documentType}
                      onChange={(event) =>
                        setExpected("documentType", event.target.value)
                      }
                    >
                      <option value="policy">Procedura lub polityka</option>
                      <option value="contract">Umowa</option>
                      <option value="offer">Oferta</option>
                      <option value="report">Raport</option>
                      <option value="other">Inny dokument</option>
                    </select>
                  </label>
                  <p className="small muted wide">
                    Wymagana jest zatwierdzona i aktualna wersja dokumentu.
                  </p>
                  <label className="field wide checkbox-field">
                    <input
                      type="checkbox"
                      checked={item.expected.fileRequired === true}
                      onChange={(event) =>
                        setExpected("fileRequired", event.target.checked)
                      }
                    />
                    <span>Wymagaj pliku zgodnego z manifestem</span>
                  </label>
                </>
              )}
              {item.kind === "access_attested" && (
                <>
                  <label className="field wide">
                    <span>Wymagany dostęp</span>
                    <input
                      required
                      maxLength={80}
                      pattern="[a-z](?:[a-z0-9_.]|-){0,79}"
                      value={item.expected.accessKey}
                      onChange={(event) =>
                        setExpected("accessKey", event.target.value)
                      }
                    />
                    <small>
                      Nazwa dostępu, np. employee-workspace. Miejsce licencji
                      nie potwierdza nadania dostępu.
                    </small>
                  </label>
                  <label className="field wide">
                    <span>Zatwierdzony zestaw aplikacji i ról</span>
                    <select
                      value={
                        item.expected.bundleId &&
                        bundles.data?.items.some(
                          (b) =>
                            b.id === item.expected.bundleId &&
                            b.version === item.expected.bundleVersion,
                        )
                          ? item.expected.bundleId
                          : ""
                      }
                      onChange={(event) => {
                        const bundle = bundles.data?.items.find(
                          (b) => b.id === event.target.value,
                        );
                        change(index, {
                          ...item,
                          expected: bundle
                            ? {
                                accessKey: String(bundle.data.accessKey),
                                bundleId: bundle.id,
                                bundleVersion: bundle.version,
                              }
                            : { accessKey: item.expected.accessKey },
                        });
                      }}
                    >
                      <option value="">Brak przypisanej konfiguracji</option>
                      {bundles.data?.items
                        .filter(
                          (b) =>
                            b.data.kind === "access_bundle" &&
                            b.status === "active",
                        )
                        .map((b) => (
                          <option key={b.id} value={b.id}>
                            {b.title} · {String(b.data.accessKey)} · wersja{" "}
                            {b.version}
                          </option>
                        ))}
                    </select>
                    <small>
                      {item.expected.bundleId
                        ? `Zapisany zestaw: ${item.expected.bundleId}, wersja ${item.expected.bundleVersion}.`
                        : "Bez zestawu JARVIS pozostawi dostęp jako niepotwierdzony."}
                    </small>
                    {bundles.error && (
                      <Notice>
                        Nie można pobrać katalogu zestawów. Zapisane
                        ograniczenia są zachowane.
                      </Notice>
                    )}
                  </label>
                </>
              )}
              {item.kind === "delivery_received" && (
                <p className="small muted wide">
                  Wymagane niezależne potwierdzenie przyjęcia dostawy. Samo
                  zamówienie nie potwierdza jej odbioru.
                </p>
              )}
              {item.kind === "test_passed" && (
                <label className="field wide">
                  <span>Wymagany test</span>
                  <input
                    required
                    maxLength={80}
                    pattern="[a-z](?:[a-z0-9_.]|-){0,79}"
                    value={item.expected.testKey}
                    onChange={(event) =>
                      setExpected("testKey", event.target.value)
                    }
                  />
                  <small>
                    Nazwa testu, którego pozytywny wynik ma zostać potwierdzony.
                  </small>
                </label>
              )}
              <label className="checkbox-field wide">
                <input
                  type="checkbox"
                  checked={item.required}
                  onChange={(event) =>
                    change(index, { ...item, required: event.target.checked })
                  }
                />
                Wymagany do odbioru sprawy
              </label>
              {pinnedSource && (
                <p className="small muted wide">
                  Ten warunek zachowuje zapisane ograniczenie do konkretnego
                  źródła i jego wersji. Zmiana rodzaju warunku zastąpi
                  dotychczasowe oczekiwania.
                </p>
              )}
            </div>
            <button
              type="button"
              className="text-button requirement-remove"
              onClick={() => onChange(value.filter((_, i) => i !== index))}
            >
              Usuń warunek {index + 1}
            </button>
          </fieldset>
        );
      })}
      {!value.length && (
        <p className="small muted">Brak warunków odbioru w tej rewizji.</p>
      )}
      <button
        type="button"
        className="button secondary"
        disabled={disabled || value.length >= 50}
        onClick={() =>
          onChange([...value, newRequirement("asset_issued", value)])
        }
      >
        <Icon name="plus" size={16} />
        Dodaj warunek odbioru
      </button>
    </section>
  );
}
