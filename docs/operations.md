# Eksploatacja lokalnego JARVIS

JARVIS działa natywnie w Node.js 22.23, bez Dockera. Pliki danych i kopie są prywatne: katalogi `0700`, pliki `0600`. Nie uruchamiaj dwóch procesów na tym samym katalogu danych. Nie edytuj baz przez zewnętrzny program podczas pracy aplikacji.

## Stan procesu i workera

Diagnostyka rozdziela żywy proces HTTP (`live`) i gotowość do wykonywania pracy (`ready`). Gotowość wymaga zdrowej bazy, wolnego miejsca na dysku, wyłączonego trybu konserwacji oraz aktualnego, poprawnie zakończonego cyklu workera. Cykl bez zadań też jest poprawnym sprawdzeniem kolejki. Sam ruch HTTP nie odświeża heartbeat. Pierwszy cykl ma stan `starting`; brak postępu przez 30 sekund oznacza `stale`; zakończony błędem cykl oznacza `error`. Długi cykl również przekroczy próg gotowości, a rzeczywisty wiek i czas trwania są widoczne w diagnostyce.

Kolejka pokazuje zadania oczekujące, wykonywane, oczekujące na zgodę, zablokowane, błędne i wymagające uzgodnienia stanu. Stara lub brakująca kopia jest osobnym sygnałem operacyjnym, nie blokuje całego serwera. Domyślny próg wolnego miejsca to 64 MiB, a wiek kopii to 24 godziny.

Logi są liniami JSON z czasem, zdarzeniem i dozwolonymi polami operacyjnymi. Identyfikatory żądania, tenanta, zadania, kroku i operacji pomagają powiązać zdarzenia. Nie przekazuj treści rozmów, argumentów narzędzi, nagłówków, tokenów ani surowych błędów do logów. Nieznane pola są odrzucane, niedozwolone wartości redagowane. Metryki nie mają etykiet z identyfikatorami użytkowników lub zadań.

OpenTelemetry używa jawnych lokalnych providerów, pamięciowych śladów i metryk. Maksymalnie 128 zakończonych śladów jest przechowywanych pomiędzy resetami bufora. Brak automatycznej instrumentacji, globalnej rejestracji, kolektora lub eksportera sieciowego. Zmienne `OTEL_EXPORTER_*` nie aktywują eksportu. `sdk-node` jest zależnością do ewentualnego przyszłego, jawnie skonfigurowanego eksportu; proces nie uruchamia NodeSDK. Po restarcie agregaty i ślady zaczynają się od zera; trwałe zdarzenia biznesowe pozostają w SQLite.

## Migracje

Migracje mają kolejne numery od 1 i wykonują się w pojedynczej transakcji `BEGIN IMMEDIATE`. Błąd cofa cały pakiet zmian. Rejestr Core zachowuje istniejącą tabelę `schema_versions` v1. Moduły mogą używać własnej przestrzeni nazw, np. `schema_versions_operations`. Ponowne uruchomienie nie odtwarza wykonanych migracji. Starsza aplikacja odmawia otwarcia nowszego schematu; brak numeru w rejestrze również jest błędem. Nie usuwaj wpisów z rejestru, aby obejść kontrolę wersji.

## Kopia i odtwarzanie

1. Zatrzymaj JARVIS zwykłym SIGTERM/Ctrl+C i poczekaj na zakończenie procesu. Worker musi zakończyć bieżącą pracę, a połączenia SQLite muszą zostać zamknięte. Nie używaj SIGKILL do rutynowego backupu.
2. W katalogu projektu wykonaj `npm run backup -- /absolutna/sciezka/danych /absolutna/sciezka/kopii-2026-09-08`. Katalog docelowy musi być nowy i znajdować się poza katalogiem danych.
3. Sprawdź kopię poleceniem `npm run restore -- /absolutna/sciezka/kopii-2026-09-08 --verify`. Wynik zawiera datę, liczbę plików i SHA-256 manifestu.
4. Przećwicz odtworzenie: `npm run restore -- /absolutna/sciezka/kopii-2026-09-08 /absolutna/sciezka/nowych-danych`. Cel musi być pusty. Oryginalny katalog pozostaje zachowany.
5. Odtwórz ręcznie konfigurację dostępu i konta z tymi samymi identyfikatorami aktorów oraz właściwymi rolami/politykami. Uruchom aplikację na nowym katalogu, sprawdź gotowość, historię, oczekujące zgody i niezależny odczyt stanu operacji. Nigdy nie akceptuj brakujących uprawnień przez automatyczne nadanie roli wszystkim użytkownikom.

Manifest zapisuje `GIT_SHA`, a bez tej wartości odczytuje bieżący commit Git; poza repozytorium zapisuje `local`. Uruchamiaj CLI z wersji aplikacji odpowiadającej danym. Artefakt to lokalny katalog `manifest.json` + `payload/`, z sumą SHA-256 i rozmiarem każdego pliku, wersjami schematów, Node.js i SQLite. To nie jest zaszyfrowane archiwum ani zewnętrzny upload. Przechowuj go na prywatnym, szyfrowanym dysku. Suma kontrolna wykrywa uszkodzenie; nie zastępuje podpisu i zaufania do pochodzenia kopii.

Zakres obejmuje wszystkie operacyjne pliki `.sqlite`, także w podkatalogach, oraz pliki w `attachments/` i `evidence/`. Bazy `accounts.sqlite`, `session.sqlite`, `sessions.sqlite` i ich warianty z przyrostkiem są wyłączone. Konfiguracja, `.env`, klucze, logi i sesje nie są kopiowane. Rozmowy w `assistant.sqlite` są danymi prywatnymi i należą do zakresu kopii. Nie zapisuj sekretów w rozmowach ani bazach operacyjnych. Kopia odmawia publikacji przy rozpoznanym kluczu prywatnym, tokenie lub polu z jawnym sekretem; ta kontrola nie rozpoznaje dowolnego sekretu ukrytego w zwykłym tekście. Używaj prywatnej konfiguracji poza kopiowanymi danymi jako jedynego miejsca dla sekretów.

Backup i restore używają tej samej wyłącznej blokady co runtime. Backup wykonuje natywne snapshoty SQLite, sprawdza integralność każdej bazy i publikuje katalog dopiero po walidacji wszystkich plików. Informacja o ostatniej zweryfikowanej kopii trafia do `backup-status.json` przy utrzymywanej blokadzie konserwacji. Program odrzuca pliki dowiązań, niejawne dodatkowe pliki, niezgodne sumy, uszkodzone SQLite, niebezpieczne ścieżki i nieznany format manifestu.

Po przerwanym restore pozostaje `.restore-in-progress`. Runtime nie wystartuje z takim katalogiem. Zachowaj go do diagnozy i powtórz odtworzenie do innego pustego katalogu. Nie kasuj znacznika, aby uruchomić częściowe dane. Martwy PID lokalnego właściciela zwykłej blokady jest odzyskiwany automatycznie. Nierozpoznawalna blokada, inny host lub pozostawiona `.jarvis-lock-gate` wymaga ręcznego sprawdzenia, że żaden proces nie korzysta z danych, przed usunięciem wyłącznie pliku blokady. Nie usuwaj aktywnej blokady.

Po odtworzeniu baza może zawierać operację, której wynik nie był znany w chwili awarii. Najpierw uzgodnij jej stan z niezależnym trwałym źródłem efektu; nie wykonuj zapisu ponownie na podstawie samego timeoutu. Test infrastruktury odtwarza ukończoną operację oraz drugie zadanie czekające na dokładnie tę samą zgodę i sprawdza brak zdublowania efektów.

## Korelacja operacji

`Diagnostics.withWorkerTick` obejmuje rzeczywisty tick serwera; `withSpan` pozwala tworzyć jawne zagnieżdżone zakresy. Kontekst należy do operacji asynchronicznej. Niezwiązany log HTTP nie otrzymuje identyfikatora działającego równolegle workera, a zakończony span nie jest przypisywany do późniejszej pracy. Same `workerTickStarted/Completed` aktualizują heartbeat, bez aktywowania kontekstu dla dowolnych innych logów.

Ta poprawka jest częścią P02 [roadmapy](roadmap.md). Nadal działa wyłącznie ograniczony bufor w pamięci. Własne spany HTTP/wykonań/modelu, eksport do Collectora i trwały stos OSS mają odrębny odbiór.
