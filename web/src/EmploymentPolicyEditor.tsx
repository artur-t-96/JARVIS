export type EmploymentPolicy = {
  mode: "single_open" | "parallel_projects";
  maxConcurrent: number;
  allowInternalOverlap: false;
};
export const safeEmploymentPolicy: EmploymentPolicy = {
  mode: "single_open",
  maxConcurrent: 1,
  allowInternalOverlap: false,
};
export function changeEmploymentMode(
  policy: EmploymentPolicy,
  mode: EmploymentPolicy["mode"],
): EmploymentPolicy {
  return {
    mode,
    maxConcurrent:
      mode === "single_open" ? 1 : Math.max(2, policy.maxConcurrent),
    allowInternalOverlap: false,
  };
}
export function EmploymentPolicyEditor({
  value,
  disabled,
  onChange,
}: {
  value: EmploymentPolicy;
  disabled: boolean;
  onChange: (value: EmploymentPolicy) => void;
}) {
  return (
    <section>
      <h3>Zasady okresów współpracy</h3>
      <div className="form-grid">
        <label className="field wide">
          <span>Dopuszczalna liczba współprac jednej osoby</span>
          <select
            disabled={disabled}
            value={value.mode}
            onChange={(event) =>
              onChange(
                changeEmploymentMode(
                  value,
                  event.target.value as EmploymentPolicy["mode"],
                ),
              )
            }
          >
            <option value="single_open">Jedna otwarta współpraca</option>
            <option value="parallel_projects">
              Równoległe projekty konsultanta
            </option>
          </select>
        </label>
        {value.mode === "parallel_projects" && (
          <label className="field">
            <span>Maksymalna liczba otwartych współprac</span>
            <input
              type="number"
              required
              min={1}
              max={20}
              step={1}
              disabled={disabled}
              value={value.maxConcurrent}
              onChange={(event) =>
                onChange({
                  ...value,
                  maxConcurrent: Number(event.target.value),
                  allowInternalOverlap: false,
                })
              }
            />
          </label>
        )}
      </div>
      <p className="small muted">
        Równoległe współprace dotyczą wyłącznie konsultantów w różnych
        uzgodnionych projektach. Współpraca wewnętrzna nie może nakładać się na
        inną. Obniżenie limitu nie zamknie istniejących okresów.
      </p>
    </section>
  );
}
