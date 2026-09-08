# P05b2 — zamiana rezerwacji

Punkt startu: ewidencja P05b1 w PR #10, stabilizacja testu w PR #11 oraz formularz metadanych w PR #12. Ta paczka realizuje część K05 z [wizji](vision.md). Spis i import pozostają osobnymi częściami P05b.

## Zakres zatwierdzenia

`ops.assets.replaceReservation` wskazuje obie sztuki i ich wersje, dotychczasową alokację i jej wersję, uzasadnienie oraz przypiętą osobę, współpracę, sprawę, wersję okresu, wersję sprawy i rewizję jej zakresu. Przygotowanie planu uzupełnia wyłącznie brakujące odniesienia z konkretnej alokacji. Zatwierdzony plan nie wybiera kolejnej osoby ani projektu na podstawie późniejszego odczytu. Zmiana sprawy po przygotowaniu planu wymaga nowego planu i zgody.

Przed zapisem kod ponownie sprawdza konto, obszary danych, wersje, stan współpracy i sprawy, dostępność nowej sztuki i zgodność rodzaju sprzętu. Stara rezerwacja musi być bieżąca i mieć znany, zapisany termin UTC. Rezerwacje historyczne bez tych faktów wymagają jawnego rozstrzygnięcia. Wydany sprzęt wymaga osobnego poświadczonego zwrotu; nie przechodzi ścieżką zamiany rezerwacji.

## Jeden zapis domenowy

Jedna transakcja zapisuje zwolnienie starej alokacji, rezerwację nowej sztuki, dwa zdarzenia, dwie wersje ewidencji oraz jedno potwierdzenie Core/outbox. Nowa rezerwacja zachowuje poprzedni dzień końcowy, termin UTC, strefę i wersję profilu przypisaną do tego terminu. Dzisiejsza konfiguracja firmy nie przelicza terminu starej rezerwacji.

Dwa zdarzenia przekazania mają ten sam identyfikator operacji, ale różne urządzenia. Migracja v7 zmienia unikalność zdarzenia z operacji na operację i urządzenie, zachowując unikalność wersji alokacji. Odczyt do uzgodnienia skutku wskazuje konkretne urządzenie. Wynik zawiera identyfikatory obu alokacji i zdarzeń; domyślnie prowadzi do nowej zarezerwowanej sztuki.

Zmiana rezerwacji nie tworzy zdarzenia wydania ani nie zmienia wymagań sprawy. Jeżeli zakres wskazuje konkretny egzemplarz, nadal potrzebna jest właściwa rewizja zakresu.

## Odbiór

- Sukces w dwóch firmach i przy dwóch równoległych projektach jednej osoby; drugi projekt pozostaje bez zmiany.
- Wersja zmieniona po zgodzie, cofnięte uprawnienia, brak zasobu, wygasła lub historyczna rezerwacja i próba zamiany wydanego sprzętu.
- Błąd drugiego zapisu cofa także zwolnienie starej alokacji i całą historię.
- Dwa równoległe plany nie rezerwują jednej sztuki dla dwóch osób.
- SIGKILL po zatwierdzeniu transakcji, restart i uzgodnienie dwóch zdarzeń bez kolejnego skutku.
- UI: wybór właściwej alokacji i nowej sztuki, dokładny plan, osobna zgoda i czytelny rezultat. Dawny termin pozostaje widoczny.
