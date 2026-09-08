import { useState, type FormEvent } from "react";
import type { AccessMember } from "../../src/access-models";
import { post, requestKey } from "./api";
import { errorMessage, navigate, useResource } from "./hooks";
import type { Context, Entity, Run } from "./types";
import { Notice, Sheet } from "./ui";

export const isAccessDefinition = (item?: Entity) =>
  item?.module === "it" &&
  ["application", "access_bundle"].includes(String(item.data.kind));
export function AccessDefinitions({
  context,
  item,
}: {
  context: Context;
  item?: Entity;
}) {
  const [kind, setKind] = useState<"application" | "access_bundle" | null>(
    null,
  );
  const canWrite =
    context.principal.roles.includes("operator") &&
    (context.principal.scopes?.includes("*") ||
      context.principal.scopes?.includes("company"));
  if (item && !isAccessDefinition(item)) return null;
  return (
    <section className="card">
      {kind && (
        <DefinitionForm
          kind={kind}
          item={item}
          context={context}
          onClose={() => setKind(null)}
        />
      )}
      <div className="card-heading">
        <h2>{item ? "Definicja dostępu" : "Aplikacje i zestawy dostępów"}</h2>
      </div>
      {item ? (
        <>
          <p>
            Stały klucz:{" "}
            <strong>
              {String(item.data.applicationKey ?? item.data.accessKey)}
            </strong>
          </p>
          {item.data.kind === "application" ? (
            <p>
              Obsługiwane role:{" "}
              {(item.data.supportedRoles as string[]).join(", ")}
            </p>
          ) : (
            <ul>
              {(item.data.members as AccessMember[]).map((m) => (
                <li key={m.key}>
                  {m.key} · rola {m.role} · ważność sprawdzenia {m.validityDays}{" "}
                  dni · aplikacja w wersji {m.applicationVersion}
                  {m.licenseId ? " · wymaga licencji" : ""}
                </li>
              ))}
            </ul>
          )}
          {canWrite && item.status === "active" && (
            <button
              className="button secondary"
              onClick={() =>
                setKind(item.data.kind as "application" | "access_bundle")
              }
            >
              Przygotuj nową wersję definicji
            </button>
          )}
        </>
      ) : (
        <>
          <p className="muted">
            Zdefiniuj aplikacje, wymagane role i zestawy dla procesów firmy.
            Każdą pozycję zestawu potwierdza się osobno dla konkretnej
            współpracy.
          </p>
          {canWrite && (
            <div className="button-group">
              <button
                className="button secondary"
                onClick={() => setKind("application")}
              >
                Dodaj aplikację
              </button>
              <button
                className="button secondary"
                onClick={() => setKind("access_bundle")}
              >
                Dodaj zestaw dostępów
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
function DefinitionForm({
  kind,
  item,
  context,
  onClose,
}: {
  kind: "application" | "access_bundle";
  item?: Entity;
  context: Context;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(item?.title ?? "");
  const [key, setKey] = useState(
    String(item?.data.applicationKey ?? item?.data.accessKey ?? ""),
  );
  const [description, setDescription] = useState(
    String(item?.data.description ?? ""),
  );
  const [roles, setRoles] = useState(
    ((item?.data.supportedRoles ?? []) as string[]).join("\n"),
  );
  const [members, setMembers] = useState<AccessMember[]>(
    (item?.data.members ?? []) as AccessMember[],
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [requestId] = useState(requestKey);
  const apps = useResource<{ items: Entity[] }>(
    kind === "access_bundle" ? "/api/workspace/it" : null,
  );
  const canLicense = context.principal.scopes?.some(
    (s) => s === "*" || s === "licenses",
  );
  const licenses = useResource<{ items: Entity[] }>(
    kind === "access_bundle" && canLicense ? "/api/workspace/licenses" : null,
  );
  const applications =
    apps.data?.items.filter(
      (a) => a.data.kind === "application" && a.status === "active",
    ) ?? [];
  const update = (i: number, m: AccessMember) =>
    setMembers(members.map((old, j) => (i === j ? m : old)));
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const definition =
        kind === "application"
          ? {
              supportedRoles: roles
                .split("\n")
                .map((s) => s.trim())
                .filter(Boolean),
            }
          : { members };
      const { run } = await post<{ run: Run }>("/api/commands", {
        toolId: item
          ? `ops.it.${kind === "application" ? "reviseApplication" : "reviseAccessBundle"}`
          : "ops.it.create",
        input: item
          ? {
              id: item.id,
              expectedVersion: item.version,
              description,
              ...definition,
            }
          : {
              title,
              data: {
                kind,
                description,
                [kind === "application" ? "applicationKey" : "accessKey"]: key,
                ...definition,
              },
            },
        idempotencyKey: requestId,
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
      title={
        item
          ? "Nowa wersja definicji"
          : kind === "application"
            ? "Dodaj aplikację"
            : "Dodaj zestaw dostępów"
      }
      subtitle="Katalog IT"
      onClose={onClose}
    >
      <form className="command-form" onSubmit={submit}>
        <div className="sheet-body">
          {error && <Notice tone="error">{error}</Notice>}
          {apps.error && <Notice tone="error">{apps.error}</Notice>}
          <fieldset disabled={busy} className="access-fieldset">
            {!item && (
              <label className="field">
                <span>Nazwa</span>
                <input
                  required
                  maxLength={160}
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </label>
            )}
            <label className="field">
              <span>
                {kind === "application" ? "Klucz aplikacji" : "Klucz zestawu"}
              </span>
              <input
                required
                disabled={!!item}
                pattern="[a-z][a-z0-9_.-]{0,79}"
                value={key}
                onChange={(e) => setKey(e.target.value)}
              />
              <small>
                Np.{" "}
                {kind === "application"
                  ? "firmowa-poczta"
                  : "employee-workspace"}
                . Klucz pozostaje stały między wersjami.
              </small>
            </label>
            <label className="field">
              <span>Opis i źródło informacji</span>
              <textarea
                required
                maxLength={10000}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </label>
            {kind === "application" ? (
              <label className="field">
                <span>Obsługiwane role — jedna w wierszu</span>
                <textarea
                  required
                  value={roles}
                  onChange={(e) => setRoles(e.target.value)}
                  placeholder={"member\nreader"}
                />
              </label>
            ) : (
              <>
                <h3>Wymagane aplikacje i role</h3>
                {members.map((m, i) => {
                  const app = applications.find(
                    (a) => a.id === m.applicationId,
                  );
                  return (
                    <fieldset key={i} className="requirement-editor-row">
                      <legend>Pozycja {i + 1}</legend>
                      <label className="field">
                        <span>Klucz pozycji</span>
                        <input
                          required
                          pattern="[a-z][a-z0-9_.-]{0,79}"
                          value={m.key}
                          onChange={(e) =>
                            update(i, { ...m, key: e.target.value })
                          }
                        />
                      </label>
                      <label className="field">
                        <span>Aplikacja i wersja</span>
                        <select
                          required
                          value={
                            app?.version === m.applicationVersion
                              ? m.applicationId
                              : ""
                          }
                          onChange={(e) => {
                            const a = applications.find(
                              (a) => a.id === e.target.value,
                            );
                            if (a)
                              update(i, {
                                ...m,
                                applicationId: a.id,
                                applicationVersion: a.version,
                                role: "",
                              });
                          }}
                        >
                          <option value="">
                            Wybierz aktualną wersję aplikacji…
                          </option>
                          {applications.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.title} · wersja {a.version}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="field">
                        <span>Wymagana rola</span>
                        <select
                          required
                          value={m.role}
                          onChange={(e) =>
                            update(i, { ...m, role: e.target.value })
                          }
                        >
                          <option value="">Wybierz rolę…</option>
                          {((app?.data.supportedRoles ?? []) as string[]).map(
                            (r) => (
                              <option key={r}>{r}</option>
                            ),
                          )}
                        </select>
                      </label>
                      <label className="field">
                        <span>Ważność sprawdzenia w dniach</span>
                        <input
                          required
                          type="number"
                          min={1}
                          max={365}
                          value={m.validityDays}
                          onChange={(e) =>
                            update(i, {
                              ...m,
                              validityDays: Number(e.target.value),
                            })
                          }
                        />
                      </label>
                      {canLicense ? (
                        <label className="field">
                          <span>Wymagana licencja</span>
                          <select
                            value={m.licenseId ?? ""}
                            onChange={(e) => {
                              const next = { ...m };
                              if (e.target.value)
                                next.licenseId = e.target.value;
                              else delete next.licenseId;
                              update(i, next);
                            }}
                          >
                            <option value="">Bez wymogu licencji</option>
                            {licenses.data?.items
                              .filter((l) => l.status === "active")
                              .map((l) => (
                                <option key={l.id} value={l.id}>
                                  {l.title}
                                </option>
                              ))}
                          </select>
                          {licenses.error && (
                            <Notice tone="error">{licenses.error}</Notice>
                          )}
                        </label>
                      ) : m.licenseId ? (
                        <Notice>
                          Ta pozycja zachowuje wymóg licencji. Zmiana wymaga
                          dostępu do obszaru licencji.
                        </Notice>
                      ) : null}
                      <button
                        type="button"
                        className="text-button"
                        onClick={() =>
                          setMembers(members.filter((_, j) => j !== i))
                        }
                      >
                        Usuń pozycję {i + 1}
                      </button>
                    </fieldset>
                  );
                })}
                <button
                  type="button"
                  className="button secondary"
                  disabled={members.length >= 30}
                  onClick={() =>
                    setMembers([
                      ...members,
                      {
                        key: "",
                        applicationId: "",
                        applicationVersion: 1,
                        role: "",
                        validityDays: 7,
                      },
                    ])
                  }
                >
                  Dodaj wymaganą rolę
                </button>
              </>
            )}
          </fieldset>
          <Notice>
            Plan przypisze konkretne aplikacje, role i wersje. Zmiana definicji
            będzie wymagać sprawdzenia powiązanych spraw i zatwierdzenia ich
            nowego zakresu.
          </Notice>
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
            disabled={
              busy ||
              (kind === "access_bundle" &&
                (!members.length || apps.loading || !!apps.error))
            }
          >
            Przygotuj operację
          </button>
        </div>
      </form>
    </Sheet>
  );
}
