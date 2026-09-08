# Dziennik realizacji pełnego JARVIS

Aktualizacja: 8.09.2026. Właściciel: Codex. Kolejność i zakres: [roadmapa](roadmap.md). Ten plik jest punktem wznowienia pracy, nie deklaracją ukończenia produktu.

## Baza potwierdzona przed roadmapą

- Main: `038aa59903ddbb7333bbfe98403e1f0bab01486e`.
- [PR #2 — fundament](https://github.com/artur-t-96/JARVIS/pull/2) i [PR #3 — lokalne moduły i panel](https://github.com/artur-t-96/JARVIS/pull/3) scalone; [CI tej wersji main](https://github.com/artur-t-96/JARVIS/actions/runs/34213174551) zielone.
- Zapisany odbiór techniczny: 97 testów, 57 zatwierdzonych komend demonstratora, rzeczywisty SIGKILL i odtwarzanie kopii, Chrome dla wybranych działań, lokalna transkrypcja whisper.cpp.
- Instalacja użytkownika: lab na 4310 i operational na 4320, dane rozdzielone. To migawka z poprzedniego odbioru; stan procesów i SHA sprawdzać poleceniem zarządzanej instalacji przed kolejną zmianą.
- Rzeczywisty dostawca Claude nie jest aktywny. Pełny onboarding z bramkami biznesowymi oraz gotowy stos observability OSS nie są odebrane.

## Stan paczek

| Paczka | Status       | Następny warunek                                                                                                                                                                              |
| ------ | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P00    | odebrane     | [PR #4](https://github.com/artur-t-96/JARVIS/pull/4), merge `0ecee032cc69125c60fb8c75866ca60d3e9930c4`; [wymagane CI](https://github.com/artur-t-96/JARVIS/actions/runs/34215317438) zielone. |
| P01    | w toku       | Preview pięciu usług i obu trybów odebrane; PR #6, końcowe CI i aktualizacja main do domknięcia.                                                                                              |
| P02    | w toku       | HTTP/run/tool/model zinstrumentowane; OTLP i Prometheus działają, zgoda zachowuje link przez restart.                                                                                         |
| P03    | do wykonania | Typowane warunki odbioru i właściwi wykonawcy zadań.                                                                                                                                          |
| P04    | do wykonania | Kontrolowane odczyty kontekstu, ciągłość rozmowy i sprawy.                                                                                                                                    |
| P05    | do wykonania | Kompletny obieg wyposażenia z poświadczeniami.                                                                                                                                                |
| P06    | do wykonania | Pełny onboarding po P08a/P09a i bazowych profilach z P03.                                                                                                                                     |
| P07    | do wykonania | Pełny proces IT, certyfikat i niezależna weryfikacja.                                                                                                                                         |
| P08    | do wykonania | Dostawy, koszty, miejsca i odnowienia licencji.                                                                                                                                               |
| P09    | do wykonania | Kompletne źródła, dowody plikowe i gotowe dokumenty.                                                                                                                                          |
| P10    | do wykonania | Oferta, przekazanie, realizacja i pakiet rozliczeniowy.                                                                                                                                       |
| P11    | do wykonania | Rekrutacja i pełne zamknięcie konkretnej współpracy.                                                                                                                                          |
| P12    | do wykonania | Inicjatywy i operacyjny przegląd kierownika.                                                                                                                                                  |
| P13    | do wykonania | Dwa pełne profile, rozszerzenia i rozmowa głosowa.                                                                                                                                            |
| P14    | do wykonania | Cała macierz i powtarzalna instalacja po aktualizacji.                                                                                                                                        |

Statusy P01–P14 oznaczają brak pełnego odbioru paczki opisanej w roadmapie. Nie oznaczają braku całego kodu bazowego danego modułu.

## Najbliższa paczka wykonawcza

**P01/P02: rzeczywiste observability OSS.** Uzgodniony kierunek: OpenTelemetry Collector Contrib, Prometheus, Loki, Jaeger/Badger i Grafana OSS. Dostępność oficjalnych binariów macOS arm64 została rozpoznana; konfiguracja razem i zasoby pozostają do sprawdzenia.

1. Zweryfikować main i otwarte PR-y/worktrees JARVIS; dokończyć istniejącą paczkę zamiast dublować implementację.
2. Rozdzielić niezależne prace: manifest/instalator i zamknięty lifecycle, konfiguracje/panele, kontekst/instrumentacja oraz niezależny przegląd.
3. Pierwsza poprawka kontekstu jest scalona: [PR #5](https://github.com/artur-t-96/JARVIS/pull/5), merge `4ce6f3f1fcc37705b41afc8e23a860b00d5ea831`, [CI main](https://github.com/artur-t-96/JARVIS/actions/runs/34215909114) zielone. Commit implementacji `b1e4b9b`: `AsyncLocalStorage`, `withSpan` i `withWorkerTick`, testy równoległego HTTP/workera, zagnieżdżeń, błędów, zakończenia i redakcji. Sprawdzono lokalnie 12 testów infrastruktury, backend TypeScript i format. Oba zarządzane tryby zaktualizowano do merge SHA i potwierdzono izolację korelacji na rzeczywistych żądaniach.
4. Przypiąć oficjalne binaria z SHA-256, przygotować własne katalogi i jawne porty loopback; bez globalnych usług i odczytu innych repozytoriów przez kolektor.
5. Uruchomić na syntetycznym laboratorium rzeczywiste metryki, logi i ślady. Sprawdzić retencję, restart, awarię kolektora, rozdział danych i zużycie zasobów.
6. Doprowadzić kod przez bot branch/PR/CI/merge. Po merge zaktualizować wyłącznie zarządzaną instalację JARVIS, z zachowaniem danych i sprawdzeniem wersji w przeglądarce.
7. Zapisać dowód i zaktualizować ten dziennik oraz macierz; przejść do P03 bez rutynowego pytania użytkownika o zgodę na kolejną paczkę.

## Kontynuacja w tym zadaniu

Włączono godzinową kontynuację `pe-ny-jarvis-realizacja-roadmapy` w tym samym zadaniu Codex. Jej polecenie nakazuje wykonywać kolejne paczki, a nie tylko raportować status, i zakończyć kontynuację po faktycznym odbiorze całej roadmapy. Wymaga dostępnego komputera, aplikacji oraz uprawnień/limitów wykonania. Stan harmonogramu należy sprawdzić w aplikacji, jeśli praca nie została wznowiona.

## Zasady kontynuacji

Nie zmieniać innych systemów. Nie używać lokalnego Dockera. Nie pobierać cudzych sekretów. Nie tworzyć fikcyjnych decyzji biznesowych. Autoryzacja zwykłej realizacji i dostarczenia kodu JARVIS jest już udzielona.

Jeżeli brakuje klucza modelu, realnego poświadczenia albo zgody systemowej mikrofonu, zapisać blokadę konkretnego odbioru i kontynuować niezależne prace. Nie oznaczać całej roadmapy jako zablokowanej z tego powodu.

W kolejnej aktualizacji wpisać: paczkę, branch/worktree, PR, commit, wynik wymaganych CI, lokalny SHA, dowód odbioru, otwarte problemy i jednoznaczny następny krok. Nie zapisywać haseł, tokenów ani treści danych operacyjnych. Wynik planowania i wynik implementacji mają pozostać rozdzielone.

## P01/P02 — bieżąca implementacja

Gałąź `codex/observability-oss`, worktree `/private/tmp/jarvis-observability-oss`. Kod źródłowy głównej instalacji pozostaje na scalonym SHA podczas sprawdzania preview na porcie 4330. Oficjalne dystrybucje pięciu komponentów pobrano, sprawdzono według SHA-256 i pełnego drzewa, zainstalowano w prywatnych katalogach JARVIS.

Potwierdzone w preview: wszystkie pięć usług uruchomione, prawdziwe metryki Prometheus, ślady Jaeger, provisionowane trzy źródła i 14 paneli Grafany; listenery wyłącznie loopback. Testy HTTP abort, 300 równoległych oczekiwań, redakcji, eksportu OTLP i trwałego linkowania zgody przechodzą. Syntetyczny zapis `ops.assets.create` przeszedł zgodę i niezależny odbiór przy wyłączonym Collectorze; identyfikator `e453ff10-6640-496a-936e-32d69666daf4`, dowód prywatny `.data/observability/offline-effect-proof.json`.

Podczas rzeczywistego startu usunięto konflikt portów Jaeger query HTTP/gRPC. Loki zwrócił 503 na zapis mimo /ready200: domyślny próg WAL 90% blokował dysk z 39 GiB wolnego. Konfiguracja zachowuje guard przy 95% oraz bezwzględną rezerwę supervisora 2 GiB. Po zmianie zapis logów działa. Dwa realne stosy uruchomiono jednocześnie: kontrolny ślad i 20 logów trybu operacyjnego były nieobecne w lab, a po restarcie pozostał dokładnie jeden ślad i 20 logów. Prywatny dowód: `.data/observability/isolation-proof.json`. W Chrome potwierdzono dashboard, rzeczywiste logi i przejście do konkretnego śladu HTTP `753ecf10a0fce9cd5286d50e6c19f53c`. Trzy testy połączeń Grafany zwróciły OK. Pierwsze [CI PR #6](https://github.com/artur-t-96/JARVIS/actions/runs/34219402406) przeszło; końcowa poprawka rozdziela cookies logowania obu Grafan oraz używa metadanych trace_id w linku ślad → logi.

Pozostają końcowe CI poprawki, merge i aktualizacja zarządzanej instalacji main. P01/P02 nie zamykają pełnego odbioru asystenta i procesów biznesowych. Po dostarczeniu tej gałęzi przejść do P03: oddzielenie wykonawcy zadania od zatwierdzającego zapis i typowane bramki biznesowego odbioru.
