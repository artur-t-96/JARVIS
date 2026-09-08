import { useState } from "react";
import type {
  OnboardingVariant,
  OnboardingVariants,
} from "../../src/onboarding-profile";
import type { CaseRequirementDefinition } from "../../src/case-readiness";
import type { Entity } from "./types";
import { useResource } from "./hooks";
import { Notice } from "./ui";

const labels = {
  internal: "Pracownik wewnętrzny",
  contractor: "Konsultant klienta",
};
const roles = { hr: "HR", it: "IT", manager: "Przełożony" };
type AssetType = Extract<
  CaseRequirementDefinition,
  { kind: "asset_issued" }
>["expected"]["assetType"];
type DocumentType = Extract<
  CaseRequirementDefinition,
  { kind: "document_approved" }
>["expected"]["documentType"];
type TaskRole = OnboardingVariant["tasks"][number]["assigneeRole"];
const assetLabels = {
  laptop: "Laptop",
  phone: "Telefon",
  monitor: "Monitor",
  other: "Inny sprzęt",
};
const documentLabels = {
  contract: "Umowa",
  policy: "Procedura",
  report: "Raport",
  other: "Inny dokument",
  offer: "Oferta",
};
function requirementSummary(r: CaseRequirementDefinition): string {
  if (r.kind === "asset_issued")
    return r.expected.assetType
      ? assetLabels[r.expected.assetType]
      : "Dowolny uzgodniony sprzęt";
  if (r.kind === "document_approved")
    return `${documentLabels[r.expected.documentType]} · aktualna zaakceptowana wersja${r.expected.fileRequired ? " · oryginał pliku" : ""}`;
  if (r.kind === "access_attested")
    return `${r.expected.accessKey} · ${r.expected.bundleId ? `zestaw w wersji ${r.expected.bundleVersion}` : "zestaw do wskazania w sprawie"}`;
  return "";
}
export function OnboardingVariantsSummary({
  variants,
}: {
  variants: OnboardingVariants;
}) {
  return (
    <div className="onboarding-variants-summary">
      {(["internal", "contractor"] as const).map((kind) => (
        <details key={kind} className="onboarding-variant">
          <summary>{labels[kind]} — onboarding</summary>
          <h4>Wymagane rezultaty</h4>
          <ul>
            {variants[kind].requirements.map((r) => (
              <li key={r.key}>
                {r.title} · {r.required ? "wymagane" : "opcjonalne"}
                {` · ${requirementSummary(r)}`}
              </li>
            ))}
          </ul>
          <h4>Praca ludzi</h4>
          <ol>
            {variants[kind].tasks.map((task) => (
              <li key={task.key}>
                {task.title} · {roles[task.assigneeRole]} · {task.offsetDays}{" "}
                dni od startu
                {task.dependsOn.length
                  ? ` · po: ${task.dependsOn.map((key) => variants[kind].tasks.find((t) => t.key === key)?.title ?? key).join(", ")}`
                  : ""}
              </li>
            ))}
          </ol>
        </details>
      ))}
    </div>
  );
}

export function OnboardingVariantsEditor({
  variants,
  onChange,
  canReadIT,
  busy,
}: {
  variants: OnboardingVariants;
  onChange: (next: OnboardingVariants) => void;
  canReadIT: boolean;
  busy: boolean;
}) {
  const [kind, setKind] = useState<keyof OnboardingVariants>("internal");
  const source = useResource<{ items: Entity[] }>(
    canReadIT ? "/api/workspace/it" : null,
  );
  const bundles =
    source.data?.items.filter(
      (r) => r.data.kind === "access_bundle" && r.status === "active",
    ) ?? [];
  const variant = variants[kind];
  const update = (patch: Partial<OnboardingVariant>) =>
    onChange({ ...variants, [kind]: { ...variant, ...patch } });
  const requirement = (index: number, next: CaseRequirementDefinition) =>
    update({
      requirements: variant.requirements.map((r, i) =>
        i === index ? next : r,
      ),
    });
  const task = (
    index: number,
    patch: Partial<OnboardingVariant["tasks"][number]>,
  ) =>
    update({
      tasks: variant.tasks.map((t, i) =>
        i === index ? { ...t, ...patch } : t,
      ),
    });
  return (
    <section aria-label="Warianty onboardingu">
      <label className="field">
        <span>Konfiguracja onboardingu</span>
        <select
          value={kind}
          disabled={busy}
          onChange={(e) => setKind(e.target.value as keyof OnboardingVariants)}
        >
          {Object.entries(labels).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <h3>{labels[kind]} — warunki odbioru</h3>
      <p className="small muted">
        Każdy wariant wymaga dokumentu, wydanego sprzętu i poświadczonych
        dostępów. Konkretną osobę oraz dowody przypisuje się w jej sprawie.
      </p>
      {source.error && (
        <Notice>
          Nie udało się odczytać zestawów dostępów. Zapisane wskazania pozostają
          w formularzu.
        </Notice>
      )}
      {!canReadIT && (
        <p className="small muted">
          Wybór zestawu dostępów wymaga obszaru IT. Istniejące wskazania
          pozostają zachowane.
        </p>
      )}
      {variant.requirements.map((r, i) => (
        <div className="nested-entry" key={`${kind}-${r.key}`}>
          <label className="field">
            <span>Nazwa warunku {i + 1}</span>
            <input
              required
              maxLength={200}
              disabled={busy}
              value={r.title}
              onChange={(e) => requirement(i, { ...r, title: e.target.value })}
            />
          </label>
          {r.kind === "asset_issued" && (
            <label className="field">
              <span>Rodzaj wydanego sprzętu</span>
              <select
                value={r.expected.assetType ?? ""}
                disabled={busy}
                onChange={(e) =>
                  requirement(i, {
                    ...r,
                    expected: e.target.value
                      ? { assetType: e.target.value as AssetType }
                      : {},
                  })
                }
              >
                <option value="">Dowolny uzgodniony sprzęt</option>
                <option value="laptop">Laptop</option>
                <option value="phone">Telefon</option>
                <option value="monitor">Monitor</option>
                <option value="other">Inny</option>
              </select>
            </label>
          )}
          {r.kind === "document_approved" && (
            <div className="form-grid">
              <label className="field">
                <span>Rodzaj dokumentu</span>
                <select
                  value={r.expected.documentType}
                  disabled={busy}
                  onChange={(e) =>
                    requirement(i, {
                      ...r,
                      expected: {
                        ...r.expected,
                        documentType: e.target.value as DocumentType,
                      },
                    })
                  }
                >
                  <option value="contract">Umowa</option>
                  <option value="policy">Procedura</option>
                  <option value="report">Raport</option>
                  <option value="other">Inny</option>
                  <option value="offer">Oferta</option>
                </select>
              </label>
              <label className="checkbox-field">
                <input
                  type="checkbox"
                  disabled={busy}
                  checked={r.expected.fileRequired ?? false}
                  onChange={(e) =>
                    requirement(i, {
                      ...r,
                      expected: {
                        ...r.expected,
                        fileRequired: e.target.checked,
                      },
                    })
                  }
                />
                Wymagany oryginał pliku
              </label>
            </div>
          )}
          {r.kind === "access_attested" && (
            <div className="form-grid">
              <label className="field">
                <span>Klucz wymaganego dostępu</span>
                <input
                  required
                  pattern="[a-z][a-z0-9_.-]{0,79}"
                  maxLength={80}
                  disabled={busy || !!r.expected.bundleId}
                  value={r.expected.accessKey}
                  onChange={(e) =>
                    requirement(i, {
                      ...r,
                      expected: { accessKey: e.target.value },
                    })
                  }
                />
              </label>
              <label className="field">
                <span>Zestaw dostępów</span>
                <select
                  disabled={
                    busy || !canReadIT || source.loading || !!source.error
                  }
                  value={
                    r.expected.bundleId
                      ? `${r.expected.bundleId}:${r.expected.bundleVersion}`
                      : ""
                  }
                  onChange={(e) => {
                    const bundle = bundles.find(
                      (b) => `${b.id}:${b.version}` === e.target.value,
                    );
                    requirement(i, {
                      ...r,
                      expected: bundle
                        ? {
                            accessKey: String(bundle.data.accessKey),
                            bundleId: bundle.id,
                            bundleVersion: bundle.version,
                          }
                        : { accessKey: r.expected.accessKey },
                    });
                  }}
                >
                  <option value="">Do wskazania w konkretnej sprawie</option>
                  {r.expected.bundleId &&
                    !bundles.some(
                      (b) =>
                        b.id === r.expected.bundleId &&
                        b.version === r.expected.bundleVersion,
                    ) && (
                      <option
                        value={`${r.expected.bundleId}:${r.expected.bundleVersion}`}
                      >
                        Zapisane wskazanie · wersja {r.expected.bundleVersion} ·
                        aktualność do sprawdzenia
                      </option>
                    )}
                  {bundles.map((b) => (
                    <option value={`${b.id}:${b.version}`} key={b.id}>
                      {b.title} · wersja {b.version}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
        </div>
      ))}
      <details className="template-editor">
        <summary>{labels[kind]} — zadania i terminy</summary>
        {variant.tasks.map((t, i) => (
          <div className="nested-entry" key={`${kind}-${t.key}`}>
            <label className="field">
              <span>Zadanie {i + 1}</span>
              <input
                required
                maxLength={200}
                disabled={busy}
                value={t.title}
                onChange={(e) => task(i, { title: e.target.value })}
              />
            </label>
            <div className="form-grid">
              <label className="field">
                <span>Rola wykonawcy</span>
                <select
                  value={t.assigneeRole}
                  disabled={busy}
                  onChange={(e) =>
                    task(i, { assigneeRole: e.target.value as TaskRole })
                  }
                >
                  {Object.entries(roles).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Dni od daty startu</span>
                <input
                  type="number"
                  min={-365}
                  max={365}
                  required
                  disabled={busy}
                  value={t.offsetDays}
                  onChange={(e) =>
                    task(i, { offsetDays: Number(e.target.value) })
                  }
                />
              </label>
            </div>
            <p className="small muted">
              {t.required ? "Zadanie wymagane" : "Zadanie opcjonalne"} ·
              warunki:{" "}
              {t.requirementKeys
                .map(
                  (key) =>
                    variant.requirements.find((r) => r.key === key)?.title ??
                    key,
                )
                .join(", ") || "brak"}
            </p>
            {i > 0 && (
              <fieldset className="dependency-options">
                <legend>Wymagane wcześniejsze zadania</legend>
                {variant.tasks.slice(0, i).map((previous) => (
                  <label className="checkbox-field" key={previous.key}>
                    <input
                      type="checkbox"
                      disabled={busy}
                      checked={t.dependsOn.includes(previous.key)}
                      onChange={(e) =>
                        task(i, {
                          dependsOn: e.target.checked
                            ? [...t.dependsOn, previous.key]
                            : t.dependsOn.filter((key) => key !== previous.key),
                        })
                      }
                    />
                    {previous.title}
                  </label>
                ))}
              </fieldset>
            )}
          </div>
        ))}
      </details>
    </section>
  );
}
