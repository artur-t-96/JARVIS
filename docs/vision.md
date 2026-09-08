# JARVIS — punkt odniesienia produktu

Źródło: [Mapa wizji JARVIS v0.4, 6.09.2026](https://claude.ai/code/artifact/9d7afd7b-dd22-4c61-9571-31e063800b03).
Zweryfikowano treść mapy 8.09.2026. Historyczne opisy braku repozytorium i braku mostów nie są wymaganiami ani aktualnym audytem produkcji.

## Umowa zakresu

Końcowy produkt obejmuje wszystkie kompetencje poniżej. Działa lokalnie, we własnym repozytorium, z własnymi danymi i konfiguracją. Kod ATLAS/NEXUS/COMPASS/ELEVATE może być źródłem adaptacji. Nie zmieniamy źródeł, baz, sekretów ani wdrożeń tych aplikacji. Połączenie z zewnętrznym systemem wymaga osobnego włączenia; symulacja nie jest dowodem produkcyjnego skutku.

Trzy osobne odpowiedzialności: moduł posiada dane biznesowe; sprawa posiada uzgodniony zakres, dowody i odbiór; Core posiada wykonania, próby, oczekiwania i zgody na konkretne operacje. Model językowy nie nadaje uprawnień. Każdy zapis biznesowy wymaga konkretnej zgody. Pytanie uzupełniające, zgoda i potwierdzenie pracy człowieka są różnymi zdarzeniami.

## Katalog kompetencji

| ID  | Kompetencja                | Kryterium odbioru                                                                              |
| --- | -------------------------- | ---------------------------------------------------------------------------------------------- |
| K01 | Sprzedaż                   | Zatwierdzona wersja oferty, historia przekazania, potwierdzony następny krok.                  |
| K02 | Rekrutacja                 | Zatwierdzone zapotrzebowanie, skoordynowany proces, komplet materiałów, decyzja człowieka.     |
| K03 | Onboarding                 | Gotowość konkretnego okresu współpracy na start lub jawne blokady.                             |
| K04 | Offboarding                | Przekazanie spraw, potwierdzone zwroty i zmiany dostępów, rozstrzygnięte wyjątki.              |
| K05 | Inwentaryzacja             | Stan z datą, źródłem i potwierdzeniem osoby; brak podwójnego przydziału.                       |
| K06 | Zakupy, dostawcy, licencje | Zatwierdzony zakres, udokumentowane zamówienie/dostawa, kontrola miejsc i odnowień.            |
| K07 | Sprzedaż do realizacji     | Potwierdzony odbiór przekazania, właściciele, wykonanie i zaakceptowany pakiet do rozliczenia. |
| K08 | Dokumenty i raporty        | Wersjonowany dokument ze źródłami, kontrolą kompletności i akceptacją.                         |
| K09 | IT i bezpieczeństwo        | Ustalenie, diagnoza, zatwierdzona procedura i niezależny test wyniku.                          |

## Elementy wspólne

R01 autoryzowane rozpoznanie; R02 model firmy i aktualność źródeł; R03 potwierdzona pamięć zasad; R04 trwałe procesy i ludzie; R05 kontrolowane narzędzia; R06 konfiguracje i rozszerzenia; R07 dowody i weryfikacja; R08 sprawy i odbiór; R09 observability technologii, procesów i modelu; R10 rozmowa tekstowa, głos i widoki operacyjne.

Każda kompetencja ma osiem pól specyfikacji: potrzeba/uruchomienie, operacje, uprawnienia, konfiguracja, stany, dowody/odbiór, odzyskanie stanu, raportowanie. Odbiór wymaga dwóch konfiguracji firmy i scenariuszy: brak danych/dostępu, odmowa, przerwane wykonanie, ponowienie, opóźnienie człowieka, nieudana weryfikacja.

## Kolejność

1. Fundament: migracje, diagnostyka, backup/restore, sprawy i zadania człowieka.
2. Rozmowa, model firmy i reguły.
3. Observability i rozpoznanie lokalnego laboratorium.
4. Pełny onboarding i pełna sprawa IT.
5. Cały katalog kompetencji, wspólne dokumenty i dowody.
6. Proaktywność, wyjątki, kontrola zobowiązań i przegląd kierownika.
7. Głos i personalizacja.
8. Powtarzalna instalacja, aktualizacja, odtworzenie i odbiór całej macierzy.

Miary: potwierdzone wyniki i terminy, czas do pierwszej wartości, czas człowieka, trafność inicjatyw, udział konfiguracji, liczba konfiguracji na wspólnym rdzeniu, jakość i pokrycie danych, niezamierzone duplikaty. Brak danych nigdy nie jest zerem ani sukcesem.
