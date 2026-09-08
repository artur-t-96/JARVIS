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
| P01    | odebrane     | PR #6 scalony, CI zielone; oba lokalne tryby i przepływ metryk/logów/śladów odebrane.                                                                                                         |
| P02    | w toku       | HTTP/run/tool/model zinstrumentowane; OTLP i Prometheus działają, zgoda zachowuje link przez restart.                                                                                         |
| P03    | w toku       | Typowane warunki odbioru i właściwi wykonawcy zadań.                                                                                                                                          |
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

Status inny niż „odebrane” oznacza brak pełnego odbioru paczki opisanej w roadmapie. Nie oznacza braku całego kodu bazowego danego modułu.

## Najbliższa paczka wykonawcza

**P03: sprawy, odpowiedzialność ludzi i typowane warunki odbioru.** P01 jest dostarczone; instrumentacja P02 działa, a pełny odbiór modelu i proaktywnych reguł ma dalsze zależności. Realizacja P03 obejmuje model domenowy, migrację, uprawnienia do konkretnego zadania także w Core, panel oraz odbiór w izolowanym preview. Po przejściu wymaganych kontroli: PR, merge, kopia i aktualizacja tylko zarządzanej instalacji JARVIS. Kolejna paczka to P04, bez rutynowego pytania o zgodę na kontynuację.

## Kontynuacja w tym zadaniu

Włączono godzinową kontynuację `pe-ny-jarvis-realizacja-roadmapy` w tym samym zadaniu Codex. Jej polecenie nakazuje wykonywać kolejne paczki, a nie tylko raportować status, i zakończyć kontynuację po faktycznym odbiorze całej roadmapy. Wymaga dostępnego komputera, aplikacji oraz uprawnień/limitów wykonania. Stan harmonogramu należy sprawdzić w aplikacji, jeśli praca nie została wznowiona.

## Zasady kontynuacji

Nie zmieniać innych systemów. Nie używać lokalnego Dockera. Nie pobierać cudzych sekretów. Nie tworzyć fikcyjnych decyzji biznesowych. Autoryzacja zwykłej realizacji i dostarczenia kodu JARVIS jest już udzielona.

Jeżeli brakuje klucza modelu, realnego poświadczenia albo zgody systemowej mikrofonu, zapisać blokadę konkretnego odbioru i kontynuować niezależne prace. Nie oznaczać całej roadmapy jako zablokowanej z tego powodu.

W kolejnej aktualizacji wpisać: paczkę, branch/worktree, PR, commit, wynik wymaganych CI, lokalny SHA, dowód odbioru, otwarte problemy i jednoznaczny następny krok. Nie zapisywać haseł, tokenów ani treści danych operacyjnych. Wynik planowania i wynik implementacji mają pozostać rozdzielone.

## P01/P02 — dostarczona paczka OSS

Gałąź `codex/observability-oss`, worktree `/private/tmp/jarvis-observability-oss`. Kod źródłowy głównej instalacji pozostaje na scalonym SHA podczas sprawdzania preview na porcie 4330. Oficjalne dystrybucje pięciu komponentów pobrano, sprawdzono według SHA-256 i pełnego drzewa, zainstalowano w prywatnych katalogach JARVIS.

Potwierdzone w preview: wszystkie pięć usług uruchomione, prawdziwe metryki Prometheus, ślady Jaeger, provisionowane trzy źródła i 14 paneli Grafany; listenery wyłącznie loopback. Testy HTTP abort, 300 równoległych oczekiwań, redakcji, eksportu OTLP i trwałego linkowania zgody przechodzą. Syntetyczny zapis `ops.assets.create` przeszedł zgodę i niezależny odbiór przy wyłączonym Collectorze; identyfikator `e453ff10-6640-496a-936e-32d69666daf4`, dowód prywatny `.data/observability/offline-effect-proof.json`.

Podczas rzeczywistego startu usunięto konflikt portów Jaeger query HTTP/gRPC. Loki zwrócił 503 na zapis mimo /ready200: domyślny próg WAL 90% blokował dysk z 39 GiB wolnego. Konfiguracja zachowuje guard przy 95% oraz bezwzględną rezerwę supervisora 2 GiB. Po zmianie zapis logów działa. Dwa realne stosy uruchomiono jednocześnie: kontrolny ślad i 20 logów trybu operacyjnego były nieobecne w lab, a po restarcie pozostał dokładnie jeden ślad i 20 logów. Prywatny dowód: `.data/observability/isolation-proof.json`. W Chrome potwierdzono dashboard, rzeczywiste logi i przejście do konkretnego śladu HTTP `753ecf10a0fce9cd5286d50e6c19f53c`. Trzy testy połączeń Grafany zwróciły OK. Pierwsze [CI PR #6](https://github.com/artur-t-96/JARVIS/actions/runs/34219402406) przeszło; końcowa poprawka rozdziela cookies logowania obu Grafan oraz używa metadanych trace_id w linku ślad → logi.

[PR #6](https://github.com/artur-t-96/JARVIS/pull/6) scalony do `04bb1f048ee8befe3daa9866cb4989782fcbb620`. Końcowe wymagane [CI PR](https://github.com/artur-t-96/JARVIS/actions/runs/34219803831) i [CI main](https://github.com/artur-t-96/JARVIS/actions/runs/34219944452) przeszły: 132 testy, format, typy, build, demonstratory i rzeczywisty SIGKILL. Oba katalogi danych skopiowano przed aktualizacją; backup/restore zweryfikował manifesty. Lab4310 i operational4320 zostały zaktualizowane zarządzanym `local update` i uruchomione z własnym stosem OSS. `/api/ready` obu trybów potwierdziło oczekiwany SHA oraz działającego workera.

Dowód z głównej instalacji `.data/local-product/observability-oss-verification.json` (8.09.2026, 11:23 UTC): wszystkie trzy źródła Grafany OK, po 14 paneli; rzeczywiste liczniki workera, ślady HTTP i dopasowane logi po `trace_id` w obu trybach. Ślad lab `44c07e9820c2d2583582b0a3dfbfe995`, operational `8892f08ecbdc022a6c428a5eb85c8c3f`. W Chrome na4310 widoczny dokładny SHA, aktywny eksport i zero błędów wysyłki w bieżącym procesie. W głównej Grafanie potwierdzono rzeczywiste wykresy, a kliknięcie Related logs ze śladu `44c07e9820c2d2583582b0a3dfbfe995` zwróciło jeden właściwy wpis `http.request`. Nie jest to odbiór rzeczywistego modelu ani całej warstwy reguł procesowych P02/P12.

## P03 — bieżąca paczka

Gałąź `codex/case-readiness`, worktree `/private/tmp/jarvis-case-readiness` z main `04bb1f0`. Zakres: migracja danych bez zgadywania dawnych autorów, typowane wymagania i powiązania dowodów, ponowna ocena przy odbiorze/aktywacji, zadania przypisane do aktywnych kont HR/IT/kierownika, osobna projekcja zadania IT i panel gotowości. Projekt: [P03](p03-design.md). Zależności P05/P08a/P09a pozostają jawne; ich brak ma blokować wynik, a nie dawać zastępcze potwierdzenie. Następnie testy migracji, autoryzacji, odmów, rewizji oraz restartu, PR/CI/merge i rzeczywisty odbiór lokalny.

Pierwsze potwierdzone testy P03: aktywne konta i rozdzielenie autora pracy od zatwierdzającego; ograniczony widok IT i odmowa odczytu nieprzypisanego wykonania nawet przy wspólnym zakresie `it`; utrata odpowiedzi po przekazaniu i odtworzenie bez drugiego skutku; cofnięcie dostępu po zgodzie; blokada eksportu przy zmianie źródła zaakceptowanego dokumentu. Demonstrator nadal obejmuje dziewięć modułów, ale teraz jawnie blokuje onboarding bez typowanych dowodów: 55 zatwierdzonych i zweryfikowanych komend. Nie zalicza nieistniejącego poświadczenia dostępu.

Wykryty cykl źródła dokumentu z tej samej sprawy jest jawną blokadą: powiązanie dowodu zmienia wersję sprawy. Pełny kontrakt niezmiennej rewizji zakresu jako źródła dokumentu należy do P09a; nie omijamy kontroli aktualności. Bazowe wymagania nie mają reguły dopuszczającej wyjątek, więc notatka lub wyjątek nie zastępują sprzętu, dokumentu i dostępu.

Przebieg Chrome w izolowanym preview `localhost:4330`, syntetyczny tenant: kierownik widzi trzy brakujące warunki; IT1 widzi wyłącznie dwa przypisane zadania i otrzymuje 403 dla całej sprawy. Przyjęcie → przekazanie przez selektor do IT2 → ponowne przyjęcie → potwierdzenie pracy przeszły cztery osobne zgody Core i niezależną weryfikację, po jednej próbie. Zapisany wykonawca to IT2; ukończenie tekstowego zadania nie zalicza dowodu wydania i gotowość pozostaje zablokowana. Prywatny dowód `.data/p03-preview/ui-proof.json` i trzy zrzuty ekranu. Test API dodatkowo rozdziela operatora i zatwierdzającego oraz potwierdza zachowanie autorów po restarcie. Finalne poprawki interfejsu i dostarczenie wymagają jeszcze odbioru właściwej wersji.

Przegląd przed PR ujawnił dwie ścieżki wymagające dodatkowej osłony: automatyczne zamknięcie onboardingu musi anulować jego otwarte zadania w tej samej transakcji, a wildcard obszarów nie może omijać kontroli tożsamości dla nierozwiązanych referencji Core. Ponowna ocena dowodów obejmuje też zakończenie współpracy. Plan następnej paczki: [P04 — kontekst firmy i rozmowa](p04-design.md).
