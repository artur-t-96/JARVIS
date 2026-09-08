# P03 — projekt spraw, pracy ludzi i typowanego odbioru

Status: **kontrakt paczki P03; implementacja i odbiór opisane w dzienniku realizacji**. Wprowadzenie opisuje problem zastanej wersji przed P03. Ten dokument nie jest samodzielnym dowodem odbioru ani ukończenia onboardingu. Podstawy zakresu: [roadmapa](roadmap.md), [plan odbioru](acceptance.md), [wizja](vision.md).

## Problem i warunek docelowy

Obecne `WorkspaceStore.readyForAcceptance()` sprawdza ukończenie obowiązkowych zadań i obecność dowolnego dowodu dla rewizji. `tests/workspace.test.ts` zawiera helper `acceptCase()`, który kończy zadania komentarzami i dodaje ogólny protokół. Ten przebieg potwierdza dotychczasowy kontrakt techniczny; nie dowodzi gotowości do rozpoczęcia pracy.

`lifecycleCase()` przypisuje wszystkie zadania do osoby rozpoczynającej współpracę. `human()` korzysta z `approvedBy` jako autora potwierdzenia, więc zgoda na zapis nie jest dostatecznie oddzielona od wykonania pracy. Sprzęt i miejsca licencyjne są przypisane do osoby, bez identyfikatora okresu współpracy. `people.activate` sprawdza status odebranej sprawy, ale nie ocenia ponownie aktualności jej dowodów.

Docelowo onboarding nie przechodzi bez wymaganego sprzętu rzeczywiście wydanego właściwej osobie, dokumentu w zaakceptowanej wersji i potwierdzonego dostępu, powiązanych z konkretną współpracą. Wynik zadania, zgoda Core, poświadczenie człowieka, niezależny odczyt stanu i odbiór biznesowy pozostają rozróżnione.

## Wymagane minimum P03

### 1. Wymagania i ocena gotowości

Wprowadzić zamknięty kontrakt `CaseRequirement`: identyfikator, sprawa, rewizja zakresu, rodzaj, obowiązkowość, osoba, okres współpracy i typowany oczekiwany rezultat. Rodzaje: `asset_issued`, `document_approved`, `access_attested`, `delivery_received`, `test_passed`. Wymagania spoza lifecycle nie muszą wskazywać osoby ani współpracy; dla onboardingu takie powiązania są obowiązkowe.

Osobne `EvidenceBinding` wskazuje rekord źródłowy, jego wersję lub hash, datę odczytu i pochodzenie. Dowód ogólny z `addEvidence` pozostaje opisem pomocniczym. Klient ani model nie mogą ustanowić spełnienia wymagania przez przesłanie `satisfied: true` lub dowolnego opisu.

Jedna funkcja `evaluateAcceptance(case, revision)` odczytuje trwałe źródła i zwraca stan każdego warunku: `satisfied`, `missing`, `stale`, `failed` albo `exception`, wraz z bezpiecznym powodem i następną czynnością. Brak implementacji właściwego odczytu źródła jest jawną blokadą. Typ wymagania bez prawdziwego źródła nie otrzymuje zastępczego pozytywnego wyniku.

W P03 funkcja obsługuje aktualne dostępne źródła tylko w granicach ich dowodów; nie uznaje rezerwacji za wydanie, miejsca licencji za dostęp ani samego tekstu za dostawę. Obsługa dostaw i wyników testów ma od początku typowany kontrakt, ale pełne odczyty i scenariusze domenowe należą odpowiednio do P08 i P07.

### 2. Odbiór rewizji i ponowna kontrola

Wywoływać ocenę przy `submit`, `accept` i `people.activate`. Odbiór zapisuje rewizję, hash zakresu i wykorzystanych powiązań źródłowych. Aktywacja sprawdza tę samą współpracę i aktualność dowodów, także gdy sprzęt zwrócono lub dostęp cofnięto po odbiorze.

Zmiana zakresu, terminu startu albo wymaganego źródła tworzy nową rewizję i wymaga odpowiedniej nowej zgody oraz odbioru. Nie przepisuje historii skutków. Nowa wersja dokumentu nie dziedziczy automatycznie odbioru poprzedniej treści; wymaganie określa konkretną wersję i zasady jej aktualności. Zmiana konfiguracji firmy nie przepisuje zakresu już utworzonej sprawy.

### 3. Zadania ludzi i tożsamość

Zachować istniejące stany zgód Core. Zadanie domenowe otrzymuje `kind: information | decision | work | attestation`, stany `unassigned | offered | accepted | declined | completed | cancelled`, termin, zależności, własną wersję i `assigneePrincipalId`. Spóźnienie wynika z daty i aktualnego stanu; nie zastępuje informacji o przyjęciu albo odmowie.

Istniejące `assigneeId` wskazuje UUID osoby biznesowej, podczas gdy `Principal.id` jest identyfikatorem konta typu string. Nie zmieniać znaczenia tej kolumny ani nie przypisywać kont po podobieństwie nazw. Rozdzielić osobę, której dotyczy sprawa, wykonawcę zadania oraz zatwierdzającego zapis.

Operacje przyjęcia, odmowy, przekazania i zakończenia zadania przechodzą przez zamknięte narzędzia i obecne mechanizmy zgody, idempotencji oraz weryfikacji Core. Przekazanie wymaga jawnego nowego wykonawcy i ponownego przyjęcia. `performedBy`, `requestedBy` i `approvedBy` pozostają oddzielne; tożsamość wynika z uwierzytelnionego działania, nigdy z dowolnego argumentu modelu. Zatwierdzenie zapisu nie dowodzi, że zatwierdzający wykonał pracę. Wycofane uprawnienia muszą blokować działanie także po wznowieniu.

Zachować historię zmian i powiązanych wykonań. Odmowa lub opóźnienie tworzą jedno aktualne zobowiązanie dla właściciela sprawy, z deduplikacją po zadaniu i rewizji. Restart nie zmienia wykonawcy ani nie ponawia poświadczenia.

### 4. Bazowe dwa profile

Rozszerzyć istniejące zatwierdzane profile o obsadę ról `hr`, `it`, `manager` wskazującą konta, a szablony o rolę wykonawcy, rodzaj zadania i klucze wymagań. Zachować działające przypinanie `profileVersion` przed zgodą Core oraz snapshot szablonu w sprawie. Dostępność kont i uprawnień sprawdzać na bieżąco; zamrożony profil nie utrwala dostępu cofniętego użytkownikowi.

- Profil A: pracownik wewnętrzny; HR odpowiada za dokumenty, IT za sprzęt i dostęp, przełożony za odbiór.
- Profil B: konsultant; odrębny wariant dokumentów, wymaganych dostępów i terminów, z jawną obsadą tych samych odpowiedzialności.

Oba profile korzystają z tego samego kodu. Brak jednoznacznego aktywnego wykonawcy daje `unassigned` i brakującą informację do uzupełnienia; nie przenosi całej pracy na nową osobę. Profil nie nadaje uprawnień. Są to bazowe warianty procesu P03, bez pełnej personalizacji P13 i bez otwierania równoległych współprac planowanych w P04.

### 5. Projekcja zadań, panel i wyjątki

Panel sprawy pokazuje rezultat, niespełnione warunki, osoby, terminy i następne działanie. Oddzielna lista grupuje zadania człowieka i decyzje, rozróżniając je od zgód na zapis Core. Minimalny odbiór interfejsu obejmuje delegowanie, odmowę i blokadę niepełnej rewizji bez ręcznego wpisywania identyfikatorów narzędzi.

IT otrzymuje autoryzowaną projekcję własnego zadania i potrzebnych danych, bez dostępu do całej sprawy HR. Obecne `entityScopes` wymagają obszaru `people` przy odczycie onboardingu. Nowa projekcja wymaga jawnego kontraktu dostępu; nie wolno usuwać tych zabezpieczeń dla pełnego rekordu ani rozszerzać uprawnień kont przez konfigurację szablonu. Relacje i źródła są sprawdzane względem tenantu oraz dozwolonego obszaru, również w listach, rozmowie i eksporcie.

Wyjątek ma konkretny warunek i rewizję, podstawę, zatwierdzającego, właściciela ryzyka, termin oraz sposób zamknięcia. Jest dopuszczalny tylko tam, gdzie potwierdzona reguła wyraźnie na to pozwala. Bazowe wymagania sprzętu, dokumentu i dostępu nie mogą zostać zastąpione wyjątkiem albo komentarzem. Brak gotowości prowadzi do blokady lub jawnej zmiany zakresu i terminu, nie do pozornego sukcesu.

## Kontrakty i migracja

Core zachowuje model planu, zgody, wykonania i recovery. Typy wymagań, zadań, profili oraz oceny gotowości należą do warstwy domenowej. Wersje zmienionych narzędzi muszą wzrosnąć; dawna zgoda nie autoryzuje nowego znaczenia argumentów.

Proponowana migracja `operations` v3, po istniejących v1 i v2:

- Przebudować `ops_tasks`, zachowując wszystkie wiersze i historyczne pola, aby dodać nowe stany, rodzaj, wersję i identyfikator konta wykonawcy. Dotychczasowy `CHECK` dopuszcza tylko `open` i `completed`.
- Dodać `ops_task_events`, `ops_case_requirements`, `ops_requirement_bindings` oraz `ops_case_exceptions`, z powiązaniami tenant/sprawa/rewizja i trwałą historią autorów.
- Rozszerzyć `ops_acceptances` o hash zakresu oraz zapis wykorzystanych powiązań źródłowych. Dawne odbiory oznaczyć jako historyczne odbiory bez typowanych bramek.
- Przygotować nullable `employment_episode_id` i `case_id` w alokacjach sprzętu oraz miejscach licencyjnych. Nowe powiązanie wykorzystywane jako dowód onboardingu musi identyfikować właściwą współpracę; istniejący rekord z pustymi polami nie spełnia wymagania. Pełna obsługa tych relacji we wszystkich operacjach należy do P05/P08a.
- Wersjonować nowy kształt profilu i bezpiecznie odczytywać starszą konfigurację jako wymagającą uzupełnienia obsady/typowanych wymagań przed nowym startem. Nie tworzyć fikcyjnej zgody na migrację konfiguracji.

Migracja nie zgaduje, kto dawniej wykonał zadanie ani do której współpracy należał sprzęt. Nie zamienia `evidenceNote` w poświadczenie wydania, dokumentu czy dostępu. Historyczne ukończone zadania i odbiory pozostają faktami starego modelu, z jawnym pochodzeniem. Otwarte niejednoznaczne zadania wymagają przypisania; historyczny odbiór nie jest wystarczającym dowodem nowej aktywacji po zmianie kontraktu. Nie cofać automatycznie wcześniej aktywowanych współprac — ewentualna korekta jest osobną, jawną sprawą.

Test migracji obejmuje odczyt starych danych, zachowanie historii, brak automatycznego zaliczenia nowych warunków, transakcyjność i odrzucenie przyszłej wersji schematu. Nie zmieniać w P03 indeksu jednej otwartej współpracy na osobę; jego migracja i polityka okresów należą do P04.

## Zależności i granica paczki

| Obszar         | Wymagane w P03                                                                                      | Dalsza paczka                                                                                           |
| -------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Sprzęt         | Typ wymagania, przypięcie osoby/współpracy, odrzucenie rezerwacji lub obcego przydziału jako dowodu | P05: kompletny obieg, konflikty, wydania, zamiany, zwroty i migracja powiązań wszystkich operacji       |
| Dostęp         | Typowany warunek i wiążąca blokada, jeżeli nie istnieje właściwe poświadczenie                      | P08a: rejestr wymaganych dostępów, ich potwierdzenie i ewentualne miejsce licencji dla osoby/współpracy |
| Dokument       | Wersja/hash źródła i odmowa przy nieaktualnym lub nieodpowiednim dowodzie                           | P09a: wymagane dokumenty onboardingu, kompletność, źródła i zaakceptowane wersje                        |
| Dostawa/test   | Zamknięte typy wymagań, brak domyślnego sukcesu dla nieobsłużonego źródła                           | P08/P07: rzeczywiste odczyty i pełne scenariusze domenowe                                               |
| Firma i ludzie | Dwa zatwierdzone profile, obsada, zadania i odbiór rewizji                                          | P04: krotność współprac i kontekst; P13: pełna personalizacja                                           |
| Onboarding     | Skuteczne bramki, zadania i negatywne scenariusze odbioru                                           | P06 po P05/P08a/P09a: pełny pozytywny przebieg K03 i odbiór użytkownika                                 |

P03 nie jest ukończeniem K03. Jeśli źródło z P05/P08a/P09a nie jest gotowe, raport wskazuje niespełnione wymaganie i zależność. Fixture w teście kontraktu nie zastępuje lokalnego działania domenowego ani dowodu przez panel. Nie dodawać w P03 integracji z innymi systemami, automatycznego provisioningu kont, wysyłki ani płatności.

## Scenariusze i dowody

| ID     | Scenariusz                                                                           | Oczekiwany rezultat i etap odbioru                                                                                                      |
| ------ | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| P03-01 | Dwa profile tworzą plany pracownika i konsultanta                                    | Właściwi wykonawcy HR/IT/przełożony, różne wymagania i terminy, zamrożona wersja profilu; wymagane w P03                                |
| P03-02 | Wszystkie zadania ukończone, dodany ogólny protokół                                  | Brak odbioru; widoczne brakujące wymagania sprzętu, dokumentu i dostępu; wymagane w P03                                                 |
| P03-03 | Sprzęt zarezerwowany, wydany innej osobie lub innej współpracy                       | Brak spełnienia bramki; wymagane w P03. Właściwe wydanie z pełnego obiegu potwierdzone dodatkowo w P05/P06                              |
| P03-04 | Wersja dokumentu, hash lub źródło zmienia się po przygotowaniu odbioru               | Stary dowód nie zatwierdza nowej treści; wymagane w P03. Pełna kompletność dokumentów w P09a/P06                                        |
| P03-05 | Istnieje miejsce licencji, ale brak właściwego poświadczenia dostępu                 | Odbiór zablokowany; wymagane w P03. Potwierdzenie i cofnięcie dostępu sprawdzone z prawdziwym rejestrem P08a, także przed aktywacją P06 |
| P03-06 | IT przyjmuje, odmawia albo przekazuje zadanie; inna osoba próbuje je zakończyć       | Historia zachowana, nowy wykonawca przyjmuje zadanie, brak podszycia się przez zgodę Core; wymagane w P03                               |
| P03-07 | Restart podczas oczekiwania, spóźnienie i powtórzona komenda                         | Ten sam wykonawca, jedna aktualna eskalacja, brak drugiego poświadczenia; wymagane w P03                                                |
| P03-08 | Zmiana zakresu/terminu, cofnięcie uprawnień, dowód innego tenantu lub starego modelu | Blokada nieaktualnego odbioru bez wymazania wcześniejszych faktów; wymagane w P03                                                       |

Pierwszy docelowy przebieg: start konkretnej współpracy → zadania HR/IT → brak sprzętu blokuje gotowość → właściwe wydanie i zaakceptowany dokument → wymagany dostęp → odbiór przez przełożonego → ponowna kontrola przy aktywacji. Pełne pozytywne zakończenie następuje po zależnościach P05/P08a/P09a. Odbiór P03 wymaga już prawdziwego działania zadań, kontroli tożsamości, rewizji i negatywnych bramek, wraz z migracją i restartem.

Każdy raport wskazuje SHA, profil, tenant, rewizję, sposób próby i bezpieczne dowody zgodnie z [planem odbioru](acceptance.md). Wyniki automatyczne, test rzeczywistego komponentu i przejście interfejsu są raportowane osobno.
