import { useEffect, useState } from "react";
import { api } from "./api";

export function useResource<T>(path: string | null, revision = 0, pollMs = 0) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(Boolean(path));
  useEffect(() => {
    if (!path) {
      setData(null);
      setLoading(false);
      return;
    }
    let alive = true;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    async function read() {
      try {
        const result = await api<T>(path!, { signal: controller.signal });
        if (alive) {
          setData(result);
          setError("");
        }
      } catch (cause) {
        if (alive && !controller.signal.aborted)
          setError(
            cause instanceof Error
              ? cause.message
              : "Nie udało się pobrać danych.",
          );
      } finally {
        if (alive) setLoading(false);
      }
    }
    void read();
    const timer = pollMs
      ? setInterval(() => {
          if (!document.hidden) void read();
        }, pollMs)
      : undefined;
    return () => {
      alive = false;
      controller.abort();
      if (timer) clearInterval(timer);
    };
  }, [path, revision, pollMs]);
  return { data, error, loading };
}
export function useRoute() {
  const [route, setRoute] = useState(
    () => location.hash.replace(/^#\/?/, "") || "overview",
  );
  useEffect(() => {
    const update = () =>
      setRoute(location.hash.replace(/^#\/?/, "") || "overview");
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  return route;
}
export const navigate = (path: string) => {
  location.hash = `/${path}`;
};
export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Nie udało się wykonać operacji.";
