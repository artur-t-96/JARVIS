# P07 — sprawa IT i własne laboratorium

Punktem odniesienia pozostają K09, R04–R07 oraz demonstrator IT z wizji. P07a domyka niedostępną usługę HTTP. P07b dodaje rzeczywisty certyfikat i weryfikację TLS. Obie paczki dotyczą wyłącznie laboratorium JARVIS.

## P07a: zakres

1. Zamknięty katalog wskazuje jedną własną usługę, protokół, procedurę i limit aktualności obserwacji. Nie przyjmuje adresu URL ani polecenia powłoki od użytkownika lub modelu.
2. Rzeczywisty odczyt HTTP zapisuje obserwację ze źródłem, czasem, wersją celu, tenantem i wykonaniem Core. Nieudany odczyt pozostaje nieudany, a stary odczyt nie oznacza zdrowej usługi.
3. Zatwierdzone utworzenie sprawy przypina konkretną obserwację awarii, diagnozę operatora i wersję procedury. Ta sama firma może mieć najwyżej jedną otwartą sprawę tej usługi. Obowiązkowy test pozostaje częścią każdej rewizji zakresu.
4. `lab.repairCase` wiąże zgodę z celem, wersją usługi, sprawą i jej rewizją. Kod ponownie sprawdza aktywne konta, dostęp, właściciela i zakres. Istniejący magazyn skutków laboratorium zachowuje niezależność od Core i danych spraw.
5. Po zapisie osobny odczyt HTTP sprawdza rezultat. Trwała obserwacja jest dowodem wyłącznie wtedy, gdy odpowiada zatwierdzonemu skutkowi i zakończonej pozytywnie weryfikacji konkretnego kroku Core. Samo pole `healthy`, notatka operatora ani dawny `lab.repair` nie zamyka sprawy.
6. Warunek `test_passed` otrzymuje zamknięty czytnik tego dowodu. Powiązanie i odbiór są oddzielnymi zgodami. Czytnik kontroluje firmę, cel, zakres, wersję procedury, integralność zapisu, aktualność i brak późniejszej awarii. Brak źródła pozostaje widoczną blokadą.
7. Odbiór biznesowy korzysta ze wspólnych mechanizmów spraw. Wygasły lub zmieniony dowód wymaga nowego odczytu oraz jawnej rewizji, jeśli wcześniejsze powiązanie zostało już zamrożone. Odrzucenie i anulowanie nie wykonują naprawy.

Panel rozdziela obserwację, diagnozę, proponowaną procedurę, wynik wykonania i decyzję o odbiorze. Pokazuje autora, czas, ograniczony cel oraz przejście do właściwego wykonania. Eksport diagnostyczny i telemetryczny zachowuje dotychczasową redakcję.

## P07b: certyfikat

Własny serwer HTTPS z lokalnym kluczem, prawdziwym X.509 i weryfikacją nazwy, dat oraz łańcucha. Biblioteka OSS zastąpi własne kodowanie certyfikatów. Zaufanie obowiązuje tylko klienta laboratorium; systemowy magazyn zaufania pozostaje niezmieniony. Przypadki obejmą wygaśnięcie, niewłaściwą nazwę i nieufnego wystawcę. Dodatni test nie może wyłączać weryfikacji TLS. Certyfikat, jego odcisk, procedura i skutek rotacji podlegają tym samym zgodom, odzyskiwaniu i kopiom co usługa HTTP.

## Odbiór i dostarczenie

- Dwie firmy: rzeczywista awaria → diagnoza → sprawa → zgoda innego konta → naprawa → niezależny test → powiązanie → odbiór.
- Brak danych, obca firma, zbyt wąskie lub odwołane uprawnienia, odmowa, zmiana zakresu, konflikt wersji i anulowanie przed zapisem.
- Negatywny test, stara obserwacja, późniejsza awaria i uszkodzony zapis nie dają gotowości. Dawne niesprecyzowane `testKey` nadal nie mają zastępczego dowodu.
- Restart w oczekiwaniu, utrata odpowiedzi po skutku, brak powtórzenia operacji; rzeczywisty SIGKILL w hosted CI. Backup/restore obejmuje oddzielną bazę laboratorium i zachowuje pochodzenie.
- Lokalne krótkie testy, typy i build; pełne bramki CI. Chrome na podglądzie oraz na scalonym SHA głównej instalacji, metryki/logi/ślady OSS, dowody w macierzy i dzienniku.

Dokument jest projektem wykonawczym. Wyniki odbioru wpisujemy dopiero po sprawdzeniu.
