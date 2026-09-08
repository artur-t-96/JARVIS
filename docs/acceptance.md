# Odbiór całej wizji JARVIS

Powiązania: [roadmapa](roadmap.md), [wizja](vision.md), [dotychczasowe dowody](coverage.md). Ten dokument jest planem prób do domknięcia. Nie oznacza, że wszystkie opisane przypadki już przeszły.

## Zasada dowodu

Każdy odbiór zawiera: ID wymagania i scenariusza, datę, SHA aplikacji, profil firmy, tryb lab/operational, sposób uruchomienia, wynik oczekiwany i rzeczywisty, identyfikatory spraw/wykonań oraz bezpieczne ścieżki do dowodów. Wynik to `pass`, `fail` albo `blocked` z konkretnym powodem. Raporty generowane nie zawierają sekretów ani treści HR.

Test kontraktu Core można współdzielić między kompetencjami, ale trzeba wskazać, która gwarancja jest wspólna. Nie zalicza to automatycznie specyficznej reguły domenowej, np. wydania laptopa przed odbiorem onboardingu. Każda kompetencja ma własny pełny przebieg na dwóch konfiguracjach firmy oraz właściwe dla niej warianty poniżej.

Dowody automatyczne, test z rzeczywistym komponentem i przejście interfejsu użytkownika są rozdzielone. Stub modelu nie jest odbiorem dostawcy; poświadczenie w bazie nie jest automatycznym provisioningiem konta; zapis tekstu o dostawie nie zastępuje właściwej operacji przyjęcia.

## Wspólne warianty scenariuszy

| Kod | Próba                                                       | Wymagany rezultat                                                                   |
| --- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| H   | Poprawny przebieg od potrzeby do odbioru                    | Potwierdzony wynik, właściciele, daty, dowody i właściwa rewizja.                   |
| D   | Brak / niejednoznaczność / nieaktualność danych             | Pytanie albo jawna blokada; brak wymyślonego rekordu, daty i sukcesu.               |
| A   | Brak uprawnienia, cofnięcie konta/obszaru przed wznowieniem | Odmowa odczytu i skutku; brak wycieku przez rozmowę, listy, eksport i relacje.      |
| G   | Brak zgody lub odmowa                                       | Brak zapisu, zachowana decyzja/powód, możliwość poprawnego nowego zakresu.          |
| V   | Zmiana zakresu, wersji źródła lub konfiguracji              | Nowa ocena i właściwa zgoda; nieaktualny odbiór nie potwierdza nowej pracy.         |
| C   | Anulowanie przed i po częściowym wykonaniu                  | Widoczne zapisane skutki i pozostałe zobowiązania; bez fikcyjnego cofnięcia faktów. |
| R   | Restart podczas oczekiwania i utrata odpowiedzi po zapisie  | Reconcile z osobnego trwałego magazynu; brak niezamierzonego drugiego skutku.       |
| Q   | Równoległa próba / ponowienie z tym samym kluczem           | Konflikt albo ten sam receipt; inna treść pod tym samym kluczem jest odrzucona.     |
| L   | Spóźnienie człowieka, odmowa zadania, zmiana wykonawcy      | Jedna eskalacja zgodna z regułą, aktualny właściciel i stan po restarcie.           |
| N   | Negatywna niezależna weryfikacja                            | Brak pozornego sukcesu; poprawa, wyjątek lub eskalacja z dowodem.                   |
| T   | Dwie firmy i role o ograniczonych obszarach                 | Brak odczytu/zapisu między tenantami i przez niedozwolone powiązanie.               |
| P   | Sekret w wejściu i niezamierzone połączenie                 | Brak sekretu w eksportowanym kontekście/telemetrii; brak ruchu do innych systemów.  |

Identyfikator próby ma postać `K03-H-dynaminds` lub `K03-R-company-b`. Warianty A/G/R/Q/T/P mogą powołać się na konkretny test wspólnego kontraktu, lecz muszą także pokazać przejście przez narzędzie danej domeny. Jeżeli przypadek nie ma zastosowania, uzasadnienie jest jawne, a nie traktowane jako zaliczenie testu.

## Wynik biznesowy każdej kompetencji

| ID  | Pełny przebieg H                                                                                                                       | Krytyczne próby domenowe                                                                                                                                                                                                                                        |
| --- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| K01 | Klient → szansa → wersja oferty → akceptacja → poświadczenie przekazania → uzgodniony następny krok.                                   | Zmieniona cena/wersja; odrzucona oferta; brak zgody odbiorcy na następny krok; oferta nie oznacza wysłanej wiadomości.                                                                                                                                          |
| K02 | Zatwierdzone zapotrzebowanie → aplikacja → materiały i rozmowy → decyzja człowieka → właściwa współpraca.                              | Brak materiałów; odrzucona aplikacja; nieuprawniony decydent; ta sama osoba w innym procesie; zatrudnienie nie aktywuje automatycznie współpracy.                                                                                                               |
| K03 | Potrzeba → konkretny start → plan HR/IT → dokumenty/sprzęt/dostępy → poświadczenia → sprawdzona gotowość → odbiór.                     | Brak sprzętu; dokument w starej wersji; brak dostępu; spóźniony IT; druga osoba o tym samym imieniu; termin zmieniony po zatwierdzeniu; ogólny dowód nie przechodzi bramki.                                                                                     |
| K04 | Plan odejścia danej współpracy → przekazanie spraw → zwroty → potwierdzone zmiany dostępów → wyjątki → odbiór.                         | Nieoddany zasób; dostęp niepotwierdzony; druga aktywna współpraca; brak przyjmującego sprawy; anulowane odejście i częściowo wykonane zadania.                                                                                                                  |
| K05 | Ewidencja z pochodzeniem → rezerwacja → poświadczenie wydania → zwrot/serwis → uzgodniony stan.                                        | Dwóch chętnych na jedno urządzenie; rezerwacja wygasła; odmienny stan fizyczny; import tego samego urządzenia; zwrot po częściowym offboardingu.                                                                                                                |
| K06 | Zapotrzebowanie → porównanie → zgoda kosztowa → ewidencja zamówienia → częściowe/pełne przyjęcie; licencja → miejsce → przydział.      | Zmiana ilości/ceny; niepotwierdzona lub nadmiarowa dostawa; ten sam dokument/pozycja dostawy pod nowym kluczem komendy nie zwiększa ilości nawet poniżej limitu zamówienia; brak miejsc; wygaśnięcie/odnowienie; przydział miejsca nie dowodzi konta w usłudze. |
| K07 | Zatwierdzona oferta → odebrane przekazanie → właściciele → realizacja i dowody → odbiór rewizji → zaakceptowany pakiet do rozliczenia. | Odrzucone przekazanie/odbiór; nowy zakres; brak wymaganej pracy; korekta czasu/kosztu; rozdział walut; pakiet nie księguje ani nie płaci.                                                                                                                       |
| K08 | Lokalne źródło → szablon → wersja dokumentu → kompletność → akceptacja → wizualnie sprawdzony eksport.                                 | Źródło zmienione/usunięte; uszkodzony plik/SHA; brak pola; dostęp HR przez raport IT; wcześniejsza akceptacja nowej treści.                                                                                                                                     |
| K09 | Obserwacja → diagnoza → zakres → zatwierdzona procedura → wykonanie w laboratorium → niezależny test → odbiór/eskalacja.               | Stara obserwacja; nieznany wynik; błędny certyfikat/usługa nadal niedostępna; procedura z inną wersją; URL poza laboratorium.                                                                                                                                   |

## Odbiór elementów wspólnych

| ID  | Osobny dowód                                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| R01 | Zakres kolektora odrzuca obcą usługę, zachowuje pochodzenie/czas i odróżnia brak obserwacji od zdrowia.                                          |
| R02 | Osoba i współpraca są rozróżnione; relacje respektują tenant/obszar; źródło ma datę, wersję i aktualność.                                        |
| R03 | Potwierdzona zasada ma właściciela, wersję i termin przeglądu; sprzeczność/wygasła zasada wymaga decyzji; preferencja nie nadaje uprawnień.      |
| R04 | Zadanie przyjęte, odrzucone, przekazane lub spóźnione zachowuje historię po restarcie; zależności blokują przedwczesny odbiór.                   |
| R05 | Rejestr, wersja, argumenty, tenant i polityka są ponownie sprawdzane przed wykonaniem/recovery; model nie rozszerza swoich możliwości.           |
| R06 | Dwa profile przechodzą wszystkie kompetencje na tym samym kodzie; zmiana konfiguracji nie przepisuje starego zakresu.                            |
| R07 | Osobny trwały ledger i niezależny odczyt potwierdzają skutek; realne SIGKILL przed odpowiedzią; manipulacja dowodem wykryta.                     |
| R08 | Odbiór jest przypięty do rewizji i typowanych warunków, a wyjątek ma autora, termin i właściciela.                                               |
| R09 | Trwałe metryki/logi/traces w OSS, poprawna korelacja i restart, worker martwy przy żywym HTTP, awaria kolektora, redakcja oraz pomiar modelu.    |
| R10 | Rozmowa utrzymuje cel/sprawę i po restarcie wyjaśnia „co dalej”; tekst/głos prowadzą do równoważnego planu; panel pozwala działać bez UUID/JSON. |

## Dodatkowe bramki produktu

- Observability: trzy rzeczywiste sygnały zachowane po restarcie; brak przypadkowego wspólnego trace dla równoległych żądań; backlog po niedostępnym kolektorze jest ograniczony; zatrzymanie stosu nie zmienia skutków Core.
- UX: w każdej kompetencji widoczne są właściciel, termin, blokada i następne działanie. Pełny onboarding i IT przechodzą bez wpisywania nazw narzędzi czy identyfikatorów technicznych. Desktop i mobile mają czytelny wynik oraz brak błędów konsoli związanych ze zmianą.
- Głos: zestaw 20 polskich scenariuszy z nazwami, datami i kwotami; korekta transkrypcji, cisza, odmowa mikrofonu, przerwanie i powrót do tekstu. Prawdziwy mikrofon ma osobny wynik od testu WAV.
- Instalacja: czysta instalacja, start obu izolowanych trybów, aktualizacja podczas trwałego oczekiwania, backup/verify/restore i właściwy SHA po wznowieniu. Sesje po przywróceniu nie odzyskują automatycznie ważności.
- Proaktywność: symulowany dłuższy okres, wyciszenia i przesunięcia terminów; brak powielonych inicjatyw; zakończenie dopiero po potwierdzeniu stanu źródłowego.
- Dostawca modelu: własny klucz JARVIS, minimalny kontekst, realna odpowiedź, faktyczne tokeny i koszt według jawnego cennika. Bez klucza ten jeden odbiór pozostaje `blocked`, a pozostałe prace trwają.

## Kiedy plan jest zakończony

Każdy wiersz K/R ma pełny wynik i dowód odpowiadający uruchomionej wersji. Krytyczne scenariusze nie pozostają na stubach, komentarzach lub syntetycznym ekranie. Nie ma otwartej luki powodującej fałszywy odbiór, nieautoryzowany skutek albo brak izolacji. Pozostałe granice wynikają z umowy lokalnego produktu, a nie z porzuconego wdrożenia.
