import type { Entity } from "./workspace.js";
import { DomainError, type JsonObject } from "./contracts.js";
import { SALES_CONTRACT } from "./sales-models.js";
const text = (value: unknown) => String(value ?? "").replace(/[\r\n<>]/g, " ");
const money = (n: unknown, currency: unknown) =>
  `${(Number(n) / 100).toLocaleString("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
const unit: Record<string, string> = {
  fixed: "ryczałt",
  md: "MD",
  hour: "godzina",
  month: "miesiąc",
  item: "sztuka",
};
export function salesDocument(e: Entity, acceptanceCurrent: boolean) {
  if (e.data.kind !== "offer")
    throw new DomainError(
      "WRONG_RECORD_KIND",
      "Szablon wymaga konkretnej oferty.",
      409,
    );
  if (e.data.salesContract !== SALES_CONTRACT)
    throw new DomainError(
      "SALES_LEGACY_OFFER",
      "Historyczna oferta wymaga przygotowania wersjonowanych warunków przed użyciem tego szablonu.",
      409,
    );
  const o = e.data.offer as JsonObject,
    terms = o.terms as JsonObject,
    pricing = o.pricing as JsonObject;
  const client = o.client as JsonObject,
    contact = o.contact as JsonObject,
    acceptance = e.data.acceptance as JsonObject | undefined;
  const lines = (pricing.lines as JsonObject[])
    .map(
      (l, i) =>
        `### ${i + 1}. ${text(l.label)}\n\nIlość: ${(Number(l.quantityMilli) / 1000).toLocaleString("pl-PL")} ${unit[String(l.unit)]}. Cena jednostkowa: ${money(l.unitPriceMinor, pricing.currency)}. Wartość: ${money(l.totalMinor, pricing.currency)}.`,
    )
    .join("\n\n");
  const summary = acceptanceCurrent
    ? `Potwierdzona akceptacja klienta z ${text(acceptance?.acceptedOn)}. Dowód: ${text(acceptance?.evidenceReference)}.\n\n${text(acceptance?.note)}\n\nPoświadczenie wprowadził: ${text(acceptance?.actorId)}.`
    : "Brak obowiązującej akceptacji klienta dla tej rewizji. Materiał opisuje propozycję i nie potwierdza przyjęcia zobowiązania.";
  return `# ${text(e.title)}\n\nRewizja oferty: ${text(o.revision)}.\n\n## Klient i kontakt\n\n${text(client.organizationName)}\n\nKontakt: ${text(contact.title)}${contact.contactEmail ? ` · ${text(contact.contactEmail)}` : ""}.\n\n## Zakres\n\n${String(terms.scope)}\n\n## Warunki\n\nOferta ważna do: ${text(terms.validUntil)}. Ceny ${terms.priceBasis === "net" ? "netto" : "brutto"}, waluta ${text(terms.currency)}.\n\n${lines}\n\n## Łączna wartość\n\n${money(pricing.totalMinor, pricing.currency)} ${pricing.priceBasis === "net" ? "netto" : "brutto"}. Jednostki MD i godziny nie są automatycznie przeliczane.\n\n## Stan uzgodnienia\n\n${summary}\n\n## Źródła\n\nKlient: ${text(client.id)}, wersja ${text(client.version)}. Kontakt: ${text(contact.id)}, wersja ${text(contact.version)}.\n\nOferta: ${e.id}, wersja rekordu ${e.version}. Odcisk rewizji: ${text(o.hash)}.\n\nDokument odzwierciedla lokalną ewidencję. Samo wygenerowanie lub pobranie nie oznacza przekazania klientowi.`;
}
