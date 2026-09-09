# P10 — sprzedaż, przekazanie i pakiet rozliczeniowy

Punkt odniesienia: K01/K07/K08 oraz R02/R04/R07/R08 wizji. Własna implementacja JARVIS; źródła ATLAS i ELEVATE czytane wyłącznie z obiektów Git. Odczytane SHA: ATLAS `33f0f6f5a152727036d413b9aed64a1626f67858`, ELEVATE `fcb0a7185c596ee9786a5afc7259e1de0a9dc188`. Nie oznaczają aktualnego wdrożenia tych aplikacji.

ATLAS: `src/models/company.py`, `contact.py`, `deal.py`, `offer.py`, `src/services/offers/pricing_calculator.py`, `src/services/deal_lifecycle.py`. Potrzebne wzorce: firma i kontakt niezależne od szansy; osoba odpowiedzialna; rzeczywiste zdarzenie odróżnione od terminu zadania; niezmienne wersje treści i kalkulacji; deterministyczne ceny godzinowe, miesięczne, MD oraz etapy projektu. Reguła etapu nie staje się poświadczeniem wysłania oferty. Bez cenników, przykładów klientów, tokenów, modeli, synchronizacji i rendererów źródłowej aplikacji.

ELEVATE: `lib/estimate.ts`, `app/(app)/tickets/[number]/delivery-accept-modal.tsx`, `supabase/migrations/20260727151000_staff02_client_only_settlement.sql`. Potrzebne wzorce: jawna jednostka wyceny, odrębne dostarczenie i decyzja odbiorcy, związanie z konkretną zaakceptowaną ofertą, odrzucenie z powodem i powrót do poprawek. Nie kopiujemy opłat, kredytów, portfeli, RPC ani finansowego księgowania.

## P10a — CRM, wersja oferty i następny krok

Własna firma klienta, kontakt z powiązaniem do firmy, szansa z właścicielem i kontrolowanym etapem. Oferta wskazuje szansę i wersję danych klienta/kontaktu. Kwoty mają walutę, podstawę netto/brutto, jednostkę i deterministycznie policzone pozycje. Ilości i ceny przechowywane bez błędów zmiennoprzecinkowych; limit liczby pozycji, odrzucenie przepełnienia i niekompletnych danych.

Przygotowanie → oddzielna decyzja wewnętrzna → poświadczenie przekazania konkretnej wersji → decyzja klienta z referencją dowodu → potwierdzony następny krok z właścicielem i terminem. Model nie oznacza wysyłki ani akceptacji. Jedna obowiązująca zaakceptowana oferta na szansę; wybór/zmiana ma jawny powód, unieważnia stare zależne akceptacje i nie tworzy drugiego zobowiązania. Zmiana treści zawsze tworzy nową rewizję. Historia oddziela zmianę wersji, zgodę na zapis, decyzję biznesową i poświadczenie zdarzenia.

Kontrakt pierwszego przyrostu (`p10a1`, narzędzia sprzedaży v5, operations v18):

- Nowa oferta wymaga przypisanego kontaktu tej samej firmy, jawnie przypiętych wersji klienta/kontaktu/szansy i aktywnego właściciela. Właścicielem nowej szansy jest wskazane konto albo jawnie pokazany autor jej utworzenia.
- Kwoty to całkowite najmniejsze jednostki waluty, ilości to tysięczne części jednostki. Pozycje: godzina, MD, miesiąc, sztuka lub ryczałt. Ryczałt ma ilość 1; MD nie jest automatycznie zamieniane na godziny. Każdą pozycję zaokrąglamy połową w górę; używamy `BigInt` do mnożenia, ograniczenia 40 pozycji i wartości całej oferty. Brak cennika domyślnego i automatycznych podatków.
- `draft → proposed → approved → sent → accepted`: przygotowanie, wewnętrzna decyzja właściciela, jego poświadczenie przekazania i poświadczenie odpowiedzi klienta. Każdy zapis ma oddzielną zgodę Core. Nie ma rzeczywistej wysyłki ani połączenia z klientem.
- Rewizja jest dostępna przed akceptacją oraz po potwierdzonym wycofaniu. Zachowuje treść i decyzje poprzedniej rewizji, czyści bieżące potwierdzenia i zaczyna od szkicu. Maksymalnie 50 rewizji jednej oferty. Zamknięte rekordy już wcześniej miały ogólną blokadę edycji; teraz również edycja szkicu wymaga dedykowanej rewizji.
- Jedno bieżące zobowiązanie na szansę: transakcja sprawdza również historyczne oferty, a indeks SQLite dodatkowo chroni nowe rekordy. Zapis akceptacji atomowo zmienia ofertę i wskazanie w szansie. Wycofanie uzgodnień wymaga dowodu i poświadczenia człowieka; aktywna współpraca lub realizacja blokuje prostą operację anulowania. Zmiana istniejącej realizacji należy do P10b/c.
- Dane klienta i kontaktu są sprawdzane ponownie przed uzgodnieniem. Po akceptacji obowiązuje niezmienna migawka uzgodnionej oferty; późniejsza zmiana danych kontaktowych jest widocznym ostrzeżeniem, nie usuwa historycznie przyjętego zobowiązania. Data ważności ogranicza faktyczną datę przyjęcia oferty, a nie datę późniejszego odnotowania tej odpowiedzi. Dni zdarzeń są oceniane w strefie firmy.
- Następny krok jest odrębnym trwałym wpisem z właścicielem, terminem, przyjęciem albo odmową i dowodem wyniku. Właściciel kroku sam go przyjmuje i kończy; właściciel szansy może go anulować. Jeden otwarty krok na szansę, strony historii i wyszukiwanie bez cichego limitu listy. Prototyp przekazania wymaga przyjętego, niezaległego kroku; zamrożony zakres i akceptacja trafiają do sprawy. Odrębne przyjęcie realizacji przez odbiorcę będzie bramką P10b.
- Migracja nie zmienia wcześniejszych rekordów i nie wymyśla ich właścicieli ani zgód. Historyczne oferty można odczytać albo jawnie wycofać z dowodem po przypisaniu właściciela szansy. Dalsze uzgadnianie wymaga nowej oferty. Istniejące powiązania i odebrane sprawy pozostają zachowane.
- Szablon dokumentu korzysta z rzeczywistej kalkulacji i stanu konkretnej rewizji, jawnie oznacza brak akceptacji i wiąże źródło z wersją oferty. Eksporty i odbiór dokumentu korzystają z P09. Pobranie dokumentu nie potwierdza wysłania oferty.

Implementacja i celowane testy są w toku. Pełne bramki migracji/SIGKILL, Chrome, pliki, kopia/odtworzenie i instalacja scalonego SHA pozostają warunkami dostarczenia.

## P10b — przyjęcie realizacji

Oferta z potwierdzonym uzgodnieniem → pakiet przekazania z migawką zakresu, terminem, wymaganiami i właścicielem → przyjęcie przez właściwego wykonawcę albo odmowa. Właściciel odbioru jest odrębny od przypisania pracy. Dopiero przyjęcie otwiera realizację. Dowody wiążą się z wersją zakresu; korekta zakresu wymaga ponownego uzgodnienia i nie zachowuje nieaktualnego odbioru. Zadania człowieka korzystają z trwałego modułu P03.

## P10c — przygotowanie rozliczenia

Zadeklarowany czas i koszty z dowodami → kontrola zgodności z zakresem → odbiór realizacji → wersjonowany pakiet do osobnej akceptacji. Kwoty i jednostki pozostają rozdzielone. Kwota oferty, koszt wykonania i kwota do rozliczenia są odrębnymi pojęciami. Pakiet wskazuje konkretną ofertę, rewizję sprawy, odbiór, wpisy pracy, dokumenty i źródła; zmiana któregokolwiek istotnego źródła unieważnia aktualność. DOCX/PDF i raport realizacji korzystają ze wspólnych mechanizmów P09, bez księgowania, fakturowania i płatności.

## Wspólny odbiór

Dwie firmy, niezależne role i zakresy; brak danych, niezgodny kontakt, odmowa, nieaktualna wersja, wiele konkurencyjnych ofert, brak lub spóźnienie człowieka. Rzeczywiste SIGKILL w CI, osobny magazyn skutków, zgody sprawdzane po wznowieniu, odmowa ponownego niepewnego zapisu. Przegląd Chrome, zmiana bez przeładowania, czytelny eksport, kopia oczekującego procesu i odtworzenie. Każdy przyrost osobno dostarczony przez PR/CI, następnie oba lokalne tryby oraz OSS na scalonym SHA. Pozostałe systemy bez zmian.
