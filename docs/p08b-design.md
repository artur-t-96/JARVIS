# P08b — od potrzeby zakupu do przyjęcia dostawy

Punkt odniesienia: K06 oraz proces sprzętowy onboardingu w wizji i roadmapie. Pracujemy wyłącznie na własnych rekordach JARVIS. Decyzja kosztowa, ewidencja zamówienia, potwierdzenie dostawcy i fizyczne przyjęcie są odrębnymi zdarzeniami. Nie wysyłamy zamówień, nie wykonujemy płatności ani księgowań.

## P08b1 — decyzja i zamówienie

- Zapotrzebowanie ma ilość, opis, termin, budżet, walutę, podstawę ceny netto/brutto i właściciela decyzji. Może wskazywać konkretną rewizję sprawy oraz wymagany rodzaj wyposażenia. Nie utrwala danych osoby w ofercie dostawcy.
- Oferty mają stabilną tożsamość, kolejne wersje, aktywnego dostawcę i jego wersję, numer źródłowy, termin ważności, ilość, cenę jednostkową, koszt dostawy i warunki. Porównujemy tylko tę samą walutę, podstawę ceny i ilość; koszt liczymy w całkowitych najmniejszych jednostkach waluty. Brak informacji jest blokadą, a nie zerową ceną.
- Wybór oferty nie stanowi zgody kosztowej. Właściciel zatwierdza konkretną rewizję zapotrzebowania i wersję oferty z uzasadnieniem. Core osobno zatwierdza zapis decyzji. Zmieniona cena, ilość, termin lub zakres wymagają nowej decyzji.
- Lokalna ewidencja zamówienia powstaje atomowo z zaakceptowanego wyboru. Ta sama zgoda nie tworzy dwóch zamówień. Zapis przypina kwoty, ofertę i autorów. Przed zapisem ponownie sprawdzamy aktualność i uprawnienia. Status jawnie informuje o braku wysyłki.
- Nowy zapis starego typu `order` nie może omijać obiegu kosztowego. Historyczne zamówienia pozostają niezmienione i czytelne. Dawny szkic bez decyzji nie uzyskuje fikcyjnej akceptacji; wymaga nowego zapotrzebowania.
- Panel pokazuje oferty obok siebie, wybór, uzasadnienie, właściciela, pozostałą blokadę i powiązane zamówienie. Komendy pozostają w zamkniętym rejestrze; model nie ustala uprawnień.

## P08b2 — dostawa i wyposażenie

Każde przyjęcie ma tożsamość dokumentu dostawcy i pozycji, poświadczone ilości oraz rozbieżności. Ten sam dokument/pozycja przy nowym kluczu komendy nie zwiększa ilości. Częściowe przyjęcie pozostawia niedostarczoną część; nadwyżka, brak i uszkodzenie są jawnie rozstrzygane. Dostępne wyposażenie powstaje dopiero z przyjętej pozycji i podanych unikalnych numerów seryjnych, a ponowienie nie tworzy drugiego urządzenia. Wydanie nadal wymaga poświadczenia ze wspólnej ewidencji sprzętu.

Ta część domyka ciąg brak sprzętu → zapotrzebowanie → oferty → zgoda → zamówienie → częściowa/pełna dostawa → ewidencja → wydanie. Odnowienia i koszty licencji pozostają kolejną częścią pełnego P08.

## Dowody odbioru

Dwie firmy, brak danych/uprawnień, nieaktywny dostawca, zła waluta/podstawa/ilość, przekroczenie budżetu, odmowa, zmiana oferty podczas oczekiwania, anulowanie, utrata uprawnienia po zgodzie, zmiana powiązanego zakresu i nieudana weryfikacja. Odtworzenie zapisanej decyzji i zamówienia nie ponawia skutku. Rzeczywisty SIGKILL i migracje wykonuje hosted CI; lokalnie krótkie testy domeny/API/UI. Odbiór Chrome, backup/restore, exact SHA i telemetria OSS mają osobne dowody w dzienniku.

To kontrakt planowanej implementacji. Paczkę uznajemy za odebraną dopiero po wykonaniu jej prób i dostarczeniu scalonej wersji.
