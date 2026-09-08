# P08a — wymagane dostępy i poświadczenia

Punkt startu: PR #13, `d05d65a`, 286 testów CI. P05a dostarcza dowód fizycznego wydania, P05b1–2 ewidencję i zamianę rezerwacji. Odbiór onboardingu nadal wymaga dokumentu i dostępu. Ta paczka buduje źródło dla `access_attested`; P09a dostarczy dokument, a P06 przeprowadzi cały proces.

## Co potwierdza JARVIS

JARVIS zapisuje poświadczenie uprawnionego wykonawcy dotyczące konkretnej aplikacji, roli, osoby i okresu współpracy. Poświadczenie wymaga daty sprawdzenia, opisu sposobu weryfikacji oraz aktualnej zgody na zapis. Zapis licencji, utworzenie zadania ani komentarz „gotowe” nie zastępują tego źródła. Operacja nie nadaje uprawnień w innych aplikacjach i nie łączy się z nimi.

Klucz `employee-workspace` lub `contractor-workspace` oznacza jawnie zdefiniowany zestaw wymagań. Jedno dowolne konto nie może spełnić całego zestawu. Brak konfiguracji pozostaje blokadą, aż uprawniony człowiek zatwierdzi konkretną definicję i rewizję sprawy.

## Model

- Katalog aplikacji i wersjonowane zestawy dostępów są własnymi rekordami modułu IT. Nie dodajemy dziesiątej kompetencji. Aplikacja ma stabilny klucz, nazwę, status i deklarowane źródło informacji; sam adres nie uruchamia kolektora.
- Zestaw określa wymagane aplikacje i role, okres aktualności sprawdzenia oraz opcjonalny wymóg konkretnej licencji. Każda definicja jest niepusta i ma unikalne pozycje. Zmiana definicji tworzy nową wersję.
- Wymaganie sprawy wiąże identyfikator i wersję zestawu. Starsze wymaganie z samym `accessKey` pozostaje nierozstrzygnięte; migracja nie dopisuje fikcyjnych aplikacji ani dowodów. Uzupełnienie następuje przez zatwierdzoną konfigurację szablonu lub rewizję sprawy.
- Osobne tabele przechowują rekordy poświadczonego dostępu i niezmienne zdarzenia. Tożsamość obejmuje firmę, osobę, współpracę, aplikację, rolę i identyfikator konta bez sekretów. Zdarzenie zapisuje wykonawcę, zatwierdzającego, datę obserwacji, ważność, metodę sprawdzenia oraz kontekst Core.
- Miejsce licencji, gdy wymagane, wskazuje konkretny przydział tej samej osoby i współpracy. Jego cofnięcie, brak miejsc albo wygaśnięcie unieważnia warunek przy niezależnym odczycie.
- Cofnięcie dostępu wymaga własnego poświadczenia. Nie przepisuje autora ani daty wcześniejszego nadania. Powiązania z innymi współpracami blokują automatyczne traktowanie wspólnego konta jako cofniętego dla wszystkich; dalsza obsługa współdzielonych zasobów pozostaje częścią P11.
- Odnowienie jest osobną zatwierdzaną operacją: ponowne sprawdzenie tej samej osoby, współpracy, aplikacji, roli i konta tworzy kolejną wersję poświadczenia. Może powiązać istniejący dostęp z aktualną definicją i rewizją sprawy. Wcześniejszy zapis pozostaje niezmienny. Dzięki temu zmiana zakresu albo upływ ważności nie wymaga fikcyjnego cofnięcia i ponownego nadania konta.

## Narzędzia i kontrola dostępu

Katalog i zestawy konfiguruje operator z właściwymi obszarami IT/firmy/licencji; każda zmiana przechodzi przez istniejący Core. Pełny operator może przygotować rekord dla konkretnej sprawy. W kolejnym przyroście P08a2 wąski wykonawca IT otrzyma osobny widok swojego przyjętego zadania oraz tylko niezbędne dane odbiorcy i projektu, zgodnie ze wzorcem P05a. P08a1 nie rozszerza uprawnień kont IT do katalogu HR ani pełnego dokumentu sprawy.

Przygotowanie planu przypina wersje zadania, sprawy, rewizji zakresu, okresu, aplikacji, zestawu i ewentualnego przydziału licencji. Ponowny odczyt przed zapisem sprawdza aktualne konto, role, obsadę zadania i wszystkie powiązania. Zmiana zakresu lub wersji wymaga nowej zgody. Potwierdzenie pracy nie kończy automatycznie zadania ani odbioru sprawy.

Trwały zapis obejmuje rekord dostępu, zdarzenie, odpowiednią wersję zadania/sprawy, ledger polecenia i outbox w jednej transakcji. Po utracie odpowiedzi uzgadniamy istniejący efekt; nie tworzymy kolejnego poświadczenia. Odczyt do odbioru sprawdza fakty wszystkich wymaganych pozycji zestawu, integralność zdarzeń, daty i stan licencji. Brak, odmowa, cofnięcie oraz przeterminowane sprawdzenie pozostają widoczne.

## Kolejność realizacji i odbiór

1. Zamknąć kontrakty i migrację katalogu, zestawów i poświadczeń. Zachować działające narzędzia IT oraz dotychczasowe wymagania z widocznym brakiem konfiguracji.
2. Dodać kontrolowane komendy, zdarzenia, niezależne źródło odbioru oraz blokady przy zmianie wersji i uprawnień.
3. Dodać formularze konfiguracji, widok zadania IT, poświadczenie i jawne powiązanie dowodu. Pełny operator widzi historię; wąski IT wyłącznie własny zakres.
4. Sprawdzić dwa profile firmy i dwa równoległe projekty jednej osoby, brak członka zestawu, błędną osobę/rolę, brak lub cofnięcie licencji, nieaktualną obserwację, odmowę, zmianę zakresu, odwołanie konta i negatywną weryfikację.
5. Rzeczywisty SIGKILL po zapisie oraz restart/restore potwierdzają jeden skutek w osobnym trwałym magazynie domeny. Hosted CI, osobny PR i odbiór Chrome scalonej instalacji domykają paczkę.

P08a nie zamyka całego K06 ani onboardingu P06. Pełny obieg zakupowy, współdzielenie zasobów, dokumenty oraz rzeczywiste adaptery pozostają w roadmapie z osobnymi dowodami.

## Przyrosty dostarczenia

- **P08a1:** katalog, zestawy, migracja v8, poświadczenie/odnowienie/cofnięcie przez operatora pełnej sprawy, niezależne powiązanie całego zestawu, formularze i historia. Wersja `ops.cases.bindEvidence` wzrasta z 5 do 6; nowy plan po aktualizacji obejmuje dokładny skrót odczytu wszystkich poświadczeń. Starsze oczekujące plany tej komendy wymagają ponownego przygotowania, istniejące dowody sprzętu zachowują swój format. Wznowienie zapisanego poświadczenia uzgadnia trwały skutek także po upływie jego ważności; aktualność dostępu jest osobnym odczytem.
- **P08a2:** poświadczenia przez przyjęte zadanie IT z minimalną projekcją, kontrolą obsady i zależności, bez udostępnienia pełnej sprawy. Następnie P09a i pełny odbiór P06.

Kontrole P08a1: `access-register.test.ts` (dziewięć scenariuszy domenowych), `access-api.test.ts`, `access-migration.test.ts`, `access-process-recovery.test.ts` (rzeczywisty SIGKILL dla utworzenia, odnowienia i cofnięcia). Fixture v7 pochodzi z dostarczonego `d05d65a`, a nie z bieżącego konstruktora. Status CI, Chrome i lokalnej aktualizacji należy odczytywać z dziennika dostarczenia.
