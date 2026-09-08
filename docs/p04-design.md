# P04 — kontrolowany kontekst firmy i ciągłość rozmowy

Status: **projekt następnej paczki; bez implementacji i odbioru P04**. Podstawa: [roadmapa P04](roadmap.md#p04--kontekst-firmy-i-rozmowa), [odbiór](acceptance.md), kod w worktree P03 na bazie `04bb1f048ee8befe3daa9866cb4989782fcbb620`. Odczyt uwzględnia niezacommitowaną integrację P03; końcowy SHA P03 należy wpisać przy rozpoczęciu implementacji. Nie jest to zgoda na uruchomienie integracji z innymi systemami.

## 1. Konkretna luka i pierwszy rezultat

`assistant.ts` ma dwa różne mechanizmy. Lokalny zbiera proste pola rezerwacji albo nowego wpisu. Chmurowy wybiera przede wszystkim rekordy, których pełną nazwę dosłownie wymieniono w wiadomości. Żaden nie jest jeszcze brokerem kontrolowanych odczytów. `planner.ts` pozostaje osobnym demonstratorem dwóch narzędzi testowych; nie należy przedstawiać go jako planera ERP ani rozbudowywać obu ścieżek równolegle.

Pierwszy rezultat P04: „przygotuj laptop dla Ani” tworzy trwały szkic potrzeby. JARVIS ustala właściwą osobę, konkretną współpracę, termin gotowości, warunki i ewentualną istniejącą sprawę, pokazuje dopuszczalne wyposażenie oraz przygotowuje plan do zatwierdzenia. Nie uznaje rezerwacji za fizyczne wydanie ani ukończony onboarding. Nowy klucz Claude nie jest warunkiem implementacji tego przepływu.

### Co już istnieje

- Zod, zamknięty katalog narzędzi, plan do 12 kroków, wersjonowanie narzędzi, Core ze zgodą każdego zapisu, idempotencją i recovery.
- Odczyty WorkspaceStore z tenantem i zakresem rekordu; P03 dodaje projekcję zadania oraz tożsamościowy dostęp do wykonań, niezależny od samych scopes.
- Prywatna rozmowa związana z tenantem, aktorem i hashem uprawnień; ograniczenia rozmiaru, tempa i odpowiedzi dostawcy; osobne wyniki `answer`, `needs_input`, `ready`, `unsupported`.
- Profil firmy z wersją, strefą czasową, zaakceptowanymi ustawieniami i obsadą ról; okres współpracy jako osobny trwały rekord.

### Co trzeba zmienić

1. `offline()` może wymienić całą dostępną ewidencję osób/sprzętu przy doprecyzowaniu, a odpowiedź po nazwie serializuje całe `e.data`. Potrzebne są projekcje dopasowane do celu i ograniczone wyniki.
2. `cloudRequest()` nie przekazuje okresów współpracy, relacji, stanu szkicu ani gotowości sprawy. Przekazuje schematy licznych narzędzi, lecz pomija narzędzia P03 bez `scope`, mimo że ich rzeczywisty dostęp określa `canAccess`.
3. `Slots` nie ma `employmentEpisodeId`, `caseId`, rewizji zakresu ani wersji wybranych źródeł. Gotowy plan czyści szkic; tryb chmurowy opiera dalszą rozmowę na tekście ostatnich wiadomości. Nie jest to ciągłość sprawy.
4. Dopasowanie imienia prefiksem i dosłowną nazwą nie rozstrzyga bezpiecznie „Ani”. Pseudonimizacja przez zamianę fragmentów nazw jest pomocnicza; nie zastępuje kontroli pól i uprawnień.
5. Unikalny indeks `ops_one_open_employment`, status osoby i pola `currentEmploymentEpisodeId`, `onboardingCaseId`, `offboardingCaseId` zakładają jedną współpracę. `activate` i odejście pobierają dowolny otwarty okres przez `.get()` bez wskazania okresu w komendzie.
6. Przydziały i blokady odejścia nadal w części operacji dotyczą całej osoby. Samo usunięcie indeksu umożliwiłoby zamknięcie niewłaściwej współpracy lub zablokowanie jej cudzym zasobem.

## 2. Jeden broker odczytów lokalnych

Dodać `ContextBroker` korzystający z istniejących magazynów, schemas i `hasToolAccess`/`canAccess`. Nie udostępnia SQL, dowolnej ścieżki pliku, URL, listy żądanych pól ani surowego `Entity.data`. Ten sam kod odczytu obsługuje lokalny przepływ deterministyczny i model. Model proponuje wywołanie; broker sprawdza konto, tenant, cel, argumenty, limit i aktualny dostęp przed odczytem. Odczyty nie przyznają zgód i nie zmieniają rekordów biznesowych.

Proponowany zamknięty katalog; wszystkie obiekty `.strict()`, brak argumentów tenant/actor:

| Narzędzie                 | Argumenty                                                                    | Odpowiedź dopuszczona dla celu                                                                                                                             |
| ------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `context.company`         | `{purpose:'equipment_request'\|'employment'\|'case_followup'}`               | wersja konfiguracji, timezone, odpowiednie zatwierdzone reguły i ich pochodzenie; bez sekretów i całej konfiguracji                                        |
| `context.findPeople`      | `{query:string(2..120),limit:int(1..5),cursor?:opaque}`                      | najwyżej 5 dopuszczonych kandydatów, lokalna etykieta do wyboru, token wyboru, niezbędny dział/rola do rozróżnienia; brak emaili, wynagrodzeń i dokumentów |
| `context.personWork`      | `{personRef:opaque,purpose:'equipment_request'\|'employment'}`               | dopuszczone okresy: rodzaj, stan, daty, rola, bezpieczna etykieta projektu i token okresu; brak automatycznego wyboru spośród kilku                        |
| `context.findCases`       | `{personRef?:opaque,episodeRef?:opaque,state:'open'\|'any',limit:int(1..5)}` | dostępne sprawy z rezultatem, terminem, rewizją i niespełnionymi warunkami; IT korzysta z projekcji własnych zadań, nie pełnej sprawy HR                   |
| `context.availableAssets` | `{assetType:enum,readyOn:date,episodeRef:opaque,limit:int(1..5)}`            | aktualnie dopuszczone urządzenia, wersja i powód dostępności; brak danych poprzedniego użytkownika                                                         |
| `context.readRecord`      | `{ref:opaque,purpose:enum}`                                                  | jedna z jawnych projekcji osoby/sprawy/sprzętu/roli/aplikacji/dokumentu; dokument domyślnie tylko metadane, rewizja i stan akceptacji                      |

Token odczytu/wyboru jest losowy, związany z rozmową, aktorem, tenantem, dozwoloną projekcją i źródłem; nie jest nowym uprawnieniem. Surowe identyfikatory z odpowiedzi modelu nie mogą ominąć tego powiązania. Broker rozwiązuje token do identyfikatora domenowego dopiero po ponownej walidacji. Etykiety osób widzi uprawniony użytkownik lokalnie; do dostawcy trafiają stabilne dla tej rozmowy pseudonimy i tylko potrzebne fakty. Nie wolno przekazywać modeli kont, loginów ani pełnej listy osób w celu samej pseudonimizacji.

Każdy wynik otrzymuje serwerowe `source {module,id,version,updatedAt,observedAt,classification,projectionVersion,projectionHash}` i `freshness:'current'|'stale'|'unavailable'`. Model nie dostarcza hasha ani nie deklaruje aktualności. Kursor jest nieprzenośny pomiędzy aktorami/firmami i nie ujawnia liczby niedostępnych rekordów. Brak wyniku znaczy „brak dostępnego dopasowania”, nie dowodzi braku osoby w firmie.

Budżet pierwszego wdrożenia: do 4 odczytów brokera na jedną turę, 5 wyników wyszukania, 1 pełniejsza projekcja naraz, łącznie najwyżej 24 KiB kontekstu i 8 ostatnich zminimalizowanych wiadomości; jeden jawny termin zakończenia tury. To wartości konfiguracyjne z testem granic, nie obietnica wykorzystania wszystkich limitów. Audyt techniczny zapisuje identyfikatory odczytów, projekcję, wersje, liczbę bajtów i decyzję dostępu, bez treści HR/promptów w telemetrii.

## 3. Trwały szkic potrzeby i rozmowa

Zastąpić swobodne `slots_json` wersjonowanym `NeedDraft`: `id`, `version`, `intent`, `phase`, `personRef?`, `episodeRef?`, `caseRef?`, `readyOn?`, `reservationUntil?`, wymagania wyposażenia, `profileVersion`, wybrane źródła, `missingFields`, `clarification`, `scopeHash`, `linkedRuns`, `supersedesDraftVersion`. Stan jest prywatny jak obecna rozmowa. Nie jest jeszcze zaakceptowaną sprawą biznesową.

Fazy: `collecting`, `needs_choice`, `ready_to_plan`, `planned`, `awaiting_approval`, `in_progress`, `blocked`, `completed`, `cancelled`. Statusy po przygotowaniu planu pochodzą z Core i domeny, nigdy z deklaracji modelu. Te same reguły przejścia obowiązują lokalnie i z dostawcą. Szkic ma CAS i trwały klucz wiadomości; drugi proces/restart nie może nadpisać późniejszej odpowiedzi ani utworzyć drugiej sprawy.

Przebieg:

1. „Ani” uruchamia ograniczone wyszukanie. Odmiana imienia/alias pomaga znaleźć kandydatów, ale nie jest decyzją o tożsamości. Przy niejednoznaczności jest lokalny wybór opisanych osób, bez kopiowania UUID. Wybrany token musi pochodzić z bieżącego pytania tej rozmowy.
2. Ustalić okres współpracy oddzielnie od osoby. Brak okresu prowadzi do propozycji właściwego procesu HR, nie automatycznego zatrudnienia. Kilka okresów wymaga wyboru. Operator IT bez odpowiedniego odczytu korzysta z uprawnionej sprawy/zadania albo przekazuje potrzebę właścicielowi; nie dostaje całej ewidencji HR.
3. Ustalić termin gotowości i wymagania. Termin startu, termin zadania i wygaśnięcie rezerwacji to różne pola. Naturalną datę rozwiązuje kod względem timezone firmy i daty tury; wynik pokazuje użytkownikowi przed planem.
4. Odczytać właściwą istniejącą sprawę oraz dostępny sprzęt. P03 raport gotowości wskazuje dalsze braki. Wyjątek lub brak sprzętu nie jest sukcesem; ewentualny zakup jest osobną propozycją.
5. Zbudować plan z aktualnymi wersjami i snapshotem konfiguracji. Rozmowa odsyła do konkretnego run/sprawy; „co dalej?” ponownie odczytuje ich stan przez broker, nie odtwarza go z dawnej odpowiedzi modelu.
6. Zmiana „jednak dla innej Ani” tworzy nową wersję szkicu i jawnie unieważnia poprzednią propozycję. Niewykonany plan można anulować zgodnie z Core; rozpoczęty lub niepewny skutek najpierw uzgadniamy. Istniejąca sprawa zmienia zakres przez zatwierdzaną rewizję. Nie usuwać wykonanych skutków ani nie odziedziczyć starej zgody.

Zasada firmy jest autorytatywna tylko jako zatwierdzona wersja konfiguracji albo odpowiedniego dokumentu. Treść zasady i źródła nadal są danymi, nie instrukcjami wykonania dla modelu. Zmiana profilu proponowana w rozmowie podlega temu samemu Core co panel.

## 4. Współprace: migracja zależna od konfiguracji

Nie zaczynać od usunięcia indeksu. Najpierw wszystkie komendy lifecycle otrzymują wymagany `employmentEpisodeId` i sprawdzają relację tenant/osoba/okres/sprawa. Okres przejmuje własne statusy, terminy, wersję oraz powiązania spraw. Status osoby staje się podsumowaniem, nie źródłem decyzji. Pole `personCategory` nie może jednocześnie określać niezmiennej tożsamości i rodzaju wszystkich przyszłych okresów; zachować je jako historyczną preferencję/etykietę, a regułę zatrudnienia przenieść do okresu i konfiguracji.

Proponowany zatwierdzany kontrakt profilu: `employmentPolicy {mode:'single_open'|'parallel_projects',maxConcurrent:int,allowInternalOverlap:false}`. Bez konfiguracji oraz po odczycie starszego profilu działa dotychczasowy bezpieczny zakaz. Profil B może jawnie dopuścić równoległe okresy kontraktorskie w odrębnych projektach. Każdy wymaga identyfikatora rzeczywistego lokalnego przedsięwzięcia/umowy (`engagementRef` do dostępnej sprawy realizacji lub rekordu sprzedaży), nie tekstu projektu uznanego za globalną tożsamość. Wykluczyć duplikat tej samej współpracy i nakładanie okresu wewnętrznego. Zmiana polityki nie kończy automatycznie istniejących okresów; ogranicza nowe decyzje i pokazuje wymagane uporządkowanie.

Kolejność migracji:

1. Addytywnie dodać wersję okresu, jego sprawy i referencję przedsięwzięcia; skopiować tylko jednoznaczne istniejące identyfikatory. Nullable legacy przydziały pozostają jawnie nierozstrzygnięte.
2. Przepisać wszystkie `.get(status!='ended')`, odczyty rozmowy, aktywację, odejście, eksport i reguły na konkretny okres. Zablokować starą komendę bez okresu po zmianie wersji narzędzia; dawna zgoda nie wybiera go automatycznie.
3. Dodać minimalne pola okresu/sprawy i walidację relacji we wszystkich nowych przydziałach sprzętu/licencji. Jest to fundament tożsamości P04, nie ukończenie pełnych obiegów P05/P08a. Dopóki osoba ma nieprzypisane historyczne aktywne zasoby, nie uruchamiać jej równoległej współpracy bez jawnego rozstrzygnięcia. Nie zakładać automatycznie, że zasób jednej współpracy obsługuje drugą.
4. Dopiero po powyższym zastąpić indeks jednej otwartej współpracy ograniczeniami duplikatu przedsięwzięcia i kontrolą polityki w transakcji `BEGIN IMMEDIATE`. Sprawdzać profil/wersję, liczność i nakładanie okresów przy wykonaniu, nie tylko przygotowaniu planu. Dwa połączenia muszą dawać jeden wynik dopuszczony przez limit.
5. Odejście działa wyłącznie na zasobach danego okresu. Nierozstrzygnięty legacy przydział blokuje zamknięcie; zasób należący do innego okresu pozostaje nietknięty. Współdzielenie sprzętu lub poświadczenia dostępu wymaga przyszłego jawnego modelu, nie heurystyki po `personId`.

To usuwa potencjalny cykl zależności: P04 dostarcza minimalną tożsamość przydziałów i bezpieczne komendy, P05 rozwija ich pełny obieg. Nie uzależniać migracji P04 od ukończonego P06. Wciąż nie uruchamiać automatycznej aktywacji onboardingu bez źródeł P05/P08a/P09a.

## 5. Aktualność, źródła i granica zaufania

Przed zbudowaniem planu oraz przy faktycznym zapisie ponownie odczytać wskazane źródła. Zmiana dostępności urządzenia, okresu, praw aktora lub profilu daje `needs_input`/blokadę z nowym planem i zgodą. Czas życia tokenu nie wystarcza jako test aktualności. Historyczna odpowiedź pozostaje historyczną; obok bieżącego podsumowania pokazać datę odczytu.

Oddzielić `recordVersion` od `caseScopeRevision/scopeHash`. Dokument utworzony ze sprawy nie może automatycznie stać się aktualnym dowodem tej samej sprawy tylko przez tekst. Obecny dokumentowy snapshot całego rekordu staje się nieaktualny po `bindEvidence`/odbiorze, bo zmienia się wersja sprawy. P04 ustala kontrakt referencji niezmiennego zakresu; P09a wdraża jego użycie w dowodach dokumentowych. Do tego czasu taki cykl pozostaje jawną blokadą, nie powodem usunięcia kontroli źródeł.

Treść dokumentu, tytuł osoby/urządzenia, wiadomości historyczne i wynik narzędzia są niezaufane. Nie mogą zmienić narzędzi, roli, zasad, budżetu odczytów ani źródła sekretów. Odpowiedź modelu jest walidowanym szkicem, bez samodzielnego odczytu sieci i bez wykonania biznesowego. Komunikaty o wykonaniu i gotowości renderować ze stanu Core/domeny; tekst modelu „wydałem sprzęt” bez takiego źródła nie może zostać pokazany jako potwierdzony wynik.

## 6. Kolejność i negatywne scenariusze odbioru

| Paczka | Zakres i wynik                                                                                 | Obowiązkowe negatywne próby                                                                                                                                                                                                                                              |
| ------ | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P04a   | Broker, projekcje, tokeny źródeł, capability metadata uwzględniające `canAccess`               | cudzy tenant; osoba poza scope; token innej rozmowy; cursor po zmianie praw; brak bezpiecznego wyniku bez ujawnienia całej ewidencji; próba podania własnego SQL/fields/URL                                                                                              |
| P04b   | Wersjonowany szkic, doprecyzowanie osoby/okresu/dat, przejście do istniejącej lub nowej sprawy | dwie Anny; Ania bez potwierdzonego aliasu; dwie współprace; brak terminu; zmiana osoby po przygotowaniu zgody; dwie równoczesne wiadomości i restart; ponowienie klucza nie tworzy kolejnej sprawy                                                                       |
| P04c   | Migracja okresów i minimalnych referencji przydziałów, dwa zatwierdzone profile                | domyślny profil odmawia drugiego okresu; profil B dopuszcza dwa różne projekty, lecz nie trzeci/duplikat; limit wyścigu dwóch procesów; data nakładająca okres wewnętrzny; odejście A nie narusza B; legacy NULL blokuje zgadywanie; cofnięcie polityki nie usuwa danych |
| P04d   | Adapter biznesowy używa brokera i tego samego szkicu; polski zestaw ewaluacyjny                | wrogie polecenie w polityce/tytule/wyniku narzędzia; wymyślony token/aktor/zgoda; za dużo odczytów; zawieszony dostawca; powtórzony wynik; rekord zmieniony między odpowiedzią a zgodą; model twierdzi sukces bez dowodu                                                 |
| P04e   | Przebieg panelu i tekstu na obu profilach, wydanie paczki                                      | wybór bez wpisywania UUID; powrót do szkicu; pozycja „co dalej?” z aktualnego źródła; narrow IT bez HR; widoczna blokada brakujących źródeł P03; poprawna nocna granica dat dla Polski i UTC                                                                             |

P04a/b mogą powstawać bez klucza i przed zakończeniem migracji, z jednoznacznym kontraktem okresu. P04c jest warunkiem deklaracji odebranej krotności współprac. P04d nie może wprowadzać drugiego zestawu reguł biznesowych w promptach.

Dowody raportować oddzielnie: testy kontraktowe ze stubbem modelu, lokalny rzeczywisty Core/SQLite i restart, wizualny przebieg UI, hosted CI i dostarczony SHA. Dodatkowo rzeczywiste wywołanie Claude wymaga własnego skonfigurowanego klucza JARVIS, jawnego modelu i pomiaru zwróconych tokenów/ceny. **Klucz nie jest obecnie potwierdzony jako dostępny; realny odbiór dostawcy pozostaje blocked.** Nie pobieramy credentiali z innych repozytoriów i nie nazywamy stubu realnym odbiorem modelu. Pozostałe prace i odbiory lokalne nie muszą czekać.

Poza P04 pozostają pełne wydania/zwroty P05, provisioning i poświadczenia P08a, dokumenty kompletności P09a, pełny pozytywny onboarding P06, konektory produkcyjne, głos i autonomiczne wykonywanie decyzji HR.
