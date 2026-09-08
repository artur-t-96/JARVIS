# P06 — pełny onboarding konkretnej współpracy

Baza: PR #17, `0a566dbc99e29c675b7572b0a60597359d490fa3`. Punkt odniesienia: [wizja K03](vision.md), [roadmapa P06](roadmap.md). Zależności sprzętu, dostępów i dokumentów zostały odebrane osobno. Ta paczka łączy je w jeden potwierdzony wynik.

## Kontrakty kompetencji

| Pole         | Ustalenie                                                                                                                                                                                                                                                       |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Potrzeba     | Uprawniona osoba wskazuje osobę, rodzaj i konkretną współpracę/projekt, rolę, datę startu oraz wersję profilu firmy.                                                                                                                                            |
| Operacje     | Plan startu i sprawa; praca HR; dokument z oryginałem; rezerwacja i poświadczone wydanie; poświadczone dostępy; ocena kierownika; odbiór sprawy; aktywacja. Każdy zapis ma odrębną zgodę Core.                                                                  |
| Uprawnienia  | Kierownik i HR mają zakres wynikający z konta. IT widzi przypisane zadanie oraz niezbędny sprzęt/dostępy. Uprawnienia operatora i zatwierdzającego są sprawdzane także przy odzyskaniu.                                                                         |
| Konfiguracja | Wersjonowane zadania i wymagania dla pracownika oraz konsultanta. Obecny profil ma jeden szablon onboardingu; rozszerzenie nie może po cichu zmienić aktywnych spraw ani dawnych decyzji.                                                                       |
| Stany        | Przygotowanie, konkretne blokady, gotowość do oceny, odmowa/poprawa, odebrany zakres oczekujący startu, aktywna współpraca, jawne anulowanie przed startem. Sprawa, okres współpracy i wykonanie zachowują osobne stany.                                        |
| Dowody       | Właściwa osoba i okres we wszystkich źródłach. Potwierdzone wydanie laptopa; zatwierdzona bieżąca rewizja dokumentu, plik jeżeli wymagany; aktualne poświadczenia aplikacji/ról i miejsca licencji; zakończone zadania z autorami; decyzja właściciela odbioru. |
| Odzyskanie   | Oczekiwanie na człowieka przeżywa restart. Trwały skutek uzgadniamy przez receipt i niezależny odczyt. SIGKILL po aktywacji nie dopisuje drugiego okresu, wydania ani decyzji.                                                                                  |
| Raportowanie | Widok konkretnej współpracy pokazuje datę, właściciela, odpowiedzialnych, terminy, aktualne dowody i kolejny krok. Raport przygotowania nie jest umową ani dowodem fizycznego wydania.                                                                          |

## Kolejność wykonawcza

**P06a — pełny przebieg i widok.** Najpierw test całości istniejących narzędzi: HR/dokument z plikiem, praca ograniczonego IT, wydanie i dostępy, odbiór kierownika, aktywacja, restart. Następnie usunięcie konkretnych braków integracji i spójny widok. W dwóch firmach sprawdzamy pracownika wewnętrznego oraz konsultanta na równoległych projektach. Sam pozytywny test jednej osoby nie zamyka P06.

**P06b — konfiguracje i zmiany.** Osobne szablony i wymagania pracownika/konsultanta, związane z zatwierdzoną wersją profilu. Przesunięcie daty wymaga nowego zakresu; stare potwierdzenia pozostają historyczne. Anulowanie przed startem musi zamknąć zamiar zatrudnienia bez fikcyjnej daty przepracowania, po rozliczeniu zasobów właściwego okresu. Obecne `cancelCase` anuluje zadania, lecz zachowuje stan okresu `onboarding`; istniejący offboarding nie obsługuje pełnego zamknięcia przyszłego startu przed jego datą. Ten brak wymaga jawnego kontraktu i migracji, nie usunięcia historii.

### Dostawy P06b

**P06b1 — warianty onboardingu.** Profil v4 zawiera `onboardingVariants.internal` i `onboardingVariants.contractor`: zadania oraz typowane wymagania. Sprzęt, dokument i dostęp pozostają obowiązkowe; każdy obowiązkowy warunek ma zadanie HR lub IT. Profil określa rodzaj dokumentu/sprzętu i ewentualny zestaw dostępów z wersją. Konkretne dowody osoby należą do sprawy. Wybór zestawu wymaga dodatkowo uprawnień IT i zgodności organizacji, klucza i wersji źródła.

Starszy profil v3 działa ze wspólnym szablonem do jawnej aktualizacji. `initiatives.configure` v4 przyjmuje taki starszy zakres, jeżeli nie usuwa już skonfigurowanych wariantów. Po zapisaniu obu wariantów ich pominięcie jest odrzucane. Formularz wczytuje nowe bazowe warianty wyłącznie na polecenie operatora i pokazuje oba przed przygotowaniem planu. `people.startEmployment`, `people.beginOffboarding` i `recruitment.hire` otrzymują wersję narzędzia 5; wcześniejsze zgody nie przenoszą się na zmienioną wersję. Offboarding zachowuje swój dotychczasowy szablon, a jego dalsze warianty należą do P11.

Nowa sprawa zapisuje wybrany wariant, wersję profilu i wymagania. Późniejszy profil nie zmienia sprawy. Zmiana daty w jawnej rewizji zachowuje te wymagania, przesuwa terminy, tworzy nowe zadania i wymaga nowych powiązań dowodów oraz odbioru. Trwały receipt wykonanego startu rozstrzyga odzyskanie także po późniejszej zmianie profilu; brak receipt nadal wymaga aktualnej wersji konfiguracji przed wykonaniem.

**P06b2 — anulowanie rozpoczęcia.** `ops.people.cancelStart` v1 zamyka wyłącznie okres `onboarding`. Właściciel sprawy jawnie potwierdza, że praca nie została rozpoczęta, i podaje powód; osobny zatwierdzający akceptuje konkretny plan Core. Obie osoby muszą mieć aktywne uprawnienia do ludzi, spraw, sprzętu, licencji i IT. Upływ planowanej daty sam nie rozstrzyga, czy człowiek zaczął pracę. Okres aktywny albo w offboardingu wymaga procesu odejścia.

Plan wiąże wersje osoby, okresu i sprawy, rewizję zakresu oraz skrót rozliczenia zasobów. Przed zapisem transakcja ponownie sprawdza właściciela, uprawnienia, historię zadań i zasobów. Rezerwacje trzeba zwolnić, sprzęt zwrócić z poświadczeniem, miejsce licencji odwołać, a cofnięcie dostępu potwierdzić. Wygasła obserwacja dostępu nie dowodzi jego odebrania. Niejednoznaczne historyczne przydziały bez okresu oraz rozbieżności relacji z niezmiennym obrazem rekordu blokują decyzję. Zmiana któregokolwiek z przypiętych danych wymaga nowego planu. Przydziały innego projektu tej samej osoby pozostają niezależne.

Zapis zachowuje planowaną datę, dowody, ukończoną pracę i historię decyzji; anuluje pozostałe zadania bieżącego zakresu i sprawę. Okres otrzymuje `cancelled`, uzasadnienie, autora i zatwierdzającego, bez fikcyjnej daty zakończenia pracy. Osoba bez innych okresów wraca do `registered`. Nowy start, także w tym samym dniu i projekcie, dostaje nowy okres, zadania i warunki; dawny odbiór nie przechodzi automatycznie.

Operations v11 przebudowuje tabelę okresów z nowym stanem i kontrolą decyzji. Zachowuje stare kolumny, wartości, wersje i odniesienia dostępu. Sterownik migracji stosuje [procedurę SQLite](https://www.sqlite.org/lang_altertable.html): wyłączenie kontroli FK przed transakcją tylko dla oczekującej przebudowy, kopiowanie, podmiana, kontrola FK przed wspólnym commit z ledgerem i przywrócenie kontroli także po błędzie. Stare nieanulowane projekcje nie dostają dopisanych pustych decyzji. Przyjęty skutek jest weryfikowany z trwałego receipt, stanu okresu, historii zadań i rozliczenia zasobów; nie wykonujemy go ponownie po utracie odpowiedzi.

## Macierz odbioru

- Wszystkie trzy typowane warunki spełnione, zadania zakończone i odebrane przez wskazanego właściciela; aktywacja dopiero w dacie startu według strefy firmy.
- Brak osoby/projektu, uprawnień, zgody, sprzętu, oryginału lub roli/licencji daje konkretną blokadę; notatka nie zastępuje dowodu.
- Odmowa kierownika, spóźnione IT, wygaśnięcie poświadczenia, zmiana dokumentu po odbiorze oraz zmiana zakresu wymagają odpowiedniej ponownej oceny.
- Restart podczas oczekiwania i rzeczywisty SIGKILL po zapisie: jeden skutek, utrzymana zgoda i poprawne uzgodnienie. Kopia obejmuje bazy i oryginały.
- Zmiana terminu oraz anulowanie z rezerwacją, wydanym sprzętem i licencją; nowy start tej samej osoby nie dziedziczy poprzednich dowodów. Drugi projekt pozostaje niezależny.
- Chrome ról w dwóch firmach, kontrola API/tenantów, aktualne logi i ślady OSS, końcowe CI oraz odbiór scalonej lokalnej instalacji.

Dane odbioru pozostają syntetyczne. Zewnętrzne konta nie są tworzone ani modyfikowane. P04 ma oddzielny otwarty odbiór rzeczywistego modelu; lokalne formularze i kontrolowany planer umożliwiają pracę nad P06.
