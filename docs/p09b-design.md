# P09b — raporty operacyjne z aktualnością zbioru

Punkt odniesienia: K08 i R02/R07 wizji oraz dalsza część P09 w roadmapie. P09a dostarczyło źródła, rewizje, pliki i eksporty; kolejnym rezultatem są użyteczne zestawienia wielu rekordów. Raporty realizacji i pakietów rozliczeniowych otrzymają właściwe reguły razem z P10, a nie pozorne potwierdzenie oparte na dawnych skrótach.

## Pierwsza paczka

Cztery definicje: gotowość startów, wyposażenie, dostawy i zobowiązania zakupowe/licencyjne. Każda ma jawny zakres danych, pola i reguły braków. Podgląd jest odczytem, stronicowanym; pokazuje pełną liczbę pozycji i okres/filtr. Zapis całego ograniczonego zbioru następuje po zgodzie Core. Przekroczenie limitu wymaga zawężenia zakresu, nie tworzy uciętego raportu udającego kompletny.

Gotowość korzysta z aktualnych bramek onboardingu oraz właściwego okresu współpracy. Wyposażenie odróżnia dostępność, rezerwację, fizyczne wydanie i otwartą rozbieżność spisu. Dostawy oddzielają zamówione, fizycznie otrzymane, przyjęte, odrzucone i zwrócone ilości. Zobowiązania odróżniają zamówienie od propozycji, zatwierdzone warunki od poświadczonego dokumentu oraz koszty netto/brutto i waluty. Brak dowodu lub kwoty pozostaje brakiem; nie dodajemy walut ani różnych podstaw podatkowych. Rejestr zobowiązania nie oznacza płatności ani księgowania.

## Dokument i zakres zgody

Raport jest dokumentem typu report, z niezmienną definicją źródłowego zbioru, wersjami/sumami źródeł, czasem i strefą firmy oraz wersją generatora. Plan zawiera definicję, odcisk konkretnego podglądu i tytuł; dane osób i szczegóły raportu pozostają poza kontekstem modelu. Osoba zatwierdzająca ma kontrolowany odczyt podglądu powiązany z wykonaniem.

Operacja utworzenia ponownie oblicza cały zakres. Zmiana źródła, dopisanie nowego rekordu pasującego do filtra lub zmiana profilu unieważnia przygotowaną zgodę. Dokument przechowuje migawkę oraz generowaną treść w tej samej transakcji co historia, audyt i receipt. Każdy odczyt wymaga documents i wszystkich bieżących oraz historycznych obszarów raportu. Dane innych firm i rekordy poza nadanym zakresem nie trafiają do licznika ani eksportu.

Gotowość dokumentu sprawdza również kompletność zbioru, nie tylko wersje pozycji już zapisanych. Odbiór i eksport zatwierdzonego raportu są blokowane po zmianie źródła lub zbioru. Jawne odświeżenie tworzy nową rewizję bez starej akceptacji. Swobodna edycja wygenerowanego raportu nie może pozostawić fałszywego oznaczenia zgodności z generatorem. Zwykłe dokumenty i ich historyczne skróty kontekstu zachowują dotychczasową semantykę.

Eksport używa istniejących lokalnych bibliotek DOCX/PDF. Uporządkowane sekcje, liczby, braki, źródła i odbiór mają być czytelne po wyrenderowaniu. Bez makr, pobieranych obrazów, wykonywania CSV ani zewnętrznej wysyłki.

## Kontrakt implementacji

Generator `p09b1-1` nie wywołuje modelu. `ops.documents.createReport` i `refreshReport` przyjmują identyfikator prywatnego podglądu, definicję, odcisk zbioru, wersję profilu i tytuł. Rewizja dodatkowo wskazuje dokument, jego wersję i powód. Migawka i treść pozostają poza planem Core, a osoba podejmująca decyzję odczytuje je przez zasób powiązany z konkretnym wykonaniem i autorem.

Migracja 17 dodaje `ops_report_previews`. Nieopublikowany podgląd wygasa po siedmiu dniach; limit wynosi 100 otwartych podglądów na firmę. Publikacja przypina go do jednego klucza operacji i dokumentu w tej samej transakcji co rewizja, historia i potwierdzenie skutku. Opublikowany podgląd pozostaje dostępny do uzgadniania także po upływie terminu, zmianie danych albo kolejnej rewizji dokumentu. Te zdarzenia nie uzasadniają ponownego wykonania zapisu.

Raport przedstawia bieżącą lokalną ewidencję. Okres filtruje daty rozpoczęcia współpracy, planowane daty dostawy albo okresy obecnie aktywnych umów licencji. Nie jest rekonstrukcją historycznego stanu na wybrany dzień. Nie dzieli kosztu umowy proporcjonalnie do okresu i nie dodaje propozycji nowych warunków do aktywnego zobowiązania. Dzień firmy, profil, pełne członkostwo zbioru i niezależnie sprawdzone relacje wchodzą do odcisku. Nieprawidłowa data nie może ukryć źródła za filtrem; brak daty pozostaje jawnym brakiem.

Przegląd pozycji ma strony po pięć rekordów. Cały raport ma granicę 200 pozycji, 50 000 znaków treści i 2 MB kontekstu. Przekroczenie dowolnej granicy wymaga zawężenia; nigdy nie zapisuje częściowego zbioru jako kompletnego. Przy otwartym dokumencie i oczekującej decyzji panel odświeża ocenę aktualności co pięć sekund. Ostateczną bramką zapisu, odbioru i eksportu pozostaje backend. Aktualność przechodzi także przez dokumenty pośrednie do wymagań sprawy, z kontrolą cykli.

## Odbiór paczki

- Dwie firmy/strefy, brakujące dane, pusty jawny zakres, wiele walut i różne podstawy kosztu.
- Nowa pozycja w zbiorze, zmiana źródła/przydziału/spisu lub profilu podczas oczekiwania; brak uprawnień, odmowa i anulowanie.
- Odrębna zgoda na zapis i decyzja odbioru; odświeżenie unieważnia wcześniejszą akceptację.
- Restart, utrata odpowiedzi, atomowy rollback i rzeczywisty SIGKILL z osobnym magazynem skutków w CI.
- Niespójne źródło lub historyczny kontekst nie daje poprawnego raportu; cofnięte uprawnienia obowiązują także przy wznowieniu i eksporcie.
- Chrome: filtr → podgląd → zgoda → raport → odbiór → czytelne DOCX/PDF; zatrzymana kopia i odtworzenie otwartego procesu, następnie scalona lokalna instalacja i OSS.
