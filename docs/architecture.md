# JARVIS Core v0.1

Rdzeń prowadzi zatwierdzony plan przez dozwolone narzędzia, trwałe oczekiwania,
ponowienia i niezależną weryfikację. Model językowy może proponować plan, ale nie
nadaje uprawnień i nie rozstrzyga, czy wynik jest potwierdzony.

## Granice wersji

To pojedyncza instalacja na jednym hoście z lokalną bazą SQLite. Nie jest to
klaster ani uniwersalny silnik dowolnych procesów. Baza musi znajdować się w
trwałym katalogu, nie na sieciowym filesystemie ani w usuwanym katalogu
tymczasowym. Zatrzymanie procesu nie usuwa planu, zgody ani stanu próby.

Wersja demonstracyjna zawiera narzędzia działające na danych lokalnych. Nie
dołącza adapterów do ELEVATE, ATLAS, systemów kadrowych ani innych systemów
produkcyjnych. Nie tworzy ani nie zmienia ich rekordów. Przyszłe adaptery
wymagają osobnych kontraktów autoryzacji, idempotencji i odczytu wyniku.

## Zasady wykonania

1. Rejestr narzędzi definiuje ich identyfikator, wersję, walidację argumentów,
   rodzaj skutku i sposób odzyskania wyniku. Plan nie może zmienić tych cech.
2. Zaufana konfiguracja przypisuje operatora do organizacji i ról. Każda
   operacja jest sprawdzana w jej kontekście. Brak uprawnienia oznacza odmowę.
3. Zapis wymaga zgody. Zgoda odnosi się do konkretnego planu i argumentów;
   zmiana zakresu nie dziedziczy wcześniejszej zgody. Oczekiwanie jest trwałym
   stanem, bez blokowania transakcji lub procesu na czas decyzji człowieka.
4. Claim i numer próby są zapisywane przed wywołaniem narzędzia. Lease ogranicza
   własność próby; fencing uniemożliwia staremu workerowi nadpisanie nowszego
   stanu. Transakcja SQLite nie pozostaje otwarta podczas pracy narzędzia.
5. Niejednoznaczny wynik zapisu wymaga uzgodnienia z systemem docelowym.
   Potwierdzony skutek jest weryfikowany, potwierdzony brak może pozwalać na
   ponowienie, a wynik nieznany pozostaje widoczną blokadą.
6. Odpowiedź narzędzia i potwierdzony wynik są oddzielne. Weryfikator odczytuje
   stan docelowy i zapisuje dowód powiązany z operacją. Sam opis sukcesu nie
   wystarcza do ukończenia wykonania.

Idempotency key opisuje jedną zamierzoną operację, a nie kolejną próbę
połączenia. Ten sam klucz z innymi argumentami musi być konfliktem. JARVIS nie
obiecuje wykonania dokładnie raz przez dowolne narzędzie: potrzebne jest wsparcie
idempotencji lub uzgadniania stanu po stronie systemu docelowego. Sam lease
chroni stan silnika, ale nie cofa skutku wykonanego przez zewnętrzny system.

W przyszłej integracji sprawa biznesowa i decyzja odbioru pozostają w systemie
domenowym. Lokalna zgoda v0.1 autoryzuje operację testową; nie jest odbiorem
usługi przez klienta ani zgodą na rozliczenie.

## Co sprawdzają testy

Testy używają osobnej bazy skutków narzędzia. Zapis w systemie docelowym może
zostać zatwierdzony, zanim silnik zapisze jego wynik — to rzeczywiste okno
awarii, którego nie odtworzyłaby wspólna transakcja obu zapisów.

Test procesowy uruchamia worker, doprowadza do oczekiwania na zgodę i wysyła
SIGKILL. Nowy proces odczytuje tę samą zgodę, zapisuje skutek, po czym również
otrzymuje SIGKILL przed zapisem wyniku w silniku. Kolejny proces uzgadnia stan
i weryfikuje skutek; licznik wywołań i licznik skutków pozostają równe jeden.

Pozostałe testy obejmują izolację organizacji i ról, konflikt idempotency key,
nieaktualną zgodę, cofnięcie uprawnienia, zmianę polityki, anulowanie, odmowę,
negatywną weryfikację, wynik nieznany i powrót workera z wygasłym lease.
Testy są host-native; nie wymagają Dockera ani połączenia z produkcją.

SIGKILL sprawdza odzyskanie po utracie procesu. Nie symuluje utraty zasilania,
awarii dysku, wszystkich zachowań przyszłych dostawców ani odporności klastra.
Skończony zestaw testów nie jest gwarancją braku duplikatów przy dowolnej awarii.

## SQLite

v0.1 używa `journal_mode=DELETE` i `synchronous=FULL`: krótkich transakcji
z pełną synchronizacją oraz zwykłego rollback journal. Nie wymaga WAL.
Należy obsługiwać blokady i zachować trwałość zatwierdzonych operacji.

Jeżeli w kolejnej wersji potrzebny będzie WAL, wspiera on współbieżny odczyt
i zapis na jednym hoście, ale nadal dopuszcza jednego writera.
`synchronous=FULL` synchronizuje wtedy WAL przy commit. Przy kopii otwartej
bazy nie można pominąć pliku WAL; kopię wykonywać mechanizmem SQLite albo
po poprawnym zamknięciu bazy.
Źródło: [dokumentacja SQLite WAL](https://sqlite.org/wal.html).

Wersję SQLite sprawdza się wewnątrz używanego runtime Node, nie wyłącznie
systemowym CLI. Poprawka błędu WAL-reset jest dostępna od 3.51.3 oraz w
backportach 3.44.6 i 3.50.7. Źródło:
[SQLite — WAL-reset bug](https://sqlite.org/wal.html#walresetbug).
