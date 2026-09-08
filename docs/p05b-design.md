# P05b — domknięcie ewidencji wyposażenia

Punkt startu: odebrane P05a, `7d188a41b23243f02a1908c4dc729d03b85a9e87`, operations v5. Wymagania: [wizja K05](vision.md), [roadmapa P05](roadmap.md), [kontrakt przekazań](p05-design.md). Całość nadal dotyczy wyłącznie lokalnego JARVIS. Ten dokument opisuje pracę do wykonania, nie dowód gotowości.

## Kolejność

1. **Ewidencja i serwis:** osobna historia każdej nowej wersji urządzenia, metadane producenta/modelu, wskazany aktywny opiekun ewidencji, jawne przeniesienie, przekazanie do serwisu, poświadczenie naprawy i wycofanie. Zmiana lokalizacji nie przechodzi zwykłym formularzem metadanych. Aktywne wydanie najpierw wymaga poświadczonego zwrotu; rezerwację trzeba jawnie zwolnić. Serwis i wycofanie nie usuwają historii.
2. **Zamiana rezerwacji:** dokładne dwie wersje urządzeń i dotychczasowa alokacja, jedna transakcja, ta sama osoba/okres/sprawa. Dotychczasowy termin UTC i strefa pozostają przypięte. Nie przenosimy poświadczenia już wydanej sztuki na inną.
3. **Spis z natury:** planowane pozycje ze stanem oczekiwanym, odrębne obserwacje człowieka (obecny/brak, lokalizacja i stan), jawne rozbieżności. Brak, uszkodzenie lub inne miejsce blokują dalsze wydanie i aktualność dowodu. Rozstrzygnięcie wymaga nowej zgody i dowodu, nie zaznaczenia ogólnego „zgodne”.
4. **Import:** CSV ograniczone wielkością, podgląd bez zapisu, pochodzenie i hash pliku, identyfikatory źródła i pozycji, błędy oraz konflikty numerów seryjnych. Zatwierdzenie konkretnych poprawnych pozycji korzysta z domeny JARVIS i tej samej transakcji. Powtórzony plik lub numer seryjny pod nowym kluczem nie tworzy drugiej sztuki.
5. **Odbiór K05:** dwa profile firmy, interfejs i API, restart/utrata odpowiedzi, wyścig, cofnięcie dostępu, aktualność dowodów oraz migracja i odbudowa kopii. K05 pozostaje częściowe do zakończenia wszystkich tych punktów.

## Historia a przekazanie

Historia ewidencji obejmuje wszystkie nowe wersje urządzenia. Zdarzenia P05a nadal są źródłem poświadczenia konkretnej alokacji. Nowa tabela ewidencji wiąże tenant, urządzenie, jego wersję i hash zapisanego obrazu, operację Core, inicjatora i zatwierdzającego oraz poprzednie zdarzenie. Dopisuje się w tej samej transakcji co wersja urządzenia. Nie zastępuje poświadczenia fizycznego przekazania i nie dodaje autorów do dawnych rekordów.

Weryfikacja porównuje historię z trwałymi wersjami i bieżącym urządzeniem. Usunięcie środkowego zdarzenia, podmiana autora albo obrazu ma być wykryta. Pierwsze zdarzenie starej sztuki wskazuje jawnie poprzednią wersję historyczną; migracja nie udaje odbytego spisu ani znanej lokalizacji fizycznej.

## Operacje i dostęp

Właściciel ewidencji jest aktywnym kontem z prawem do wyposażenia, a nie domyślnie osobą, której wydano laptop. Zmiana opiekuna nie nadaje temu kontu nowych uprawnień. Dostęp IT przez zadanie pozostaje ograniczony do konkretnego przekazania; nie ujawnia pełnej historii ewidencji ani dawnych osób.

Przeniesienie, serwis i wycofanie wiążą bieżącą wersję urządzenia, datę obserwowanej czynności, uzasadnienie i poświadczenie operatora. Urządzenie z aktywną alokacją nie może przejść tej ścieżki. Wycofanie jest stanem końcowym, nie usunięciem danych. Naprawa nie usuwa otwartej rozbieżności. Metadane i historia administracyjna same nie świadczą o sprawności fizycznego sprzętu.

## Wspólny panel decyzji

Po domknięciu domeny rozwinąć podsumowania zgód o nazwy właściwych zasobów, daty i poświadczenia. Identyfikatory i hashe pozostają dostępne w szczegółach. Opis musi wynikać z tego samego zapisanego, zatwierdzanego zakresu; aktualny odczyt zmienionego rekordu nie może podmienić znaczenia starej zgody.
