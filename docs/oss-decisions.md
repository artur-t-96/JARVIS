# Gotowe komponenty open source w JARVIS

Decyzja do realizacji z 8.09.2026. Powiązanie: [roadmapa P01–P02](roadmap.md). Rozpoznano oficjalne wydania i dokumentację; stos opisany poniżej nie jest jeszcze zainstalowany ani odebrany. Dostępność binariów nie dowodzi zgodności całej konfiguracji.

## Observability: wybrany stos lokalny

| Komponent                       | Rola                                                                          | Rozpoznane wydanie macOS arm64                                                                                                                     | Licencja / źródło                                                                                      |
| ------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| OpenTelemetry Collector Contrib | Odbiór OTLP, przetwarzanie, kolejka, odczyt wyłącznie logów JARVIS i routing. | [0.160.0](https://github.com/open-telemetry/opentelemetry-collector-releases/releases/tag/v0.160.0), `otelcol-contrib_0.160.0_darwin_arm64.tar.gz` | [Apache-2.0](https://github.com/open-telemetry/opentelemetry-collector-releases/blob/v0.160.0/LICENSE) |
| Prometheus                      | Trwałe metryki w lokalnym TSDB, reguły oceny stanu.                           | [3.14.0](https://github.com/prometheus/prometheus/releases/tag/v3.14.0), `prometheus-3.14.0.darwin-arm64.tar.gz`                                   | [Apache-2.0](https://github.com/prometheus/prometheus/blob/v3.14.0/LICENSE)                            |
| Loki                            | Zredagowane logi w lokalnym magazynie, powiązanie ze śladami.                 | [3.7.7](https://github.com/grafana/loki/releases/tag/v3.7.7), `loki-darwin-arm64.zip`                                                              | [AGPL-3.0-only](https://github.com/grafana/loki/blob/v3.7.7/LICENSING.md)                              |
| Jaeger + Badger                 | Trwałe ślady bez dodatkowego serwera bazy.                                    | [2.20.0](https://github.com/jaegertracing/jaeger/releases/tag/v2.20.0), `jaeger-2.20.0-darwin-arm64.tar.gz`                                        | [Apache-2.0](https://github.com/jaegertracing/jaeger/blob/v2.20.0/LICENSE)                             |
| Grafana OSS                     | Panele technologii, procesów i modelu oraz przeglądanie metryk/logów/śladów.  | [13.2.1 OSS](https://grafana.com/grafana/download/13.2.1?edition=oss&platform=mac), `darwin_arm64.tar.gz`                                          | AGPLv3, edycja OSS wskazana w źródle pobrania.                                                         |

Wersje są kandydatami do przypięcia po sprawdzeniu razem. Instalator ma używać manifestu zawierającego oficjalny URL, SHA-256, architekturę i licencję; nie pobiera `latest` podczas zwykłego startu. Rzeczywiste sumy należy pozyskać z wydania i zatwierdzić przed instalacją. Nie wpisujemy wymyślonych sum ani nie uznajemy pobranego pliku za zaufany na podstawie samej nazwy.

Grafana jest gotowym panelem diagnostycznym. Własny panel JARVIS pozostaje miejscem spraw, decyzji i pracy ludzi. Nie budujemy kolejnej własnej bazy śladów, agregatora logów ani narzędzia do rysowania dashboardów technicznych.

## Dlaczego ten zestaw

Wszystkie wybrane projekty udostępniają oficjalne binaria dla tego Maca i licencje open source. Cały zestaw może działać bez Dockera i usług innych aplikacji. Wariant Jaeger ma oficjalny przykład [trwałego Badger](https://github.com/jaegertracing/jaeger/blob/v2.20.0/cmd/jaeger/config-badger.yaml), a Grafana wspiera [źródło Jaeger](https://grafana.com/docs/grafana/latest/datasources/jaeger/).

[Tempo 3.0.3](https://github.com/grafana/tempo/releases/tag/v3.0.3) nie publikuje gotowego binarium macOS. Nie jest wyborem na pierwszy natywny zestaw; możliwość kompilacji ze źródeł nie została zweryfikowana. [Alloy 1.19.2](https://github.com/grafana/alloy/releases/tag/v1.19.2) jest dostępną alternatywą dla Collectora, ale nie dokładamy obu kolektorów bez odrębnej potrzeby.

Osobna platforma LLM nie jest warunkiem pierwszego etapu. Ślady wywołań, tokeny, koszt, błędy i wyniki ewaluacji otrzymują miejsce w tym samym standardzie OTel. Ewentualny Langfuse wymaga osobnej decyzji o wartości dodatkowych usług i utrzymaniu; nie jest obecnie wdrożony. Phoenix ma [Elastic License 2.0](https://arize.com/docs/phoenix/self-hosting/license), więc nie opisujemy go jako zamiennika na licencji OSI open source.

## Przepływ danych

1. Metryki aplikacji są wystawiane przez oficjalny eksporter OTel/Prometheus na dedykowanym lokalnym porcie. Prometheus pobiera również ograniczone metryki komponentów tego stosu. Nie otwieramy anonimowo danych domenowych API.
2. Collector przyjmuje ślady JARVIS przez OTLP i przekazuje je do Jaeger. Konfiguracja jawnie włącza trwały Badger; domyślny magazyn w pamięci nie spełnia odbioru.
3. Collector czyta wyłącznie rotowane pliki logów zarządzanych procesów JARVIS. [Filelog receiver](https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/v0.160.0/receiver/filelogreceiver) zachowuje offsety w lokalnym storage i przekazuje dane przez [OTLP do Loki](https://grafana.com/docs/loki/latest/send-data/otel/). Ścieżki są ustalone; brak odczytu całego hosta.
4. Grafana ma provisionowane źródła Prometheus/Loki/Jaeger i wersjonowane panele. Link ze sprawy może wyszukać jej korelację tylko w konsoli uprawnionego operatora.

OpenTelemetry nie zastępuje audytu biznesowego ani ledgeru skutków. Odbiór operacji nadal opiera się na niezależnej weryfikacji danych; utracony ślad nie zmienia rezultatu biznesowego.

## Dostęp i izolacja

- Wszystkie listenery, również gRPC, query, health i pprof, wymagają jawnego loopback albo wyłączenia. Nie wystarczy zmiana samego portu panelu.
- Grafana bez dostępu anonimowego, z lokalnym kontem operatora i prywatnym magazynem hasła. Wyłączyć reporting, sprawdzanie aktualizacji i pobieranie dodatków w tle; zweryfikować [ustawienia Grafany](https://github.com/grafana/grafana/blob/v13.2.1/conf/defaults.ini).
- Stos jest konsolą administratora tej instalacji. Loopback i etykieta `tenant` nie zapewniają autoryzacji tenantów; nie udostępniać wspólnej Grafany jako panelu zwykłych pracowników.
- Dwa środowiska mają osobne katalogi, konfiguracje i porty. Binariów można używać wspólnie, ale danych i kont nie kopiujemy między lab i operational.
- Eksport poza komputer jest wyłączony. Brak automatycznego wykrywania sieci, logów, sekretów, procesów lub usług pozostałych aplikacji.

## Retencja i zasoby

Proponowane wartości startowe do pomiaru: metryki 14 dni, logi 7 dni, ślady 48 godzin. Objętość danych i RAM/CPU trzeba zmierzyć na rzeczywistym natywnym zestawie przed odbiorem P01. Retencja czasowa nie jest twardym limitem dysku: uwzględnić WAL/kompaktowanie [Prometheusa](https://prometheus.io/docs/prometheus/latest/storage/) i czyszczenie magazynu [Loki](https://grafana.com/docs/loki/latest/configure/storage/).

Kolejki i retry są ograniczone; awaria kolektora nie może blokować Core. Dodać kontrolę wolnego miejsca, limit lokalnych plików logów, retencję Badger i procedurę czyszczenia wyłącznie własnych danych diagnostycznych. Przy presji zasobów ograniczyć telemetrię i zgłosić degradację zamiast zatrzymywać sprawy biznesowe.

## Dane modelu i prywatność

Zapisywać provider, model żądany/rzeczywisty, rodzaj operacji, czasy, status, klasę błędu, tokeny wejścia/wyjścia oraz wersję cennika, walutę i szacowany koszt. Brak użycia lub ceny jest brakiem wartości, nie zerem. Konwencje GenAI mają status rozwojowy: [spans](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-spans.md) i [metryki](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-metrics.md); implementacja przypina wersję schematu.

ID sprawy/wykonania/kroku/usage mogą być polami korelacji śladów i logów. Nie trafiają do etykiet metryk o nieograniczonej liczbie wartości. Nazwiska, prompty, odpowiedzi, dokumenty, argumenty narzędzi, nagłówki i sekrety są wyłączone. Redakcja następuje przed eksportem i jest testowana znacznikami kontrolnymi.

## Inne zastosowania gotowego kodu

| Obszar              | Kierunek                                                                                                                                                                                                        |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Głos                | Zachować rzeczywiście działający whisper.cpp; rozwinąć obsługę polskiej rozmowy i odczytu systemowego.                                                                                                          |
| UI, walidacja, baza | Rozwijać istniejące React/Vite, Zod, Fastify i SQLite. Nie zastępować ich własnymi ogólnymi frameworkami.                                                                                                       |
| Dokumenty           | W P09 wybrać utrzymywane biblioteki generowania DOCX/PDF po próbie rzeczywistego szablonu, czcionek PL, licencji i renderowania.                                                                                |
| Ewaluacja i jakość  | Obecny Node test runner oraz testy procesowe; gotowe narzędzie do oceny odpowiedzi modelu tylko z jasnym zbiorem danych i bez wysyłania danych HR. Kod QUALRIX jest opcjonalnym źródłem adaptacji po odczycie.  |
| Procesy trwałe      | Zachować zatwierdzony Core oraz jego test SIGKILL. Historyczna propozycja Temporal wymaga osobnego, ograniczonego porównania przy wykazanej luce; nie przepisujemy działającego mechanizmu bez dowodu potrzeby. |
| ERP                 | Czytać i adaptować reguły/moduły z ATLAS, NEXUS, COMPASS i ELEVATE. Dla skopiowanego kodu zapisać repo, SHA, ścieżkę, zakres zmian i przeniesione testy. Inspiracja regułą nie jest przeniesieniem modułu.      |

## Warunek uznania integracji za wykonaną

Wersjonowane konfiguracje i panele, manifest binariów, własne procesy, realna telemetria, dowód trwałości po restarcie, próba awarii odbiornika, kontrola listenerów/eksportu i pomiar zasobów. Samo dodanie zależności npm, linku do Grafany lub zrzutu przykładowego dashboardu nie wystarcza.
