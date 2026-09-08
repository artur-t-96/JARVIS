# Lokalna obsługa głosu

Rozpoznawanie mowy używa `whisper.cpp` z modelem wielojęzycznym `base` i wymuszonym językiem polskim. Nagranie nie trafia do dostawcy chmurowego. Przycisk mikrofonu powinien jedynie uzupełniać edytowalny tekst; użytkownik sprawdza transkrypcję przed wysłaniem polecenia. Samo nagranie nie zatwierdza planu ani operacji.

## Instalacja na macOS Apple Silicon

Z katalogu JARVIS wykonaj:

```sh
npm run voice:setup -- /absolutna/sciezka/JARVIS/.data/voice
```

Skrypt wymaga Python 3.9+, narzędzi kompilatora Apple (`xcrun --find clang`) i systemowego `curl`. Tworzy prywatne środowisko Python z przypiętym CMake 3.31.6 wewnątrz katalogu JARVIS. Nie instaluje globalnych pakietów i nie używa Dockera. Pierwsza instalacja wymaga sieci do pobrania narzędzia budowania, oficjalnych źródeł oraz modelu. Transkrypcja po instalacji działa lokalnie bez sieci.

Źródła są przypięte do [whisper.cpp v1.8.7](https://github.com/ggml-org/whisper.cpp/tree/48f628a84833905ee4a0658ee6d4a5c915ce1997). Skrypt buduje statyczny `whisper-cli` z CPU/Accelerate, dwoma zadaniami kompilacji, bez Metal, CUDA i pobierania audio. Model pochodzi z [repozytorium modeli wskazanego przez whisper.cpp](https://huggingface.co/ggerganov/whisper.cpp/tree/5359861c739e955e79d9a303bcbc70fb988958b1). Pobierany plik `ggml-base.bin` ma 147 951 465 bajtów i SHA-256 `60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe`; instalator odrzuca inny plik. Metadane kompilacji i suma pliku wykonywalnego pozostają w `runtime.json`.

Domyślnie serwis szuka `voice/bin/whisper-cli` i `voice/ggml-base.bin` w katalogu danych aplikacji. Ustaw `JARVIS_VOICE_DIR` na ten prywatny katalog, jeśli uruchamiasz JARVIS z innego katalogu danych lub worktree. Bez plików silnika status jest jawnie niedostępny. Nie ma przełączenia na usługę chmurową. `.data/` jest ignorowane przez Git; model i pliki kompilacji nie należą do repozytorium kodu ani backupu danych biznesowych.

## Przepływ i limity

Przeglądarka rejestruje mikrofon po zgodzie użytkownika, konwertuje WebAudio na mono PCM WAV 16 kHz / 16 bitów i wysyła `{audio: base64, mimeType: "audio/wav"}` do autoryzowanego lokalnego endpointu JARVIS. Limit wynosi 30 sekund, 2 MiB po dekodowaniu, minimum 250 ms. Serwer waliduje cały kontener RIFF, pola formatu, rozmiary i długość; usuwa dodatkowe chunki przed przekazaniem WAV do programu. Nie akceptuje WebM, MP3 ani ścieżek plików od użytkownika.

Jednocześnie działa jedna transkrypcja. Kolejna otrzymuje `voice_busy`. Program jest uruchamiany bez powłoki, z ustalonymi argumentami, dwoma wątkami CPU i minimalnym środowiskiem bez tokenów dostawców lub proxy. Po 60 sekundach następuje zabicie procesu. Audio i wynikowy plik tekstowy są usuwane zarówno po sukcesie, jak i po błędzie/timeout; do klienta wraca wyłącznie tekst. Błędy silnika nie ujawniają surowego stderr.

Nagłe wyłączenie komputera lub SIGKILL może przerwać sprzątanie `voice-jobs/`. Katalog jest prywatny i wyłączony z backupu biznesowego. Po takim zatrzymaniu, przed ponownym użyciem, usuń pozostałe katalogi `job-*` dopiero po potwierdzeniu, że JARVIS i `whisper-cli` już nie działają. Normalne zamknięcie powinno poczekać na zakończenie aktywnego żądania.

Model `base` jest kompromisem dla lokalnego zużycia pamięci. Nazwy własne, liczby i cicha mowa wymagają sprawdzenia przez użytkownika. Test jednostkowy z fikcyjnym procesem potwierdza granice wejścia, izolację argumentów, limit równoległości, timeout i sprzątanie. Jakość rozpoznawania wymaga osobnego testu rzeczywistego silnika z nagraniem; instalacja modelu sama tego nie dowodzi.

Powtarzalny test rzeczywistego silnika na macOS: `npx tsx scripts/voice-smoke.ts /absolutna/sciezka/JARVIS/.data/voice`. Wykorzystuje lokalny polski głos Zosia, nie odtwarza dźwięku na głośnikach i usuwa pliki audio po sprawdzeniu. Raport `verification.json` w katalogu silnika zawiera rozpoznany tekst, datę i czas transkrypcji. Test z 8 września 2026 rozpoznał dokładnie „Sprawdź zadania wymagające zgody.”; to próbka syntetyczna, nie walidacja mikrofonu przeglądarki lub wszystkich głosów użytkowników.

Odczyt odpowiedzi przez `speechSynthesis` może używać wyłącznie głosu z `localService === true`; przy braku lokalnego głosu UI powinien zgłosić niedostępność. Nie używaj przeglądarkowego `SpeechRecognition` jako zastępstwa lokalnej transkrypcji, ponieważ może przekazywać dźwięk do zewnętrznej usługi.
