import { useEffect, useRef, type ReactNode } from "react";
import { statusLabel } from "./types";

const paths: Record<string, ReactNode> = {
  grid: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </>
  ),
  chat: (
    <path d="M21 11.5a8.3 8.3 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.3 8.3 0 0 1-3.8-.9L3 21l1.9-5.7a8.3 8.3 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.3 8.3 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z" />
  ),
  cases: (
    <>
      <rect x="3" y="7" width="18" height="14" rx="2" />
      <path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 12a25 25 0 0 0 18 0M12 11v3" />
    </>
  ),
  assets: (
    <>
      <rect x="3" y="3" width="18" height="13" rx="2" />
      <path d="M8 21h8m-4-5v5" />
    </>
  ),
  inventory: (
    <>
      <rect x="5" y="4" width="14" height="17" rx="2" />
      <path d="M9 4V2h6v2M8 10l2 2 5-5M8 16h8" />
    </>
  ),
  people: (
    <>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
      <circle cx="9" cy="7" r="4" />
    </>
  ),
  purchases: (
    <>
      <path d="M3 3h2l2.4 12a2 2 0 0 0 2 1.6H18a2 2 0 0 0 2-1.6L21 7H6" />
      <circle cx="10" cy="21" r="1" />
      <circle cx="18" cy="21" r="1" />
    </>
  ),
  licenses: (
    <>
      <circle cx="8" cy="8" r="5" />
      <path d="m11.5 11.5 9 9m-4-4 3-3m-6 0 3-3" />
    </>
  ),
  sales: (
    <>
      <path d="M3 3v18h18M7 14l4-4 4 3 6-7m-5 0h5v5" />
    </>
  ),
  recruitment: (
    <>
      <circle cx="9" cy="7" r="4" />
      <path d="M2 21v-2a6 6 0 0 1 10-4m5-1v6m-3-3h6" />
    </>
  ),
  documents: (
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Zm0 0v6h6M8 13h8m-8 4h5" />
    </>
  ),
  it: (
    <>
      <path d="m14 6 4 4m-6 6-6 6-4-4 6-6a7 7 0 0 1 9-9l-4 4 4 4 4-4a7 7 0 0 1-9 9Z" />
    </>
  ),
  pulse: <path d="M2 12h4l3-9 6 18 3-9h4" />,
  settings: (
    <>
      <path d="M12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.1 2.1m8.6 8.6 2.1 2.1m0-12.8-2.1 2.1m-8.6 8.6-2.1 2.1" />
      <circle cx="12" cy="12" r="6" />
      <circle cx="12" cy="12" r="2" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
  back: <path d="M20 12H4m6-6-6 6 6 6" />,
  chevron: <path d="m9 5 7 7-7 7" />,
  down: <path d="m6 9 6 6 6-6" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  check: <path d="m5 12 4 4L19 6" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="7.5" />
      <path d="m16 16 5 5" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 7v5h-5M4 17v-5h5M6.1 6a8 8 0 0 1 13.2 3M4.7 15A8 8 0 0 0 18 18" />
    </>
  ),
  alert: (
    <>
      <path d="m12 3 10 18H2Z" />
      <path d="M12 9v4m0 4h.01" />
    </>
  ),
  shield: (
    <>
      <path d="m12 2 9 4v6c0 5-9 10-9 10S3 17 3 12V6Z" />
      <path d="m8 12 3 3 5-6" />
    </>
  ),
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  send: (
    <>
      <path d="m22 2-7 20-4-9L2 9Z" />
      <path d="M22 2 11 13" />
    </>
  ),
  mic: (
    <>
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10v2a7 7 0 0 0 14 0v-2m-7 9v3m-4 0h8" />
    </>
  ),
  edit: (
    <>
      <path d="m16 3 5 5-12 12-6 1 1-6ZM14 5l5 5" />
    </>
  ),
  logout: (
    <>
      <path d="M9 3H4v18h5m4-14 5 5-5 5m-5-5h13" />
    </>
  ),
  copy: (
    <>
      <rect x="8" y="8" width="13" height="13" rx="2" />
      <path d="M16 8V3H3v13h5" />
    </>
  ),
  spark: (
    <>
      <path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z" />
    </>
  ),
};
export function Icon({
  name,
  size = 20,
  className = "",
}: {
  name: string;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {paths[name] ?? paths.grid}
    </svg>
  );
}
export function Badge({ status }: { status: string }) {
  const tone = [
    "succeeded",
    "completed",
    "accepted",
    "approved",
    "active",
    "available",
    "healthy",
    "won",
  ].includes(status)
    ? "good"
    : [
          "failed",
          "blocked",
          "needs_reconciliation",
          "unknown",
          "rejected",
          "unhealthy",
        ].includes(status)
      ? "bad"
      : [
            "waiting_approval",
            "waiting_acceptance",
            "awaiting_acceptance",
            "pending",
            "requested",
            "submitted",
          ].includes(status)
        ? "warm"
        : "neutral";
  return (
    <span className={`badge ${tone}`}>
      <span />
      {status === "healthy" ? "Działa poprawnie" : statusLabel(status)}
    </span>
  );
}
export function Empty({
  icon = "cases",
  title,
  children,
  action,
}: {
  icon?: string;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon name={icon} size={26} />
      </span>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}
export function Notice({
  children,
  tone = "info",
}: {
  children: ReactNode;
  tone?: "info" | "error" | "success";
}) {
  return (
    <div
      className={`notice ${tone}`}
      role={tone === "error" ? "alert" : "status"}
    >
      <Icon
        name={
          tone === "error" ? "alert" : tone === "success" ? "check" : "shield"
        }
        size={18}
      />
      <div>{children}</div>
    </div>
  );
}
export function JsonView({ value }: { value: unknown }) {
  return (
    <pre className="json">
      <code>{JSON.stringify(value, null, 2)}</code>
    </pre>
  );
}
export function Loading() {
  return (
    <div className="loading" role="status">
      <span className="spinner" />
      Pobieranie danych…
    </div>
  );
}
export function Sheet({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    ref.current?.focus();
    function key(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
      if (event.key === "Tab") {
        const elements = ref.current?.querySelectorAll<HTMLElement>(
          "button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href]",
        );
        if (!elements?.length) return;
        const first = elements[0]!;
        const last = elements[elements.length - 1]!;
        if (
          event.shiftKey &&
          (document.activeElement === first ||
            document.activeElement === ref.current)
        ) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener("keydown", key);
    return () => {
      document.body.style.overflow = oldOverflow;
      document.removeEventListener("keydown", key);
      previous?.focus();
    };
  }, [onClose]);
  return (
    <div
      className="sheet-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        <div className="sheet-header">
          <div>
            <span className="eyebrow">PRZYGOTUJ OPERACJĘ</span>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button
            className="icon-button"
            aria-label="Zamknij"
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
