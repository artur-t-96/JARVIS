# P05b4 — import ewidencji z lokalnego CSV

K05 i R02 według [wizji](vision.md): ewidencja ma źródło i datę, import pokazuje konflikty przed zapisem. Bazą jest odebrany lokalnie PR #26. Ta paczka kończy import sprzętu z roadmapy; raporty przekrojowe pozostają P09.

## Źródło i podgląd

Użytkownik wybiera plik UTF-8 CSV, nazwę źródła, dzień aktualności i separator. Parser OSS [csv-parse](https://csv.js.org/parse/) 7.0.2 (MIT) obsługuje BOM, cudzysłowy, nowe linie oraz jawny separator. Nie rozdzielamy tekstu własnym `split`. Plik jest ograniczony do 512 KiB, 500 rekordów i 16 KiB na rekord; zatwierdzana partia obejmuje najwyżej 200 nowych urządzeń. Parser nie konwertuje numerów seryjnych na liczby ani daty.

Mapowanie obejmuje nazwę, rodzaj sprzętu, numer seryjny, lokalizację, stan, producenta i model. Polskie i angielskie nagłówki mają rozpoznane aliasy; inne nazwy wymagają jawnego mapowania. Niezmapowane kolumny, powtórzone nagłówki, niepełne rekordy i duplikaty w pliku pozostają błędami. Podgląd jest odczytem: pokazuje każdą pozycję, numer w źródle, rozpoznane dane, kolizję z obecną ewidencją oraz wybrany zakres. Rekordy z istniejącym numerem seryjnym nie są automatycznie zmieniane. Pominąć je można tylko jako widoczną część zatwierdzonego zakresu. Plik nie poświadcza fizycznego wydania, zwrotu ani dostępu do innej aplikacji.

## Zapis i źródło dowodu

Przygotowanie planu przechowuje dokładny plik w prywatnym magazynie wejść, na wzór obecnych plików dokumentów. Manifest zawiera autora, firmę, nazwę, rozmiar, SHA-256, datę, wersję parsera i konfigurację. Plan wskazuje niezmienny manifest, odcisk podglądu i wybrane pozycje. Zmiana pliku, zakresu lub istotnej wersji ewidencji wymaga nowego podglądu i zgody. Nie wysyłamy zawartości źródła do modelu.

`ops.assets.importBatch` wymaga aktywnego operatora i zatwierdzającego z zakresem assets. Jedna transakcja tworzy wybrane urządzenia istniejącą ścieżką ewidencji, ich pierwsze wersje, audyt, rejestr skutków, zdarzenie outbox i trwały protokół importu. Każde urządzenie wskazuje konkretną pozycję źródła. Stan wymagający naprawy trafia do serwisu, bez fikcyjnego zdarzenia przyjęcia. Zapisane źródło pozostaje lokalne, dostępne tylko w firmie i obszarze danych; przygotowane, nieużyte wejścia mają limit oraz termin ważności. Kopia/odtworzenie obejmuje wejście oczekującego planu i źródło wykonanego importu.

Wznowienie sprawdza trwały protokół, historyczne wersje oraz oryginalny plik. Upływ terminu wejścia po zatwierdzonym skutku nie powoduje ponownego importu. Brak lub uszkodzenie pliku oznacza brak spójnego dowodu. Historia importów i pobranie źródła mają osobną kontrolę dostępu i stronicowanie. Nie ma harmonogramu synchronizacji ani połączeń do źródłowych systemów.

## Odbiór

- Dwie firmy, UTF-8/BOM, średnik/przecinek/tabulator, cytowane pola, numery z zerami i powtarzalne mapowanie; zgodny i uszkodzony sprzęt.
- Jawne błędy i konflikty, ograniczenia rozmiaru, brak kolumn, nieprawidłowy typ/dzień oraz kolizja dopisana podczas oczekiwania na zgodę.
- Brak uprawnień, obca firma lub autor wejścia, odmowa/anulowanie bez skutku, zmiana zakresu i atomowy rollback całej partii.
- Utrata odpowiedzi i rzeczywisty SIGKILL po zatwierdzeniu partii: oddzielny rejestr trwałych skutków, bez drugiego urządzenia lub protokołu.
- Niezależna weryfikacja migawek i pliku, bezpieczne ścieżki, zachowane wcześniejsze rekordy i odbiory.
- Chrome: plik → podgląd → konkretny plan → zgoda → urządzenia, protokół i źródło. CI, otwarta kopia, merge, główna instalacja i ślad OSS.
