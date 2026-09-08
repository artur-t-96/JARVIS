# Lokalna instalacja JARVIS

Instalator i launcher działają wyłącznie we własnym katalogu projektu `jarvis-core`. Wymagają Node.js 22.23+ z serii 22.x, zgodnie z `.nvmrc`. Nie używają Dockera, nie zmieniają pozostałych repozytoriów i nie instalują usług systemowych. Polecenie `update` buduje aktualnie wybrany lokalny commit; nie wykonuje samodzielnie `git pull`, merge, reset ani przełączenia gałęzi.

## Instalacja i wersja

```sh
nvm use
npm run local -- install
npm run local -- start lab
npm run local -- status lab
npm run local -- stop lab
```

Instalacja wykonuje natywne `npm ci` i `npm run build`. Manifest `.data/local-product/install.json` zawiera dokładny Git SHA, oznaczenie `-dirty`, jeśli źródła mają zmiany, wersję Node i SHA-256 wszystkich plików `dist/`, `assets/` (w tym czcionek dokumentów), `package.json` i lockfile. Przed startem launcher ponownie sprawdza manifest i dodatkowe pliki. Sukces startu wymaga odpowiedzi `/api/ready` z tym samym SHA oraz potwierdzonego procesu korzystającego z właściwego katalogu danych.

Zmiany robocze są dopuszczone wyłącznie w laboratorium. Tryb operacyjny wymaga buildu czystego commitu. Edycja plików skompilowanej aplikacji lub zależności projektu wymaga ponownego `update`; istniejący plik manifestu nie jest automatycznie traktowany jako dowód poprawności.

Aktualizacja wymaga zatrzymania obu trybów, ponieważ współdzielą ten sam build:

```sh
npm run local -- stop lab
npm run local -- stop operational
npm run local -- update
npm run local -- start operational
```

Launcher sprawdza blokady danych również dla aplikacji uruchomionej ręcznie w domyślnym `.data`. Nie omijaj blokad. Błąd kompilacji lub niezgodny manifest blokuje start; instalator nie udaje udanej aktualizacji i nie usuwa danych biznesowych. Wybór wcześniejszego commitu oraz zgodnej kopii danych pozostaje jawną decyzją administratora; nie ma automatycznego cofania migracji.

## Oddzielne środowiska

| Tryb          | Katalog danych      | Domyślny adres          | Dostęp                         |
| ------------- | ------------------- | ----------------------- | ------------------------------ |
| `lab`         | `.data/lab`         | `http://127.0.0.1:4310` | Lokalny operator laboratorium  |
| `operational` | `.data/operational` | `http://127.0.0.1:4320` | Konta JARVIS i sesje logowania |

Możesz podać inny nieuprzywilejowany port: `npm run local -- start lab --port 4330`. Oba tryby wiążą wyłącznie `127.0.0.1`. Nie ma automatycznego kopiowania klientów, pracowników, kont lub historii z laboratorium do pracy operacyjnej. Samo uruchomienie trybu operacyjnego nie aktywuje integracji innych systemów.

Tryb operacyjny odmawia startu bez jawnie utworzonych aktywnych kont, które zapewniają rolę operatora i zatwierdzającego w tej samej firmie. Launcher nie tworzy użytkowników, nie wybiera ich ról i nie zmienia zasad akceptacji. Administrator może przygotować konta istniejącym poleceniem, przy zatrzymanej aplikacji:

```sh
JARVIS_DATA_DIR="$PWD/.data/operational" npm run users -- create < /prywatna/sciezka/uzytkownik.json
```

Plik wejściowy powinien być prywatny (`0600`) i znajdować się poza repozytorium. Dane wejściowe obejmują `id`, `tenantId`, `username`, `password`, `roles` i `scopes`. Nie przekazuj hasła w argumentach terminala. Przy odtwarzaniu backupu ponownie ustanów właściwe konta i uprawnienia; archiwum danych biznesowych nie przenosi sesji ani haseł.

Kopie twórz dla konkretnego zatrzymanego katalogu trybu, np. `npm run backup -- "$PWD/.data/operational" /prywatna/sciezka/kopii`. Pełna procedura w [operations.md](operations.md).

## Opcjonalny sekret dostawcy

Bez jawnego wyboru dostawcy uruchomienie nie włącza chmurowego planera. Na macOS klucz Anthropic można zapisać w Keychain osobno dla tego katalogu JARVIS i każdego trybu. Sekret jest przekazywany wyłącznie prywatnym stdin procesu `security`, bez argumentu zawierającego klucz i bez kopiowania go do plików projektu, logów lub manifestu.

```sh
python3 -c 'import getpass; print(getpass.getpass("Klucz Anthropic: "))' | npm run local -- secret-set operational
npm run local -- secret-status operational
```

Polecenie statusu zwraca tylko dostępność Keychain i informację, czy wpis istnieje. System może poprosić o odblokowanie Keychain lub zgodę na dostęp. Nie stosujemy opcji pozwalającej wszystkim aplikacjom na dostęp do wpisu. Na innych systemach operacyjnych obsługa Keychain jest jawnie niedostępna; nie powstaje zastępczy jawny plik z sekretem.

Jawna aktywacja dostawcy przy starcie wymaga także identyfikatora modelu:

```sh
npm run local -- start operational --provider anthropic --model IDENTYFIKATOR_MODELU
```

Przy tak wybranym dostawcy tekst używany przez planer jest wysyłany do jego API zgodnie z działaniem aplikacji; lokalna transkrypcja audio pozostaje w Whisper. Klucz zostaje odczytany z Keychain do pamięci i środowiska procesu serwera. Nie trafia do statusu, adresu URL ani listy argumentów. Ambientne tokeny i ustawienia proxy nie są automatycznie dziedziczone przez uruchamiany serwer. Instalator zależności używa zwykłego środowiska administratora, aby respektować istniejący dostęp do rejestru npm.

Jawna niesekretna konfiguracja `JARVIS_MODEL_PRICING` może zawierać `{version,currency,inputPerMillion,outputPerMillion}` dla wybranego modelu. Launcher sprawdza jej pola i przekazuje ją do aplikacji tylko przy aktywacji dostawcy. Bez cennika koszt pozostaje nieznany; nie podstawiaj fikcyjnej stawki 0.

## Procesy i logi

Proces nadzorujący przechwytuje stdout i stderr serwera, w tym ostrzeżenia bibliotek natywnych. Log ma limit 5 MiB i dwie rotacje: maksymalnie 15 MiB na tryb. Pliki znajdują się w `.data/local-product/lab.log` lub `operational.log` oraz przyrostkach `.1`, `.2`, z uprawnieniami `0600`. To uzupełnienie redakcji pól w Diagnostics, nie zgoda na wypisywanie sekretów przez aplikację.

`stop` wysyła zwykły SIGTERM tylko po potwierdzeniu PID, polecenia procesu i losowego tokenu jego blokady danych. Czeka na łagodne zakończenie; nie stosuje SIGKILL po przekroczeniu limitu. Niezweryfikowany lub ponownie użyty PID nie jest sygnalizowany. Po zatrzymaniu workera zamykane są bazy i zwalniana blokada, dzięki czemu można bezpiecznie wykonać backup albo aktualizację.

Polecenie `status` rozdziela żywy własny proces, gotowość HTTP, integralność zainstalowanego buildu oraz SHA zwrócone przez serwer. Zielona odpowiedź HTTP z innego procesu lub innej wersji nie wystarcza do potwierdzenia startu.

Testy uruchamiają prawdziwe krótkie procesy Node na losowych portach localhost. Sprawdzają instalację, zgodność SHA, start/stop, brak sygnału do obcego PID, warunek kont, rozdzielenie danych i ograniczenie logów. Test Keychain używa podstawionego procesu polecenia; nie zapisuje prawdziwego sekretu ani nie zmienia istniejących wpisów użytkownika.

## Klucz własnego laboratorium HTTPS

P07b generuje wyłącznie materiały testowe własnej usługi. Prywatne klucze CA i certyfikatu są zaszyfrowane w `laboratory.sqlite`; plik `laboratory-wrapping.key` w tym samym katalogu danych ma tryb 0600 i nie trafia do standardowej kopii. Nie udostępniaj go przez panel, zgłoszenia ani repozytorium. Zachowaj osobną prywatną kopię tego pliku, jeśli chcesz przenosić lub odtwarzać materiały TLS.

Przy odtworzeniu zatrzymaj instancję, odtwórz zwykłą kopię do pustego katalogu, a następnie przywróć **ten sam** plik opakowujący do tego katalogu z uprawnieniami 0600. Kluczy nie wyświetlaj w terminalu. Konta i sesje konfiguruj osobno według dotychczasowej instrukcji. Uruchom JARVIS i wykonaj nowy odczyt certyfikatu. Bez właściwego pliku stan HTTPS pozostaje niepotwierdzony; aplikacja nie odnowi automatycznie utraconych materiałów i nie doda zaufania do systemu operacyjnego. Odciski zapisane przed kopią powinny pozostać identyczne.

Aktualizacja kodu zachowuje katalog danych i jego prywatny plik. Procedura `lab.renewCertificate` wymaga sprawy, zgody na konkretny odcisk oraz niezależnego testu. Żaden z tych kroków nie dotyczy certyfikatów innych aplikacji.
