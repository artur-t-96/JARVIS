# JARVIS Core

Samodzielny rdzeń prowadzenia zadań: plan, kontrolowane wykonanie, decyzja człowieka i potwierdzony wynik.

Projekt jest budowany niezależnie od pozostałych systemów. Nie zawiera połączeń do produkcji ATLAS, NEXUS, COMPASS ani ELEVATE.

## Uruchomienie

```sh
nvm use
npm ci
npm run build
npm start
```

Panel: `http://127.0.0.1:4310`. Domyślny tryb `local` przyjmuje wyłącznie ruch loopback i pracuje na danych syntetycznych. Przygotuj plan, uruchom go, sprawdź argumenty zapisu i zatwierdź operację. Po restarcie ten sam katalog `.data/` zachowuje zadania, decyzje i dowody.

`npm run dev` uruchamia źródła bez kompilowania. `npm run demo` pokazuje dwa wznowienia: po oczekiwaniu na zgodę i po utracie odpowiedzi na już wykonany zapis. Testowa baza demonstracji jest odseparowana i usuwana po zakończeniu.

## Co obejmuje v0.1

- Trwałe plany, kroki, decyzje, dziennik i dowody w SQLite.
- Kontrolę organizacji oraz ról operatora, zatwierdzającego i obserwatora.
- Zgodę na każdy zapis, powiązaną z hashem konkretnego planu, argumentów, narzędzia i zasad. Opcjonalny wymóg drugiej osoby w konfiguracji.
- Lease i kontrolę właściciela próby, deadline, zatrzymanie oraz uzgadnianie niepewnego skutku.
- Idempotentne narzędzie testowe z osobną trwałą bazą; niezależny odczyt rzeczywistego efektu przy weryfikacji.
- Polski panel: plan, przebieg, decyzja, blokada, historia i dowód.
- Domyślny jawnie oznaczony planer demonstracyjny. Opcjonalny adapter Anthropic przygotowuje wyłącznie plan w zamkniętym katalogu testowym.

Opis dowolnego zadania w trybie demo jest tematem stałego scenariusza testowego. System nie wykonuje jeszcze rzeczywistego onboardingu, sprzedaży ani działań IT. Model nie może dodać narzędzia, wybrać organizacji ani przyznać sobie zgody.

## Konfiguracja

Zmienne są odczytywane ze środowiska procesu; plik `.env` nie jest automatycznie ładowany. Przykład nazw znajduje się w `.env.example`.

| Zmienna                                 | Domyślnie               | Znaczenie                                     |
| --------------------------------------- | ----------------------- | --------------------------------------------- |
| `HOST` / `PORT`                         | `127.0.0.1` / `4310`    | Adres i port serwera.                         |
| `JARVIS_DATA_DIR`                       | `.data`                 | Trwały katalog na lokalnym dysku.             |
| `JARVIS_MODE`                           | `local`                 | `authenticated` wymaga pliku uprawnień.       |
| `JARVIS_AUTH_FILE`                      | —                       | Prywatny plik JSON poza repozytorium.         |
| `JARVIS_PLANNER`                        | `demo`                  | `anthropic` wymaga jawnego klucza i modelu.   |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` | —                       | Wyłącznie dla opcjonalnego planera Anthropic. |
| `GIT_SHA`                               | SHA lokalnego checkoutu | Wersja prezentowana przez healthcheck.        |

W trybie `anthropic` opis zadania i ograniczony katalog narzędzi są wysyłane do Anthropic. Wybór tego trybu jest świadomym włączeniem zewnętrznego przetwarzania. Domyślna demonstracja nie wymaga sieci ani klucza modelu; nie odczytuje sekretów innych aplikacji.

Schemat prywatnego pliku autoryzacji:

```json
{
  "principals": [
    {
      "id": "operator-1",
      "tenantId": "company-a",
      "roles": ["operator", "approver", "viewer"],
      "token": "REPLACE_WITH_AT_LEAST_32_RANDOM_CHARACTERS"
    }
  ],
  "policies": [
    {
      "tenantId": "company-a",
      "version": "v1",
      "name": "Firma testowa A",
      "allowedTools": ["demo.inspect", "demo.publish"],
      "approvalTools": [],
      "allowSelfApproval": true
    }
  ]
}
```

Wygeneruj unikalny losowy token dla każdej tożsamości i przechowuj plik z uprawnieniami `0600`. Token jest podawany w panelu i pozostaje wyłącznie w pamięci karty. API używa `Authorization: Bearer …`. Konfiguracja jest ładowana przy starcie; zmiana zasad lub ról wymaga restartu i jest ponownie sprawdzana przed wykonaniem. Zmiana zasad może zablokować stary plan zamiast automatycznie odziedziczyć wcześniejszą zgodę.

## API

| Metoda     | Ścieżka                 | Działanie                                                                 |
| ---------- | ----------------------- | ------------------------------------------------------------------------- |
| GET        | `/api/health`           | Stan bazy/workera i SHA; publiczny endpoint bez danych zadań.             |
| GET        | `/api/context`          | Aktualna organizacja, role, zasady i katalog narzędzi.                    |
| GET / POST | `/api/runs`             | Lista lub przygotowanie planu: `request`, `idempotencyKey`.               |
| GET        | `/api/runs/:id`         | Plan, kroki, decyzje i dowody.                                            |
| POST       | `/api/runs/:id/start`   | Uruchomienie niezmiennego planu.                                          |
| POST       | `/api/runs/:id/approve` | `approvalId`, `bindingHash`, `decision`: `approved` lub `rejected`.       |
| POST       | `/api/runs/:id/cancel`  | Zatrzymanie; możliwy skutek w toku pozostaje do uzgodnienia.              |
| POST       | `/api/runs/:id/retry`   | Uzgodnienie niepewnego wyniku albo ponowna weryfikacja zapisanego efektu. |

POST wymaga JSON. `start`, `cancel` i `retry` przyjmują `{}`. Organizacja i aktor pochodzą z uwierzytelnionego kontekstu, nie z żądania ani planu. Powtórzenie klucza utworzenia z innym żądaniem daje `409`.

## Weryfikacja i dostarczenie

```sh
npm run format:check
npm run check
npm run demo
```

CI wykonuje skan sekretów, format, TypeScript, testy (w tym rzeczywiste SIGKILL), kompilację i demonstrację odzyskiwania. Nie wymaga Dockera ani sekretów innych systemów.

Hosting produkcyjny nie jest skonfigurowany. Nie ma automatycznego deployu, publicznej domeny ani powiązania z istniejącymi aplikacjami. Pierwsze wdrożenie sieciowe wymaga wskazania środowiska, TLS, prywatnej konfiguracji dostępu, trwałego dysku oraz sprawdzonego backup/restore. Jeden host i lokalny filesystem są świadomą granicą v0.1; nie używać współdzielonego dysku sieciowego jako bazy.

Szczegóły gwarancji i ograniczeń: [architektura](docs/architecture.md). Nie deklarujemy dokładnie jednego skutku dla dowolnego przyszłego adaptera. Adapter musi zapewniać trwały klucz operacji i wiarygodny odczyt wyniku; wynik nieznany pozostaje blokadą.
