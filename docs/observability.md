# Lokalna obserwowalność JARVIS

Opcjonalny stos OSS zapisuje metryki, logi techniczne i ślady wykonania JARVIS na tym komputerze. Składa się z pięciu natywnych procesów: OpenTelemetry Collector, Prometheus, Loki, Jaeger i Grafana. Nie wymaga Dockera, Homebrew ani usługi chmurowej. Nie instaluje automatycznego startu systemowego.

Obsługiwana dystrybucja binarna to **macOS arm64**. Wymagane są Node.js 22.23.0 zgodnie z `.nvmrc`, zależności npm projektu oraz Python 3 do sprawdzenia i rozpakowania archiwów. Linux jest używany przez testy z zastępczymi procesami Node; nie ma przypiętego instalatora stosu dla Linux ani Windows.

## Uruchomienie

Polecenia wykonuj w katalogu tego JARVIS. Przy pierwszej instalacji przygotuj aplikację zgodnie z [local-product.md](local-product.md), a następnie osobno stos obserwowalności:

```sh
nvm use
npm run local -- install
npm run observability -- install
npm run observability -- start lab
npm run local -- start lab --observability
npm run observability -- status lab
npm run observability -- doctor lab
```

`install` pobiera wyłącznie przypięte wersje z adresów zapisanych w `src/observability/manifest.ts`. Sprawdza SHA-256 archiwum oraz pełnego drzewa plików, w tym zasobów Grafany. Nie wybiera `latest`. Każdy kolejny `start` sprawdza integralność instalacji. Pobranie wymaga internetu; działanie skonfigurowanego stosu korzysta z loopback.

Flaga `--observability` należy do polecenia uruchamiającego **aplikację**. Włącza lokalny eksport śladów i port metryk; nie uruchamia pięciu usług. Aplikację uruchomioną wcześniej bez tej flagi trzeba najpierw zatrzymać. Uruchomienie aplikacji z samą flagą nie dowodzi dostępności Collectora ani danych w Grafanie.

Tryb operacyjny uruchamia się analogicznie:

```sh
npm run observability -- start operational
npm run local -- start operational --observability
npm run observability -- status operational
```

Obowiązują dotychczasowe warunki trybu operacyjnego: build czystego commitu i jawnie utworzone konta operatora oraz zatwierdzającego. Stos nie tworzy tych kont i nie kopiuje danych z laboratorium. Opcjonalny planer Anthropic pozostaje osobną decyzją przy starcie aplikacji; obserwowalność nie aktywuje dostawcy modelu.

## Polecenia i zatrzymanie

| Polecenie                             | Działanie                                                                            |
| ------------------------------------- | ------------------------------------------------------------------------------------ |
| `npm run observability -- install`    | Instaluje i sprawdza wspólne binaria; wymaga zatrzymania obu trybów stosu.           |
| `npm run observability -- start lab`  | Sprawdza pliki, miejsce i porty, generuje prywatną konfigurację i uruchamia tryb.    |
| `npm run observability -- stop lab`   | Zatrzymuje tylko procesy z potwierdzoną tożsamością. Zachowuje dane i konta Grafany. |
| `npm run observability -- status lab` | Podaje tożsamość i gotowość usług, PID-y oraz katalog logów.                         |
| `npm run observability -- doctor lab` | Tylko odczyt: status, integralność pięciu komponentów, wolny dysk i limity logów.    |

W czterech ostatnich poleceniach można zastąpić `lab` przez `operational`. Tryb trzeba zawsze podać jawnie. `doctor` nie naprawia konfiguracji, nie instaluje plików i nie ujawnia haseł. Pełne sprawdzenie plików Grafany może zająć kilka sekund.

Przy planowanym wyłączeniu najpierw zatrzymaj aplikację, aby mogła zakończyć pracę i opróżnić bufor śladów, potem stos:

```sh
npm run local -- stop lab
npm run observability -- stop lab
```

Kolejność startu to Prometheus → Loki → Jaeger → Collector → Grafana. Przy zatrzymaniu Grafana kończy pierwsza, potem Collector dostaje czas na wysłanie danych do nadal działających backendów. Backendów nie wyłącza się przed Collectorem. Każdy proces dostaje SIGTERM; po ograniczonym czasie oczekiwania supervisor może użyć SIGKILL, wyłącznie po ponownym potwierdzeniu jego tożsamości.

Domyślny limit gotowości wynosi 45 sekund na komponent, a łagodnego zakończenia 8 sekund na komponent. Aktualizacja wspólnych binariów wymaga zatrzymania obu trybów. Restart nie usuwa historii, konfiguracji kont ani trwałych kolejek.

## Dostęp i porty

Wszystkie usługi wiążą **127.0.0.1**. Tryby mają osobne porty, katalogi danych, konfigurację, hasła i bazy Grafany. Współdzielą tylko sprawdzone binaria i cache instalacji.

| Usługa / interfejs                  | `lab` | `operational` |
| ----------------------------------- | ----: | ------------: |
| Grafana                             | 15300 |         15400 |
| Prometheus                          | 15301 |         15401 |
| Loki HTTP                           | 15302 |         15402 |
| Loki gRPC                           | 15303 |         15403 |
| Jaeger query HTTP                   | 15304 |         15404 |
| Jaeger OTLP gRPC                    | 15305 |         15405 |
| Jaeger OTLP HTTP                    | 15306 |         15406 |
| Collector OTLP HTTP                 | 15307 |         15407 |
| Collector OTLP gRPC                 | 15308 |         15408 |
| Collector health                    | 15309 |         15409 |
| Collector metrics                   | 15310 |         15410 |
| Jaeger metrics                      | 15311 |         15411 |
| Jaeger health                       | 15312 |         15412 |
| Metryki aplikacji JARVIS `/metrics` | 15313 |         15413 |
| Jaeger query gRPC                   | 15314 |         15414 |

Grafana laboratorium: [http://127.0.0.1:15300](http://127.0.0.1:15300). Grafana operacyjna: [http://127.0.0.1:15400](http://127.0.0.1:15400). Źródła danych i dashboard JARVIS są przygotowywane z konfiguracji wersjonowanej w repozytorium. Brak pomiarów jest wyświetlany jako „Brak danych”.

Login Grafany to `admin`. Początkowe hasło jest losowane osobno dla trybu i zapisane w prywatnym pliku:

```text
.data/observability/lab/config/grafana-admin-password
.data/observability/operational/config/grafana-admin-password
```

Plik ma uprawnienia `0600`; Grafana czyta go przez dostawcę plikowego. Polecenia nie wypisują hasła i nie przekazują go w argumentach procesu. Odczytaj właściwy plik prywatnie do pierwszego logowania; nie umieszczaj jego zawartości w terminalowym raporcie, commicie ani zgłoszeniu. Ponowny start zachowuje ten plik. Zmiana hasła przez interfejs Grafany nie jest automatycznie synchronizowana z plikiem początkowego hasła.

Grafana ma własne logowanie. Loki, Prometheus, Jaeger i odbiorniki OTLP korzystają z granicy lokalnego komputera, nie z sesji i zakresów dostępu kont JARVIS. Nie wystawiaj tych portów przez tunnel, reverse proxy ani przekierowanie na sieć. Rozdzielenie `lab` i `operational` nie zapewnia izolacji od administratora lub innych procesów działających na tym samym koncie systemowym.

## Dane, retencja i zasoby

Stos czyta wyłącznie wskazane logi tego JARVIS: `.data/local-product/<tryb>.log` oraz dwie rotacje. Prometheus odpytuje jawnie wymienione lokalne porty aplikacji i komponentów. Nie ma skanowania dysku, odczytu baz klientów innych aplikacji, zbierania historii przeglądarki ani odbiornika metryk całego hosta. Diagnostyka ogranicza pola do zdarzeń i identyfikatorów technicznych; Collector ponownie filtruje atrybuty. Treść rozmów, dokumentów i hasła nie należą do zbieranych danych.

Identyfikatory request/run/step/trace służą korelacji w logach i śladach. Nie są etykietami metryk ani indeksowanymi etykietami Loki. Telemetria jest widokiem technicznym: nie zastępuje trwałego audytu Core, dowodów wykonania ani biznesowej akceptacji sprawy. Koszt modelu jest szacunkiem z jawnego cennika; bez cennika pozostaje nieznany.

| Obszar                   | Bieżąca konfiguracja                                                                                                          |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Prometheus               | 14 dni lub 512 MB bloków TSDB; stosuje ograniczenie osiągnięte wcześniej. WAL i aktywne dane mogą zajmować dodatkowe miejsce. |
| Loki                     | 7 dni, usuwanie przez compactor z dodatkowym opóźnieniem; brak twardego limitu rozmiaru całej bazy.                           |
| Jaeger                   | Trwałe Badger, TTL śladów 48 godzin; brak twardego limitu rozmiaru całej bazy.                                                |
| Collector                | Trwałe kolejki eksporterów i pozycje odczytu logów, fsync; do 512 elementów na kolejkę, konfiguracja magazynu 64 MiB.         |
| Logi nadzorowanych usług | 2 MiB na plik + 2 rotacje; 5 komponentów i supervisor, maksymalnie 36 MiB na tryb.                                            |
| Log aplikacji            | Osobny launcher: 5 MiB + 2 rotacje, maksymalnie 15 MiB na tryb.                                                               |
| Wolny dysk               | Co najmniej 2 GiB przy starcie; sprawdzenie co 5 sekund podczas pracy stosu.                                                  |

Próg 2 GiB chroni przed dalszą pracą przy niemal pełnym dysku; nie jest oszacowaniem miejsca potrzebnego na instalację i historię. Archiwa zajmują około 751 MB, a rozpakowane dystrybucje dodatkowe gigabajty. Cache znajduje się w `.data/observability/cache`, binaria w `.data/observability/bin/<komponent>/<wersja>`. Dane każdego trybu są w `.data/observability/<tryb>/data`.

Konfiguracja Go ustawia miękki `GOMEMLIMIT`: Prometheus/Loki/Jaeger po 256 MiB, Collector 160 MiB, Grafana 384 MiB. Collector ma dodatkowo limiter 128 MiB. Te wartości nie są twardymi limitami RSS ani CPU. Dwa uruchomione tryby oznaczają dwa zestawy pięciu usług. W migawce rzeczywistego preview z 2026-09-08 pięć usług wraz z supervisorem zajmowało około 844 MiB RSS, bez aplikacji JARVIS; suma CPU wynosiła około 2,6%. To pojedynczy pomiar, nie budżet pod obciążeniem ani pomiar dwóch trybów jednocześnie.

## Awaria i odtwarzanie pracy

Zajęty port powoduje odmowę startu, bez zatrzymywania procesu zajmującego port. Niepoprawna konfiguracja, naruszona integralność lub brak miejsca również blokują start. Częściowo uruchomiony stos sprząta własne nowe procesy. Polecenia administracyjne korzystają ze wspólnej blokady, aby instalacja nie ścigała się ze startem innego trybu.

Przed sygnałem sprawdzane są PID, pełne polecenie, czas startu i losowy nonce procesu. Sam wpis PID w pliku nie wystarcza. Po zabiciu supervisora `stop` może sprzątnąć pozostałe procesy z potwierdzoną tożsamością. Obejmuje to okno między uruchomieniem dziecka a zapisem jego PID: odzyskiwanie porównuje pełne polecenie ze wskazanym executable i argumentami prywatnego planu oraz potwierdza nonce procesu. Inny program lub inne argumenty nie są dopasowaniem; środowiska procesów nie są wypisywane. Gdy tożsamość nie pasuje, polecenie odmawia sygnalizowania; użyj `doctor` i sprawdź prywatne logi. Nie usuwaj stanu tylko po to, aby ominąć odmowę.

Wyjście komponentu lub spadek wolnego miejsca powoduje kontrolowane zatrzymanie pozostałych własnych komponentów tego trybu. Nie ma nieskończonej pętli automatycznych restartów. Po usunięciu przyczyny wykonaj `stop`, `doctor`, następnie `start` wybranego trybu.

Awaria eksportu nie ma blokować pracy biznesowej JARVIS. Aplikacja ma ograniczony bufor śladów w pamięci (256), krótki timeout eksportu i licznik nieudanych paczek. Niedostarczone ślady mogą zostać utracone po przepełnieniu bufora lub awarii procesu. Trwała kolejka Collectora chroni dane już przyjęte przez Collector, nie wszystkie zdarzenia powstałe podczas jego niedostępności. Rotacja logów i limity kolejek również ograniczają możliwy zakres odtworzenia. Nie ma gwarancji bezstratności ani exactly-once telemetrii.

## Stan weryfikacji

Testy nadzoru z prawdziwymi procesami zastępczymi Node: **7/7 zaliczone** na macOS, 2026-09-08. Obejmują dwa tryby, restart z zachowaniem danych, kolejność zamknięcia, awarię częściowego startu, SIGKILL supervisora oraz jednoczesny SIGKILL launchera i supervisora w oknie przed zapisem PID dziecka, odmowę obcych PID, zajęte porty, niezgodny checksum, wspólną blokadę, brak miejsca oraz prywatne ograniczone logi oraz odrzucanie dowiązań twardych bez zmiany pliku źródłowego. Backend przechodzi `tsc --noEmit`.

Rzeczywisty stos został uruchomiony w lokalnym preview 2026-09-08: wszystkie pięć komponentów zgłosiło gotowość, odczytano metryki i ślady w Jaegerze, a Grafana udostępniła trzy skonfigurowane źródła danych oraz dashboard z 14 panelami. Sprawdzenie przez `lsof` potwierdziło wyłącznie nasłuchy loopback; Grafana nie otwiera dodatkowego gRPC na porcie 10000. Powyższa migawka zasobów pochodzi z tego uruchomienia.

Podczas odbioru Loki odpowiadało `/ready` HTTP 200, a jednocześnie odrzucało przyjmowanie logów HTTP 503. Przy około 39 GiB wolnego miejsca działał domyślny próg WAL wynoszący 90% zajętości woluminu. W konfiguracji JARVIS próg ustawiono jawnie na `disk_full_threshold: 0.95`, co na tym woluminie pozostawia około 23 GiB rezerwy; osobny próg nadzoru procesu wynosi 2 GiB. Procentowa rezerwa zależy od rozmiaru woluminu. Mechanizm domyślnego progu i ograniczania zapisów opisuje [kod Loki v3.7.7, wal.go](https://github.com/grafana/loki/blob/v3.7.7/pkg/ingester/wal.go). Zielony healthcheck nie potwierdza zapisu ani odczytu logów.

**Pełny odbiór nadal oczekujący.** Pozostały: potwierdzenie przepływu i odczytu logów po restarcie z poprawionym progiem, link log → trace w Grafanie, zachowanie historii po restarcie, niedostępność Collectora, porównanie obu trybów oraz końcowe CI. Dotychczasowe testy i migawka gotowości nie zastępują tych dowodów.

## Uzupełnienie odbioru preview

8.09.2026 potwierdzono zapis logów po ustawieniu progu WAL 95%, zachowanie wcześniejszych metryk i śladu po restarcie oraz dwa działające jednocześnie stosy. Syntetyczny znacznik trybu operacyjnego dał jeden ślad i 20 logów wyłącznie w tym trybie; po restarcie liczby pozostały takie same. Zatwierdzony zapis sprzętu i niezależna weryfikacja przeszły przy wyłączonym Collectorze.

Chrome: dashboard z rzeczywistymi metrykami i logami, pola modelu pokazujące brak danych oraz link z logu do właściwego śladu Jaeger. Wszystkie trzy źródła Grafany przeszły test połączenia. Hasła i nazwy cookies autoryzacji są odrębne dla obu trybów. Korelacja ślad → logi filtruje `trace_id` jako structured metadata, a nie tekst treści wpisu.

Pierwsze hosted CI [PR #6](https://github.com/artur-t-96/JARVIS/pull/6) zielone; końcowa poprawka i aktualizacja głównej instalacji są odnotowywane w [dzienniku](delivery-state.md). Powyższe testy nie dowodzą pełnego odbioru wizji ani działania prawdziwego dostawcy modelu.
