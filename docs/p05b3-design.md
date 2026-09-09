# P05b3 — spis sprzętu i wyjaśnianie rozbieżności

K05 według wizji: stan z datą, źródłem i autorem. P05a/b1/b2 dostarczyły ewidencję, wydania, zwroty, serwis i zamiany. Ta paczka dodaje spis z natury; import z lokalnego pliku pozostaje następną P05b4.

## Kontrakt

Spis ma własny rekord, wersję zakresu, właściciela będącego aktywnym operatorem sprzętu, termin i jawnie wybrane urządzenia. Otwarcie przypina identyfikatory, wersje oraz sumy migawek ewidencji. Podgląd zakresu niczego nie zapisuje. Nie obejmujemy automatycznie urządzeń dodanych po zatwierdzeniu zakresu. Zmiana zakresu wymaga nowego spisu lub nowej zatwierdzanej rewizji przed pierwszą obserwacją.

Pozycja pokazuje osobno stan oczekiwany przy otwarciu, bieżącą ewidencję i poświadczenie obserwacji: znaleziono/brak, lokalizację, stan techniczny, dzień, notatkę oraz autora. Brak obserwacji nie oznacza zgodności. Data nie może wykraczać poza dzień firmy ani poprzedzać otwarcia spisu. Strefa i wersja profilu są przypięte; zmiana konfiguracji nie zmienia dawnej daty.

Rozbieżność ma identyfikator, właściciela, termin, powód i następne działanie. Brak, uszkodzenie, inna lokalizacja i zmiana ewidencji podczas spisu są widoczne. Obserwacja nie przenosi urządzenia, nie odwołuje przydziału i nie poświadcza zwrotu. Ewidencję korygują istniejące zatwierdzane operacje. Zamknięcie rozbieżności wymaga nowego poświadczenia zgodnego z dokładną bieżącą wersją urządzenia oraz decyzji właściciela; wcześniejsze obserwacje pozostają w historii.

Otwarte rozbieżności sprzętowe blokują nowe wydanie/rezerwację i pozytywną ocenę dowodu sprzętowego. Zwrot, zwolnienie i wyjaśnienie pozostają dostępne. Nie odbieramy zasobów innej współpracy. Anulowanie spisu nie usuwa zapisanych ustaleń ani nierozstrzygniętych braków. Odbiór spisu wymaga wszystkich obserwacji i wyjaśnionych rozbieżności. Wynik jest datowanym protokołem spisu, nie bezterminową deklaracją zdrowia sprzętu.

## Wykonanie

Nowy moduł wymaga jawnych zakresów `inventory` i `assets`; korzysta ze wspólnych wersji rekordów, audytu, rejestru skutków i Core. Każde otwarcie, obserwacja, przekazanie odpowiedzialności, wyjaśnienie, anulowanie i odbiór ma konkretny plan oraz zgodę. Odczyty i niezależna weryfikacja sprawdzają tenant, aktywne uprawnienia, zgodność migawek i źródeł. Limit 200 urządzeń dotyczy jawnie wybranej partii. Historia ma stronicowanie. Nie zmieniamy schematu ani danych dawnych urządzeń: spisy zajmują nowe rekordy wspólnego magazynu i jego rejestru wersji.

Nie tworzymy nowej infrastruktury: Zod i istniejące SQLite/Core wystarczają. OSS telemetryczny rejestruje wykonania jak pozostałe komendy; argumenty i informacje o osobach nie trafiają do logów.

## Odbiór

- Dwie firmy: poprawny spis oraz brak/uszkodzenie/inna lokalizacja; odrębny operator i zatwierdzający.
- Zmieniony zakres lub wersja urządzenia podczas oczekiwania, brak uprawnień, odmowa oraz anulowanie bez kasowania ustaleń.
- Opóźniony właściciel i przekazanie odpowiedzialności są widoczne w kolejce spisów. Automatyczne inicjatywy i eskalacje pozostają w przekrojowym P12.
- Rozbieżność unieważnia aktualność sprzętowego warunku onboardingu; zwrot innej współpracy pozostaje nienaruszony.
- Utrata odpowiedzi, restart i rzeczywisty SIGKILL w CI: jeden zapis obserwacji/wyjaśnienia w oddzielnym magazynie; brak podwójnego skutku.
- Historyczne rekordy, wydania i odbiory zachowane. Kopia/odtworzenie otwartego spisu, Chrome, końcowe CI, merge, lokalny SHA i rzeczywisty ślad OSS.
