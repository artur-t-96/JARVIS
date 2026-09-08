# Pełny JARVIS — roadmapa wykonawcza

Właściciel realizacji: Codex. Data bazowa: 8.09.2026. Audytowana wersja: `038aa59903ddbb7333bbfe98403e1f0bab01486e`.

Punktem odniesienia pozostaje [wizja v0.4](vision.md) i zatwierdzony przez użytkownika plan „Pełny JARVIS lokalnie”. Ta roadmapa określa prace do ukończenia produktu, a nie nowy, mniejszy zakres. Dowody trafiają do [macierzy pokrycia](coverage.md), szczegółowe scenariusze do [planu odbioru](acceptance.md), a stan bieżącej paczki do [dziennika realizacji](delivery-state.md).

## Rezultat końcowy

JARVIS zna firmę w granicach dostępnych, datowanych źródeł. Przyjmuje potrzebę, wyjaśnia braki, przygotowuje zakres, organizuje pracę ludzi i narzędzi, pilnuje terminów oraz pokazuje potwierdzony rezultat albo konkretną blokadę. Całość działa lokalnie dla Dynaminds i drugiej konfiguracji firmy na tym samym kodzie.

Zakres obejmuje dziewięć kompetencji i dziesięć elementów rdzenia. ERP operacyjny kończy się na zaakceptowanym pakiecie do rozliczenia. Księgowanie, płatności i listy płac pozostają poza zakresem. Operacje fizyczne oraz decyzje biznesowe mają rzeczywistego autora poświadczenia. Sam zapis zadania nie dowodzi wykonania.

## Granice realizacji

- Modyfikujemy wyłącznie JARVIS. ATLAS, NEXUS, COMPASS, ELEVATE i QUALRIX można czytać oraz kopiować z nich wybrane fragmenty; ich kod, dane, konfiguracje, sekrety, procesy i wdrożenia pozostają bez zmian.
- Domyślnym środowiskiem budowy i prób jest wydzielone laboratorium JARVIS na danych syntetycznych. Tryb operacyjny ma osobne bazy, konta, pliki i uprawnienia.
- Używamy Node 22.23.0, npm i narzędzi natywnych. Bez lokalnego Dockera, globalnych instalacji usług i pożyczania infrastruktury innych aplikacji.
- Korzystamy z gotowych projektów open source tam, gdzie rozwiązują problem infrastrukturalny. JARVIS dostarcza integrację, model firmy i reguły biznesowe. Wybory oraz licencje zapisujemy w [decyzjach OSS](oss-decisions.md).
- Model otrzymuje minimalny, kontrolowany kontekst. Sekrety i dokumenty HR nie są materiałem dla telemetrii ani niekontrolowanego kontekstu modelu. Uprawnienia i zgody sprawdza kod także po wznowieniu pracy.
- Kod i testy adaptera zewnętrznego mogą powstać lokalnie. Jego aktywacja na innych systemach wymaga oddzielnej dyspozycji; jej brak nie blokuje ukończenia lokalnego produktu.

## Rzeczywisty punkt startu

Istnieją Core, własny magazyn domenowy, konta, rozmowy, profile, inicjatywy, laboratorium HTTP, panel React i lokalny whisper.cpp. Bieżąca baza dowodów zawiera 97 testów i demonstrator 57 zatwierdzonych poleceń. PR #2 i #3 są scalone. To baza techniczna do dalszej realizacji, a nie odbiór całej wizji.

Najważniejsze wykryte braki:

1. OpenTelemetry zapisuje ślady w pamięci procesu. Nie działa jeszcze trwały backend OSS, kolektor ani gotowy panel observability. Globalny span workera może błędnie przypisywać korelację równoległym żądaniom HTTP.
2. Onboarding tworzy zadania tekstowe, ale nie wiąże ich wystarczająco z wykonawcami HR/IT, wydaniem urządzenia, wersją dokumentu i poświadczeniem dostępu. Ogólny dowód nie wystarcza do biznesowego potwierdzenia gotowości.
3. Asystent ma ograniczony dobór kontekstu. Adapter Claude jest sprawdzony kontrolowanymi odpowiedziami; w JARVIS nie skonfigurowano własnego klucza do rzeczywistego odbioru modelu.
4. Dziewięć modułów ma lokalne przejścia i testy. Pełna macierz odmów, zmian zakresu, opóźnień i odbiorów użytkownika dla każdej kompetencji wymaga domknięcia.
5. Powtarzalny lokalny start, aktualizacja i restore istnieją; odbiór całego produktu po aktualizacji, z pełnymi procesami i trwałą telemetrią, jest nadal przed nami.

## Sposób prowadzenia prac

Codex wybiera kolejne zadanie z zależności poniżej, realizuje je i sam przechodzi normalną ścieżkę dostarczenia. Nie wymaga od użytkownika zatwierdzania kolejnych PR-ów, wyboru nazw bibliotek ani codziennego przypominania o pracy. Wyjątki wymagające rzeczywistej informacji od człowieka są wymienione na końcu dokumentu.

Każda paczka otrzymuje ograniczony zakres, test właściwego zachowania, przegląd diffu, commit, PR, wynik wymaganych kontroli CI, merge i sprawdzenie właściwej wersji lokalnej. Prace idą w osobnym worktree; nie przejmujemy cudzych zmian. Kontrole lokalne są krótkie i dotyczą zmiany; pełne bramki uruchamia CI. Zmiany widoczne dla użytkownika sprawdzamy także w przeglądarce.

Można równolegle prowadzić analizę źródeł, backend i osobne widoki, jeśli zakres plików i kontrakty są ustalone. Jeden wykonawca integruje paczkę i zapisuje dowód odbioru. Nie rozpoczynamy wielu zależnych modułów tylko po to, aby oznaczyć je jako „w toku”.

Statusy: `do wykonania`, `w toku`, `do odbioru`, `odebrane`, `blokada zewnętrzna`. Obecność kodu lub zielony test jednego przejścia nie oznacza `odebrane`. Nie podajemy procentu ukończenia opartego na liczbie plików czy ekranów.

Przy wznowieniu najpierw czytamy dziennik, sprawdzamy aktualny Git/PR/CI i własne procesy, następnie kontynuujemy niedokończoną paczkę. Nie zaczynamy ponownie całego audytu. Zmienione ustalenia zapisujemy wraz z przyczyną i wpływem na zależności.

## Kolejność i zależności

| Paczka | Zakres                                            | Zależność                                     | Wynik umożliwiający dalszą pracę                                         |
| ------ | ------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------ |
| P00    | Roadmapa, rzetelne statusy i plan odbioru         | Obecny main                                   | Jedno źródło kolejności, braków i dowodów.                               |
| P01    | Gotowy stos observability OSS                     | P00                                           | Lokalne, trwałe metryki, logi i ślady z odtwarzalnym uruchomieniem.      |
| P02    | Instrumentacja aplikacji, procesów i modelu       | P01; naprawa kontekstu może ruszyć równolegle | Właściwa korelacja, pomiar pracy i widoczne awarie bez wpływu na skutki. |
| P03    | Sprawa, odpowiedzialność ludzi i kryteria odbioru | P00, P02 do odbioru                           | Wspólny mechanizm organizowania i potwierdzania pracy.                   |
| P04    | Model firmy, kontrolowane odczyty i rozmowa       | P03                                           | Asystent rozpoznaje potrzebę i przygotowuje wykonalny zakres.            |
| P05    | Pełny obieg wyposażenia                           | P03–P04                                       | Potwierdzone rezerwacje, wydania, zwroty i rozbieżności.                 |
| P06    | Pełny onboarding                                  | P03–P05, P08a, P09a                           | Pierwsza osoba przygotowana na konkretny start, z dowodami.              |
| P07    | Pełna sprawa IT i rozpoznanie                     | P01–P04                                       | Drugi demonstrator: naprawa własnej usługi i niezależny test.            |
| P08    | Zakupy, dostawcy i licencje                       | P03, P05                                      | Dostawa i przydział potwierdzone, koszt oraz odnowienia widoczne.        |
| P09    | Dokumenty i raporty                               | P03–P04                                       | Kompletne wersje, źródła, akceptacja i gotowy eksport.                   |
| P10    | Sprzedaż → realizacja → pakiet rozliczeniowy      | P03, P08–P09                                  | Odebrana realizacja zatwierdzonego zakresu.                              |
| P11    | Rekrutacja i pełny offboarding                    | P06, P08–P09                                  | Zamknięty cykl konkretnej współpracy.                                    |
| P12    | Proaktywność i przegląd kierownika                | P05–P11                                       | Trafne inicjatywy oparte na danych oraz obsługa zobowiązań.              |
| P13    | Personalizacja, rozszerzenia i głos               | P04, P06, P12                                 | Druga firma na wspólnym kodzie, równoważny tekst i głos.                 |
| P14    | Instalacja, aktualizacja i pełny odbiór           | P01–P13                                       | Cała wizja odebrana na powtarzalnej lokalnej instalacji.                 |

P03 i P04 mogą rozwijać kontrakty podczas budowy P01. P07 może być realizowane równolegle z P06 po ustaleniu wspólnej sprawy. Przed odbiorem P06 wykonujemy P08a (minimalny rejestr wymaganych dostępów i miejsc licencyjnych) oraz P09a (dokumenty wymagane przez onboarding, ich źródła i zaakceptowane wersje). Są to wcześniejsze części P08/P09, zależne od P03–P05, a nie od ukończonego onboardingu. Bazowe dwa profile i obsada HR/IT/przełożonego powstają w P03; P13 rozszerza tę konfigurację i nie jest warunkiem rozpoczęcia P06. Odbiory następują dopiero po spełnieniu zależności. Nie ma sztucznych dat dziennych: harmonogram jest sterowany zakończeniem paczek i wykrytymi problemami.

## P00 — plan i dowody

- Zapisać tę roadmapę, decyzje OSS, scenariusze odbioru i dziennik stanu.
- W macierzy odróżnić dowód techniczny od pełnego odbioru kompetencji. Ujawnić ograniczenia R09 oraz K03.
- Zarejestrować obecny SHA, PR-y i znane braki. Każdy późniejszy dowód ma wskazywać wersję aplikacji i środowisko.

**Odbiór:** wszystkie K01–K09 i R01–R10 wskazują paczkę oraz warunek zamknięcia; kolejny wykonawca potrafi podjąć jednoznacznie następne zadanie.

## P01 — gotowe observability open source

- Uruchomić natywnie OpenTelemetry Collector Contrib, Prometheus, Loki, Jaeger z trwałym magazynem i Grafana OSS. Dobór uzasadnia [decyzja OSS](oss-decisions.md); przed przypięciem pobrań sprawdzić wersje, architekturę, licencje i sumy.
- Dostarczyć zarządzanie `install/start/stop/status/doctor` o zamkniętej liście procesów. Wszystkie binaria, konfiguracje, dane i logi należą do katalogu JARVIS. Sprawdzić konflikty portów i tożsamość procesu przed zatrzymaniem.
- Wygenerować konfiguracje wiążące wyłącznie loopback; konta panelu, brak anonimowego dostępu, brak wysyłki telemetrii poza komputer. Backendów administracyjnych nie udostępniać jako API dla zwykłych użytkowników firmy.
- Rozdzielić dane lab/operational, zapewnić skończoną retencję, limit kolejki, logów i dysku. Zmierzyć rzeczywiste zużycie zasobów na tym Macu; limity mają wynikać z próby, a nie tylko deklaracji.
- Dostarczyć dane źródłowe i panele Grafany jako wersjonowane pliki. Własny ekran JARVIS pokazuje decyzje i odsyła do diagnostyki; nie rozwijamy własnego odpowiednika Grafany czy bazy śladów.

**Odbiór:** rzeczywiste metryka, log i ślad są wyszukiwalne po restarcie usług; instalacja jest powtarzalna; brak nasłuchu poza loopback i kolekcji danych innych aplikacji. Każdy proces ma health i wersję. Wyłączenie stosu nie przerywa zatwierdzonej operacji JARVIS.

## P02 — telemetria rzeczywistego działania

- Naprawić globalny kontekst workera: izolacja równoległych żądań i jawne przekazywanie kontekstu asynchronicznego.
- Instrumentować HTTP, podjęcie wykonania, próbę kroku, narzędzie, reconcile, weryfikację i model. Powiązać sprawę, wykonanie, próbę i dowód bez przesyłania argumentów narzędzia czy danych HR. Po długim oczekiwaniu i restarcie stosować trwałą korelację oraz linki śladów.
- Eksportować standardowymi bibliotekami OTel, z ograniczoną kolejką i czasem wysyłki. Kontrolować wyłącznie jawne adresy własnego kolektora.
- Mierzyć dostępność HTTP i workera osobno, wiek kopii, bazy/dysk, zaległości, terminy, nieznane skutki i błędy weryfikacji. ID spraw, osób i wykonań nie są etykietami metryk.
- Model: liczba wywołań, tokeny wejściowe/wyjściowe, czas, błędy i koszt z wersjonowanego cennika. Brak cennika oznacza brak wiedzy o koszcie. Ewaluacja odpowiedzi jest osobnym wynikiem od technicznego sukcesu HTTP.
- Reguły problemów mają deduplikację, termin ważności obserwacji, właściciela, wyciszenie i niezależne potwierdzenie ustąpienia.

**Odbiór:** zatrzymany worker przy HTTP200 jest problemem; stara obserwacja nie jest zielonym stanem; równoległe żądania nie dzielą błędnej korelacji. Jedna zatwierdzona operacja z odtworzeniem daje czytelną historię bez podwójnego skutku. Utrata kolektora i zapełnienie kolejki nie zatrzymują procesu biznesowego.

## P03 — sprawy, ludzie i odbiór

- Ujednolicić sprawę i rewizję zakresu, właściciela, termin, zobowiązania oraz powiązane wykonania.
- Przygotować bazowe dwa profile firmy: obsada ról HR/IT/przełożonego, wariant pracownika/konsultanta i typowane wymagania szablonów. Zatwierdzane wersje tych profili muszą działać przed odbiorem onboardingu; P13 rozwija później pełną personalizację.
- Zadania otrzymują właściwego wykonawcę według roli/profilu i możliwość jawnego przekazania. Nie przypisywać całego onboardingu nowej osobie.
- Osobne stany: pytanie o dane, prośba o decyzję, zgoda na konkretny zapis, oczekiwanie na pracę człowieka, poświadczenie i odbiór biznesowy.
- Dodać typowane warunki odbioru: wskazany zasób, dokument w konkretnej wersji, dostęp, dostawa, wynik testu. Ogólny opis dowodu nie zastępuje wymaganego rezultatu.
- Wyjątek ma podstawę, zatwierdzającego, właściciela ryzyka, termin i sposób zamknięcia. Zmiana zakresu unieważnia niepasujące zgody i odbiory.
- Panel sprawy pokazuje rezultat, brakujące warunki, osoby, terminy i następne działanie; lista decyzji jest osobnym miejscem pracy.

**Odbiór:** delegowanie, odmowa, opóźnienie, częściowy wynik i zmiana zakresu działają po restarcie. Nie da się odebrać niepełnej rewizji przez dodanie dowolnego komentarza.

## P04 — kontekst firmy i rozmowa

- Rozwinąć kontrolowane odczyty firm, osób, ról, okresów współpracy, urządzeń, aplikacji, dokumentów i spraw. Źródło ma datę, wersję, klasyfikację i informację o aktualności.
- Określić krotność współprac osoby w konfiguracji: zachować bezpieczny domyślny zakaz niezgodnych okresów, a w drugim profilu jawnie sprawdzić dozwolone równoległe współprace projektowe. Przygotować migrację obecnego ograniczenia jednej otwartej współpracy. Powiązać obowiązki i przydziały z właściwym okresem; starsze niejednoznaczne rekordy wymagają przypisania, bez zgadywania.
- Rozwiązywać niejednoznaczne nazwy przez pytanie; osoba i konkretna współpraca pozostają różnymi rekordami. Związki wymagają sprawdzenia tenant/RBAC przy odczycie i wykonaniu.
- Rozmowa przechowuje szkic potrzeby, uzgodnione dane i zakres. Odróżnia odpowiedź, pytanie, propozycję planu oraz brak kompetencji. Linkuje wynik i pokazuje co pozostało.
- Zasady firmy są wersjonowane i aktywowane po potwierdzeniu uprawnionego człowieka. Model proponuje zmianę, ale jej nie ustanawia.
- Adapter modelu otrzymuje schematy faktycznych narzędzi, minimalny kontekst z limitami i identyfikatory osób. Dodać zbiór ewaluacyjny po polsku: poprawne zadania, niejednoznaczność, nieaktualne dane, odmowa i wrogie instrukcje w źródłach.
- Rzeczywisty dostawca wymaga własnego klucza JARVIS. Cały pozostały zakres rozwijamy i odbieramy lokalnie niezależnie od jego dostępności; odbioru chmurowego nie zastępujemy stubem.

**Odbiór:** „przygotuj laptop dla Ani” ustala właściwą osobę/współpracę, termin i wymagania, proponuje dostępne wyposażenie i kontrolowany plan. Po zmianie zakresu pyta o nową zgodę. Nie ujawnia cudzych rekordów ani nie twierdzi, że wykonał nieobsługiwane działanie.

## P05 — wyposażenie i inwentaryzacja (K05)

- Domknąć lokalizacje, stan techniczny, właściciela ewidencji, rezerwację, wydanie, zwrot, serwis i wycofanie z uzasadnieniem.
- Rezerwację i przydział powiązać ze sprawą, osobą, konkretną współpracą oraz terminem. Własność przez okres współpracy musi być zapisana i migrowana, aby offboarding jednego projektu nie odbierał zasobów drugiego; obsłużyć wygaśnięcie, zamianę sprzętu oraz konflikt równoległych przydziałów.
- Wydanie i zwrot wymagają poświadczenia uprawnionej osoby. Spis z natury zapisuje zaobserwowany stan i rozbieżność względem ewidencji.
- Dane importowane trafiają najpierw do podglądu z pochodzeniem i wykazem konfliktów; zatwierdzony import korzysta z własnych komend JARVIS.

**Odbiór:** rozmowa → rezerwacja → zadanie IT → potwierdzone wydanie → przypisanie. Brak urządzenia staje się blokadą/zapotrzebowaniem, a rozbieżność pozostaje otwarta do wyjaśnienia.

## P06 — kompletny onboarding (K03)

- Konfiguracje dla pracownika wewnętrznego i konsultanta klienta: HR/IT/przełożony, wymagane dokumenty, sprzęt, dostępy i daty.
- Uzgodniona potrzeba tworzy sprawę konkretnego okresu współpracy, zadania z odpowiedzialnościami i powiązane operacje modułów.
- Gotowość sprawdza faktycznie wydany właściwy sprzęt, zaakceptowane wersje dokumentów oraz poświadczenia wymaganych dostępów. Wyjątki są jawnie rozstrzygane.
- Aktywacja respektuje datę startu i odbiór. Przesunięcie terminu, anulowanie oraz powrót tej samej osoby nie dziedziczą automatycznie dawnych poświadczeń.

**Odbiór:** pełny przebieg przez panel/rozmowę w dwóch profilach firmy, wraz z odmową, brakiem sprzętu, spóźnieniem IT, zmianą dokumentu i restartem podczas oczekiwania. Dowód wskazuje kto potwierdził każdy warunek.

## P07 — IT, bezpieczeństwo i rozpoznanie (K09)

- Katalog własnych usług, urządzeń, obserwacji i zatwierdzonych procedur. Każdy kolektor ma zamknięty zakres i widoczne pochodzenie obserwacji.
- Sprawa: obserwacja → diagnoza z dowodami → zakres → zgoda → procedura → niezależny test → odbiór lub eskalacja.
- Co najmniej niedostępna usługa i przypadek certyfikatu we własnym laboratorium. Sprawdzić niepowodzenie naprawy i potwierdzenie stanu po wznowieniu.
- Incydent powiązać z konkretnym celem, wykonaniem i jego aktualnym wynikiem weryfikacji. Ręczna notatka „naprawione” nie zastępuje testu, a stary wynik innej usługi nie zamyka sprawy.
- W raporcie rozdzielić obserwację, hipotezę, wykonane działanie i potwierdzony stan. Nie skanować innych usług ani sieci firmy.

**Odbiór:** rzeczywista kontrolowana awaria laboratorium, zatwierdzona naprawa, zewnętrzny wobec wykonawcy odczyt wyniku i ślad w OSS. Nieudana weryfikacja blokuje sukces.

## P08 — zakupy, dostawcy i licencje (K06)

**P08a przed P06:** minimalny rejestr wymaganych dostępów, poświadczenie dla właściwej osoby/współpracy oraz powiązanie miejsca licencji, jeśli wymaga go szablon. Zależności: P03–P05. Pełny obieg zakupowy poniżej może zostać domknięty później.

- Zapotrzebowanie, wersje ofert dostawców, porównanie, zgoda kosztowa i własna ewidencja zamówienia.
- Częściowe dostawy, braki, różnice względem zamówienia i potwierdzenie przyjęcia. Każdy dokument/pozycja przyjęcia ma biznesową tożsamość; ponowne zgłoszenie tej samej dostawy z nowym kluczem komendy nie zwiększa ilości ani liczby urządzeń. Dopiero przyjęta pozycja może tworzyć dostępne wyposażenie.
- Licencje: umowa/okres, miejsca, przydziały, właściciele, terminy i koszt w walucie. Przydział miejsca oraz potwierdzenie dostępu do usługi są osobnymi faktami.
- Zmiana ceny/ilości po akceptacji wymaga nowej decyzji. Odnowienia stają się inicjatywami, nie automatycznymi zakupami.

**Odbiór:** brak sprzętu z onboardingu → zapotrzebowanie → wybór → zgoda → częściowa i pełna dostawa → wydanie. Konflikt ostatniego miejsca licencji nie powoduje nadprzydziału. Brak wysyłki/płatności jest jawny.

## P09 — dokumenty i raporty (K08)

**P09a przed P06:** wymagane dokumenty onboardingu, źródła, kontrola kompletności, zaakceptowana wersja i powiązanie z warunkiem sprawy. Zależności: P03–P04. Pełny katalog raportów i eksportów poniżej jest dalszą częścią tej paczki.

- Szablony, wymagane pola, wersje, klasyfikacja i źródła. Rewizja może jawnie odświeżyć źródła; nowa treść nie udaje oparcia na nowszych danych przy zachowaniu starych referencji. Akceptacja przypięta do konkretnej wersji; zmiana źródła wykrywa nieaktualność.
- Lokalne pliki dowodów z manifestem, typem, rozmiarem, SHA-256 i kontrolą dostępu. Nie wykonywać zawartości importowanego pliku ani instrukcji w dokumencie.
- Raporty: gotowość startów, wyposażenie, zobowiązania, dostawy, realizacja i materiały do rozliczenia. Braki danych są widoczne.
- Zapewnić praktyczny eksport dokumentów, w tym DOCX/PDF, gdy wymaga tego szablon użytkowy; użyć sprawdzonych bibliotek OSS i wizualnie sprawdzić wynik. Markdown/JSON pozostają formatami danych i prostych materiałów.

**Odbiór:** kompletny dokument z lokalnych źródeł → kontrola braków → akceptacja → czytelny eksport. Zmienione źródło, uszkodzony plik i brak uprawnienia blokują fałszywe potwierdzenie.

## P10 — sprzedaż i realizacja (K01, K07)

- Zaadaptować potrzebne reguły ATLAS: firma, kontakt, szansa, etap, kalkulacja, oferta i historia działań, z własnym modelem danych i śladem pochodzenia kodu.
- Oferta ma wersję, koszty/warunki i akceptację. Określić jedną obowiązującą ofertę albo jawny wariant wyboru; konkurencyjne zaakceptowane oferty nie mogą przypadkowo stać się równoległymi zobowiązaniami. Przekazanie lub wysyłka są poświadczeniami konkretnego zdarzenia; nie wynikają z samej zmiany etapu.
- Zaadaptować reguły ELEVATE: uzgodniony zakres, właściciel realizacji, potwierdzenie przekazania, zadania, dowody i odbiór.
- Czas/koszt, korekta zakresu oraz pakiet rozliczeniowy odnoszą się do odebranej rewizji. Zachować waluty i źródła; nie mieszać szkicu z zaksięgowaną należnością.

**Odbiór:** szansa → zatwierdzona oferta → potwierdzony następny krok → przyjęcie realizacji → zadania i dowody → odbiór → zaakceptowany pakiet. Odrzucony odbiór i zmiana oferty nie zachowują nieaktualnych akceptacji.

## P11 — rekrutacja i odejście (K02, K04)

- Rekrutacja: zatwierdzone zapotrzebowanie, odpowiedzialność, kandydat/aplikacja, materiały, zadania rozmów, decyzje i powiązanie z okresem współpracy. Wykorzystać sprawdzone reguły NEXUS.
- Dostęp do materiałów kandydata jest ograniczony. Ocena modelu jest wsparciem; decyzja uprawnionego człowieka ma autora i podstawę.
- Offboarding korzysta z konkretnej współpracy, spraw do przekazania, rzeczywistych przydziałów sprzętu/licencji i zarejestrowanych dostępów. Wykorzystać reguły lifecycle COMPASS.
- Zamknięcie wymaga przejęcia odpowiedzialności, potwierdzonych zwrotów/zmian dostępów lub rozstrzygniętych wyjątków. Nie wycofywać zasobów nadal należących do innej aktywnej współpracy tej osoby. Zasób współdzielony ma jawne powiązania i decyzję o dalszym użyciu, a nie domyślne skasowanie wszystkich przydziałów osoby.

**Odbiór:** rekrutacja → decyzja → onboarding tej współpracy → offboarding. Brak materiałów, odmowa, zmiana daty odejścia, nieoddany sprzęt i niepotwierdzony dostęp nie kończą się pozornym sukcesem.

## P12 — proaktywność i zarządzanie pracą

- Rozszerzyć jawne reguły o braki dokumentów, nieprzypisane wyposażenie, wygasające dostępy/licencje, zatrzymane realizacje i przeterminowane decyzje.
- Każda inicjatywa wskazuje fakt źródłowy, datę, przyczynę, właściciela, termin i proponowany plan. Deduplikacja obejmuje restart i ponowne skanowanie.
- Obsłużyć odłożenie, wyciszenie, ręczne wstrzymanie, eskalację i zakończenie po niezależnym potwierdzeniu ustąpienia przyczyny.
- Przegląd kierownika: potwierdzone rezultaty, bieżące blokady, zobowiązania, terminy i koszty z widocznymi brakami. Propozycje ulepszenia procedur wymagają zatwierdzenia nowej wersji.

**Odbiór:** długotrwała syntetyczna symulacja czasu generuje właściwe inicjatywy, nie powiela spraw i respektuje wyciszenia. Kierownik może z przeglądu przejść do konkretnej decyzji i jej uzasadnienia.

## P13 — konfiguracja firmy, rozszerzenia i głos

- Profile: role i ich obsada, pola/formularze, etapy, szablony, terminy, ścieżki decyzji oraz strefa czasowa. Zmiana nie modyfikuje wstecz już uzgodnionego zakresu.
- Wersjonowane rozszerzenia mają kontrakt, schemat, uprawnienia, zgodność z Core, test recovery i sposób wyłączenia. Model nie instaluje dowolnego kodu.
- Ta sama kompetencja działa dla Dynaminds i drugiej firmy bez gałęzi kodu zależnej od nazwy firmy. Panel i asystent respektują tę samą konfigurację.
- Mikrofon uruchamiany przyciskiem, widoczna i edytowalna transkrypcja lokalnym whisper.cpp, odczyt systemowy, anulowanie i obsługa odmowy mikrofonu. Głos nie omija zgód ani uprawnień.

**Odbiór:** identyczny scenariusz tekstem i nagraniem przygotowuje równoważny plan. Prawdziwy mikrofon ma oddzielny dowód w profilu użytkownika. Dwa profile przechodzą komplet kompetencji i próby izolacji.

## P14 — kompletny lokalny produkt

- Powtarzalna instalacja i aktualizacja z przypiętymi zależnościami, manifestem buildów oraz kontrolą wymaganych migracji.
- Jawne procedury kopii, weryfikacji, odtwarzania i odwołania dostępu. Odtworzenie danych bez przywracania aktywnych sesji i bez powtórzenia skutków.
- Zestaw diagnostyczny bez sekretów, spis komponentów/licencji, własny sejf, limity zasobów, oddzielne dane testowe i operacyjne oraz czytelne instrukcje operatora.
- Odbiór wszystkich K/R zgodnie z macierzą; rzeczywiste SIGKILL, utrata odpowiedzi po zapisie, niedostępna telemetria, restart i aktualizacja w trakcie oczekiwania.
- Sprawdzić rzeczywisty interfejs użytkownika, eksporty dokumentów i panele OSS na dokładnie zainstalowanym SHA. Nie zastępować tego demonstratorem API.

**Odbiór końcowy:** wszystkie wymagania wizji mają wynik, dowód i wersję, krytyczne luki są zamknięte, instalacja jest powtarzalna. Warunkowe adaptery produkcyjne raportujemy oddzielnie. Czat, ekran ERP, uruchomiona Grafana ani dwa demonstratory samodzielnie nie zamykają produktu.

## Pokrycie wymagań przez paczki

| ID wizji                        | Paczki prowadzące do pełnego odbioru |
| ------------------------------- | ------------------------------------ |
| R01 rozpoznanie                 | P01, P07                             |
| R02 model firmy                 | P04, P09                             |
| R03 pamięć zasad                | P04, P12, P13                        |
| R04 trwałe procesy i ludzie     | P03, P06, P11, P14                   |
| R05 kontrolowane narzędzia      | P02–P11, P13, P14                    |
| R06 konfiguracje i rozszerzenia | P13, P14                             |
| R07 dowody i weryfikacja        | P03, P07, P09, P14                   |
| R08 sprawy i odbiór             | P03, P06, P10, P11                   |
| R09 observability               | P01, P02, P12                        |
| R10 rozmowa, głos, panel        | P04, P06, P12, P13                   |
| K01 sprzedaż                    | P10                                  |
| K02 rekrutacja                  | P11                                  |
| K03 onboarding                  | P06                                  |
| K04 offboarding                 | P11                                  |
| K05 inwentaryzacja              | P05                                  |
| K06 zakupy/licencje             | P08                                  |
| K07 sprzedaż do rozliczenia     | P10                                  |
| K08 dokumenty/raporty           | P09                                  |
| K09 IT/bezpieczeństwo           | P07                                  |

## Informacje, których kod nie może wymyślić

Codex sam wykonuje implementację, testy, przeglądy i zwykłe dostarczenie kodu. Nie tworzy jednak fikcyjnych poświadczeń wydania sprzętu, decyzji rekrutacyjnych czy dowodów pracy ludzi. W laboratorium sprawdza je syntetycznymi aktorami; w użyciu operacyjnym są to zadania w JARVIS.

Własny klucz dostawcy, brakująca wiążąca zasada firmy, faktyczna decyzja biznesowa lub zgoda systemowa mikrofonu mogą wymagać jednorazowego udziału użytkownika. Taki brak zapisujemy przy konkretnym kryterium i kontynuujemy niezależne paczki. Nie pobieramy sekretów innych aplikacji i nie przedstawiamy nieodbytej próby jako sukcesu.

Komunikaty do użytkownika dotyczą scalonej paczki, istotnego wyniku odbioru albo rzeczywistej blokady. Nie wymagają od niego zarządzania technicznym backlogiem. Roadmapa i dziennik pozostają podstawą kontynuacji także po dłuższej przerwie.
