# P09a — dokumenty wymagane przez onboarding

Punkt startu: lokalnie odebrane P08a2, `389f6b30e98f3154c32fb46959228ceb625ed87e`. Dokument wizji i pełna [roadmapa](roadmap.md) pozostają zakresem produktu.

## P09a1 — źródła i zaakceptowana rewizja

Źródło `case_scope` obejmie uzgodniony zakres, termin, osobę, okres współpracy i definicje wymagań. Nie obejmie zmiennego statusu zadań, dowodów ani odbioru. Plan przypina numer rewizji i SHA-256 tego kontraktu. Zapis niezależnie odczytuje dane; zmiana zakresu unieważnia propozycję, a powiązanie dowodu lub ukończenie zadania zachowuje aktualność źródła. Stara karta całego rekordu nadal ma dawną semantykę i nie jest automatycznie konwertowana.

Każda nowa rewizja dokumentu zapisze własną treść, klasyfikację, powiązania, źródła i ich sumy kontrolne oraz autora. Zgoda na zapis i biznesowa akceptacja wersji pozostają osobnymi decyzjami, z osobnymi autorami. Rewizja może jawnie odświeżyć źródła; domyślnie zachowuje historyczne referencje. Zmiana nazwy również wymaga rewizji. Odczyt kontroli dokumentu pokaże braki, nieaktualne źródła i status akceptacji. Zmienne źródło, niespójna treść lub kontekst blokują przekazanie i akceptację. Historyczne dane nie otrzymają dopisanych autorów ani źródeł.

Szablon uzgodnionego zakresu tworzy raport. Nie tworzy umowy ani nie zastępuje dostarczenia jej właściwej treści. Dokument onboardingu musi wskazywać dokładną sprawę i rewizję dla właściwej współpracy. Brak tego powiązania blokuje dowód gotowości.

Odbiór P09a1: dwie firmy i równoległe współprace; przygotowanie, zgoda, odrębna akceptacja, powiązanie; zmiana zakresu przed zgodą i po odbiorze; odmowa i anulowanie; utrata uprawnień; jawne odświeżenie; uszkodzenie kontekstu i rollback; restart/SIGKILL z osobnym magazynem domenowym. Po zielonym CI: scalona lokalna instalacja, rzeczywisty Chrome, backup/restore i działający stos OSS.

## P09a2 — pliki i praktyczny materiał odbiorowy

Lokalne źródła plikowe otrzymają typ, rozmiar, manifest, SHA-256 oraz kontrolę uprawnień przy każdym odczycie. Właściwe szablony użytkowe uzyskają czytelny eksport z bibliotek OSS oraz kontrolę wizualną. Treści dokumentów i plików nie mogą sterować wykonaniem narzędzi ani trafiać do modelu bez jawnego kontraktu minimalizacji.

P09a1 jest fundamentem tej zależności. P09a/P06 pozostają otwarte do odebrania rzeczywistych dokumentów, plików oraz całego onboardingu; raport zakresu, notatka i same statusy zadań nie wystarczają.

### Kontrakt pliku i eksportu P09a2

Wybrany plik stanowi prywatny, trwały materiał wejściowy przygotowywanego planu. Upload nie dodaje jeszcze załącznika biznesowego. Plan ujawnia nazwę, rozmiar, typ i odcisk pliku oraz konkretną wersję dokumentu. Zapis po zgodzie tworzy nową rewizję z niezmiennym manifestem; stara akceptacja nie przechodzi na zmieniony dokument. Usunięcie powiązania również tworzy rewizję i zachowuje historyczny plik. Kontrola źródeł, akceptacja, pobranie i pakiet sprawy sprawdzają zawartość względem manifestu. Można jawnie wymagać pliku w warunku odbioru dokumentu.

Pliki i oczekujące materiały znajdują się tylko w prywatnym `attachments/` JARVIS i wchodzą do standardowej kopii. Odczyt wymaga dostępu do dokumentu, także jego historycznych obszarów. Limity obejmują wielkość pliku, liczbę załączników i przygotowanych uploadów. Żadna nazwa użytkowa nie jest ścieżką serwera. Zawartość nie jest wykonywana, pobierana z URL ani przekazywana do modelu lub telemetrii. Kontrola formatu nie jest deklaracją skanowania antywirusowego.

Publikacja bajtów poprzedza transakcję rewizji. Brak transakcyjnego receipt oznacza brak przypisania biznesowego; ewentualny osierocony, identyczny plik można uzgodnić przy ponowieniu. Receipt i manifest chronią przed podmianą. Schemat operations 10 blokuje użycie starszego kodu, który nie zna plikowych warunków akceptacji; historyczne rewizje pozostają bez dopisanych danych.

Eksporty DOCX i PDF korzystają z [docx](https://docx.js.org/) i [PDFKit](https://pdfkit.org/docs/text.html). Powstają lokalnie, z przypiętej treści i czytelnego rejestru źródeł/załączników, z osadzoną polską czcionką w PDF. Wynik nie zawiera aktywnych instrukcji, automatycznie pobieranych obrazów ani makr. Układ i polskie znaki wymagają odbioru wyrenderowanych stron. Pliki wejściowe zachowują oryginalną treść.
