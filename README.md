# JARVIS lokalnie

Lokalny partner operacyjny firmy: rozmowy, sprawy, ludzie, sprzęt, sprzedaż, rekrutacja, zakupy, licencje, dokumenty i IT. Polska aplikacja React obsługiwana przez ten sam proces Fastify. Wszystkie zmiany biznesowe przechodzą przez trwały Core i zgodę na konkretne argumenty; wykonanie techniczne oraz odbiór biznesowy są osobnymi decyzjami.

Punktem odniesienia jest [wizja v0.4](docs/vision.md), a dowody i granice są w [macierzy pokrycia](docs/coverage.md). JARVIS ma własne dane i konfigurację. Nie zmienia ATLAS, NEXUS, COMPASS, ELEVATE ani QUALRIX i nie zawiera automatycznych połączeń do tych aplikacji.

## Uruchomienie

Node **22.23.0**, npm, bez Dockera:

```sh
nvm use
npm ci
npm run build
npm start
```

Panel: <http://127.0.0.1:4310>. Domyślny `local` jest laboratorium przeznaczonym na dane testowe, z lokalnym operatorem i jawną zgodą na każdy zapis. Dane pozostają w `.data/`; restart zachowuje sprawy, decyzje, rozmowy i efekty. `npm run dev` używa źródeł i oznacza wersję jako `development`.

[Instalacja zarządzana](docs/local-product.md) rozdziela `.data/lab` i `.data/operational`, sprawdza manifest kompilacji i pozwala kontrolować wyłącznie własne procesy JARVIS. [Backup/restore i diagnostyka](docs/operations.md) opisują odtwarzanie bez ponawiania już zapisanego skutku.

## Praca w panelu

1. Dodaj lokalną osobę, urządzenie albo sprawę. Formularz przygotuje plan; dane nie są jeszcze zmienione.
2. Uruchom plan, przeczytaj dokładne argumenty i zatwierdź konkretną operację. Możesz odmówić lub anulować.
3. Otwórz zapisany rekord. Zadania człowieka, protokoły wydania, dostępów i odbiór wymagają odrębnego potwierdzenia.
4. Sprawa ma rewizję zakresu, terminy, zależności zadań, dowody i zapisy czasu/kosztu. Po odbiorze można pobrać pakiet JSON do przygotowania rozliczenia. Pakiet nie wykonuje księgowania ani płatności.
5. Asystent lokalny przeprowadza np. „przygotuj laptop dla Ani”, dopytując o osobę i termin. Tryb bez modelu jest jawnie ograniczonym zestawem szablonów. Opcjonalny Claude otrzymuje zamknięty katalog faktycznych narzędzi i minimalny kontekst, a jego odpowiedź nadal jest tylko propozycją.

Pełne lokalne przebiegi: oferta → przekazanie → odbiór; rekrutacja → decyzja → onboarding; rezerwacja → wydanie → zwrot; zamówienie → potwierdzenie → dostawa; miejsca licencyjne; wersje dokumentów ze źródłami; offboarding ze zwrotami i zadaniami dostępu; diagnoza i naprawa własnej usługi laboratoryjnej przez HTTP. Zapisy o fizycznych działaniach są poświadczeniami człowieka. Połączenia z systemami produkcyjnymi wymagają osobnego uruchomienia adapterów.

## Konta i dwie firmy

Do własnych danych operacyjnych użyj `JARVIS_MODE=accounts` na loopback. Utwórz konto przez `npm run users -- create`, przekazując prywatny JSON na stdin; CLI nie wypisuje hasła. Przykład struktury (nie jest gotowym kontem):

```json
{
  "id": "operator-1",
  "tenantId": "dynaminds",
  "username": "operator",
  "password": "REPLACE_WITH_PRIVATE_PASSWORD",
  "roles": ["operator", "approver", "viewer"],
  "scopes": ["*"]
}
```

Identyfikator firmy izoluje dane. Role: `operator`, `approver`, `viewer`. Obszary: `people`, `cases`, `assets`, `purchases`, `licenses`, `sales`, `recruitment`, `documents`, `it`, `initiatives`, `company`. Odwołania do osób, źródeł dokumentów i spraw mogą wymagać kilku obszarów jednocześnie. `npm run users -- revoke TENANT USER` odbiera konto i sesje; worker sprawdza aktualne uprawnienia przed wykonaniem i wznowieniem.

Tryb kont lokalnych pozwala osobie mającej obie role zatwierdzić własny plan. Wymóg drugiej osoby można wymusić w trybie `authenticated` przez prywatny plik polityk (`allowSelfApproval:false`). Plik musi mieć uprawnienia `0600`, unikalne tokeny i jawną listę `allowedTools`; nie kopiuj konfiguracji innych systemów. Przykład i zasady kontraktu są w [architekturze](docs/architecture.md).

Profil firmy zawiera nazwę, strefę czasową, reguły inicjatyw, wyciszenie i szablony onboardingu/offboardingu. Edycja jest wersjonowaną operacją z zatwierdzeniem. Plan przypina wersję profilu, a zmiana szablonu przed wykonaniem wymaga nowego planu.

## Głos i model

[Instrukcja głosu](docs/voice.md): `npm run voice:setup` instaluje lokalny whisper.cpp i model; `npm run voice:smoke` sprawdza transkrypcję. Mikrofon działa przyciskiem. Tekst można poprawić przed wysłaniem; transkrypcja sama niczego nie zatwierdza. Odczytywanie odpowiedzi używa głosu systemowego przeglądarki.

`JARVIS_PLANNER=anthropic` wymaga własnego `ANTHROPIC_API_KEY` i jawnego `ANTHROPIC_MODEL`. Klucz można przechowywać w lokalnym Keychain przez narzędzie instalacyjne. Nie ma automatycznego odczytu kluczy innych repozytoriów. Brak klucza oznacza tryb lokalnych szablonów, a nie działającego Claude.

Claude otrzymuje ograniczone metadane wybranych rekordów, schematy narzędzi i fragment rozmowy, z pseudonimami znanych osób. Pełne dokumenty HR i bazy osób nie trafiają do kontekstu. Nie umieszczaj sekretów w swobodnym tekście rozmowy: redakcja typowych formatów nie rozpoznaje dowolnego sekretu. Włączenie tego adaptera świadomie uruchamia przetwarzanie u dostawcy.

`JARVIS_MODEL_PRICING` przyjmuje JSON `{ "version":"cennik-wlasny-1", "currency":"USD", "inputPerMillion":0, "outputPerMillion":0 }` z własnymi zweryfikowanymi stawkami. Użyj rzeczywistych cen zamiast przykładowych zer. Każde wywołanie zachowuje wersję cennika, tokeny, czas i koszt szacowany. Bez cennika koszt pozostaje `null`; nie jest zgadywany.

## API i diagnostyka

| Interfejs                                              | Znaczenie                                                       |
| ------------------------------------------------------ | --------------------------------------------------------------- |
| `/api/live`, `/api/ready`, `/api/health`               | Żywy HTTP, gotowość workera i stan bazy/rewizji.                |
| `/api/workspace`, `/api/workspace/:module/:id`         | Katalog i dane dostępne bieżącej osobie.                        |
| `POST /api/commands`                                   | `{toolId,input,idempotencyKey}` przygotowuje zatwierdzany plan. |
| `/api/runs?limit=50&offset=0`                          | Stronicowana historia, filtrowana uprawnieniami.                |
| `/api/runs/:id/start`, `/approve`, `/cancel`, `/retry` | Rozpoczęcie, konkretna zgoda, anulowanie i uzgadnianie.         |
| `/api/conversations`, `/:id/messages`                  | Rozmowa prywatna dla osoby i firmy.                             |
| `/api/initiatives`, `/api/profile`                     | Zaległości i wersjonowane reguły firmy.                         |
| `/api/document-templates/prepare`                      | Szkic dokumentu ze źródłem, przez Core.                         |
| `/api/documents/:id/export`, `/api/cases/:id/package`  | Eksport z wersją i SHA-256; pakiet sprawy wymaga odbioru.       |
| `/api/ops`                                             | Technologia, terminy/blokady i zużycie modelu.                  |

Inicjatywy powstają z konkretnych danych i reguł. Mają źródło, wiek, właściciela/termin, deduplikację, odłożenie i wyciszenie. Nie wysyłają wiadomości do ludzi przez zewnętrzne usługi. OpenTelemetry ma lokalny bufor; eksport sieciowy jest wyłączony.

## Sprawdzenie i dostarczenie

```sh
npm run format:check
npm run check
npm run demo
npm run demo:workspace
```

CI uruchamia skan sekretów, format, TypeScript backendu i panelu, testy (w tym rzeczywiste SIGKILL i osobny trwały magazyn skutków), build oraz oba demonstratory. Zmiany przechodzą przez PR, zielone CI i merge. Po merge sprawdzamy lokalnie właściwą rewizję i panel.

Nie ma skonfigurowanego hostingu produkcyjnego. System jest pojedynczą instalacją na lokalnym dysku; nie używa klastrów, współdzielonego filesystemu ani produkcyjnych baz innych aplikacji.
