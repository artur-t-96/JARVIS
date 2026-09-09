export function companyDay(now: string | number, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(now));
  return ["year", "month", "day"]
    .map((kind) => parts.find((part) => part.type === kind)!.value)
    .join("-");
}
