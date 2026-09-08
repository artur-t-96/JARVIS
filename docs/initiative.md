# Inicjatywy i profil firmy

JARVIS wykrywa lokalne sytuacje wymagające decyzji i zapisuje propozycje w trwałej kolejce. Skan nie wykonuje żadnego działania w źródłowej sprawie, rezerwacji, licencji lub incydencie. Nie wysyła powiadomień do zewnętrznych usług, nie zmienia ról i nie aktywuje integracji.

## Reguły

| Reguła                   | Rzeczywisty warunek                                          | Proponowany dalszy krok                               |
| ------------------------ | ------------------------------------------------------------ | ----------------------------------------------------- |
| `overdue_case`           | Termin niezakończonej sprawy minął w strefie czasowej firmy  | Ustalić właściciela i dalszy termin                   |
| `overdue_task`           | Otwarte zadanie aktualnej rewizji sprawy ma miniony termin   | Uzyskać decyzję wykonawcy i dowód wykonania           |
| `expired_reservation`    | Aktywna rezerwacja sprzętu jest po terminie                  | Ocenić, czy zaplanować zwolnienie lub nową rezerwację |
| `license_expiry`         | Licencja wygasła albo pozostało nie więcej dni niż w profilu | Zweryfikować potrzebę odnowienia i uzyskać dowód      |
| `high_severity_incident` | Otwarty incydent IT ma ważność `high` lub `critical`         | Ustalić właściciela i udokumentować diagnozę          |

Każda propozycja zawiera źródłowy moduł i rekord, wersję źródła, datę ostatniego odczytu, termin i właściciela, gdy są znani. Skan nie wymyśla właściciela ani daty. Fingerprint obejmuje firmę, źródło, regułę i ewentualne zadanie lub rezerwację. Powtórny skan odświeża obserwację tego samego wpisu, zamiast tworzyć nowy alert.

Oddzielny fingerprint istotnego stanu uwzględnia pola potrzebne danej regule. Zmiana liczby stanowisk licencji nie przywraca odrzuconego przypomnienia; zmiana daty wygaśnięcia już może to zrobić. Przejście od licencji wkrótce wygasającej do wygasłej podnosi ważność i ponownie otwiera propozycję. Po ustąpieniu warunku, np. ukończeniu zadania lub odnowieniu licencji poza oknem przypomnienia, autoryzowany skan oznacza propozycję jako `resolved`.

## Decyzje człowieka

Narzędzia `initiatives.snooze`, `initiatives.dismiss` i `initiatives.resume` przechodzą przez plan i dokładną zgodę Core. Wejście zawiera `id`, `expectedVersion` oraz `reason`; odłożenie dodatkowo `until` w formacie ISO. Można odłożyć propozycję najwyżej na 90 dni. Odłożenie przetrwa restart; po upływie czasu następny skan ponownie otworzy wpis. Odrzucenie pozostaje skuteczne do istotnej zmiany źródła. Zmiana wersji propozycji unieważnia polecenie przygotowane dla wcześniejszego stanu.

Każda decyzja ma trwały klucz operacji, wersję skutku oraz autora wniosku i zatwierdzającego z kontekstu Core. Ponowne wykonanie identycznego polecenia zwraca ten sam skutek. Zmienione argumenty przy tym samym kluczu są błędem. Niezależna weryfikacja odczytuje rejestr wersji oraz bieżący stan; sam zapis odpowiedzi narzędzia nie stanowi dowodu.

## Uprawnienia i częściowe skany

Odczyt kolejki i jej decyzje wymagają kompetencji `initiatives`; decyzje wymagają również aktualnych kompetencji źródłowego rekordu. Uwzględniane są granice Workspace, np. sprawa onboardingu wymaga `cases` i `people`. Propozycja ujawniająca właściciela lub odbiorcę sprzętu dodatkowo wymaga `people`. Firma pochodzi wyłącznie z zaufanego kontekstu; API nie przyjmuje jej identyfikatora jako argumentu decyzji.

Skan użytkownika z węższymi uprawnieniami nie zamyka ani nie odrzuca propozycji dotyczących źródeł, których nie odczytał. Lista również ponownie sprawdza aktualne uprawnienia źródła. Limit listowania Workspace oznacza, że jeden skan może być częściowy; brak rekordu w takim skanie nie jest dowodem ustąpienia problemu. Rekord usunięty lub niedostępny nie jest automatycznie uznawany za naprawiony.

## Wersjonowany profil firmy

Profil zawiera nazwę firmy, strefę czasową, liczbę dni przed wygaśnięciem licencji, godziny ciszy, przełączniki pięciu reguł oraz szablony onboardingu i offboardingu. Domyślna strefa to `Europe/Warsaw`, wyprzedzenie 30 dni, cisza od 20:00 do 08:00. Godziny ciszy nie blokują obserwacji. Oznaczają otwarte propozycje jako `quiet_hours` i zerują liczbę do bieżącego pokazania jako wymagające reakcji. Po zakończeniu ciszy propozycje znów są aktywne bez tworzenia duplikatów.

`initiatives.configure` wymaga kompetencji `company`, pełnego obiektu ustawień, `expectedVersion` i zgody Core. Zwrócony profil zawiera `version`, `definitionVersion`, `updatedBy` oraz `updatedApprovedBy`; klient nie może podać tych pól jako rzekomej tożsamości. Zmiana profilu nie nadaje uprawnień. Interfejs może pobrać schemat wejścia bezpośrednio z `ToolDefinition.inputSchema`; niedozwolone pola są odrzucane.

Każde zadanie szablonu ma `{key,title,required,offsetDays,dependsOn}`. Klucze są unikalne, zależności wskazują wyłącznie wcześniejsze zadania, a szablon musi zawierać przynajmniej jedno obowiązkowe zadanie. Limit to 30 zadań i przesunięcie terminu od -365 do +365 dni względem daty procesu. Szablon jest deklaratywny: nie zawiera kodu, adresów integracji ani poleceń systemowych.

Workspace pobiera zatwierdzoną wersję szablonu przez wewnętrzny provider, przypina ją do planu Core i zapisuje migawkę w nowej sprawie lifecycle. Aktualizacja profilu nie zmienia już utworzonych zadań, przyjętej rewizji ani dotychczasowych dowodów.

Testy modułu używają rzeczywistych lokalnych rekordów Workspace. Sprawdzają dwie firmy z różnymi terminami przypomnień, wszystkie pięć reguł, brak duplikatów, restart, odłożenie/odrzucenie, częściowe uprawnienia, strefę czasową, rozdzielenie autora i zatwierdzającego oraz odrzucenie niepoprawnych szablonów i manipulacji bieżącym stanem poza rejestrem wersji.

## Integracja lifecycle

Runtime łączy profil przez WorkspaceStore.setProfileProvider. Start współpracy, zatrudnienie i początek offboardingu przypinają profileVersion przed hashowaniem planu. Zapis i uzgodnienie sprawdzają wersję; sprawa zachowuje migawkę szablonu. Terminy wynikają z daty rozpoczęcia/zakończenia, a zależności kluczy zamieniają się na identyfikatory trwałych zadań.
