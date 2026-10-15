# Aktywacja panelu

Kod lokalny nie oznacza wlaczenia zapisu na dzialajacym panelu. Przed ponizszymi
krokami potrzebna jest zgoda wlasciciela na wskazane repozytorium i Worker.
Nie zmieniac innych aplikacji, DNS, kont firmowych ani platnosci.

## Dokladny zakres

- Repozytorium: `prejsik/discovercars-tool`, galaz `main`.
- Worker: `discovercars-rules-panel`, konto wskazane w `wrangler.jsonc`.
- Prywatny Durable Object: binding `RULES_WORKSPACE`, klasa `RulesWorkspace`.
- GitHub App: instalacja tylko dla tego repozytorium, Contents write oraz
  Actions write; bez uprawnienia modyfikacji workflow przez panel.
- Workflow testowy: `rules-panel-preview.yml`, uruchamiany recznie przez panel.
  Zaden nowy harmonogram ani scraper nie jest uruchamiany podczas aktywacji.

## Kroki po zatwierdzeniu

1. Wypchnac sprawdzony kod na main. Zweryfikowac ten sam commit na GitHub.
2. Wlasciciel zaklada/autoryzuje GitHub App i instalacje dla jednego repo.
   Nie prosic o wklejanie kluczy prywatnych do rozmowy.
3. Przekazac przez bezpieczne narzedzie sekretow Cloudflare:
   `GITHUB_APP_ID`, `GITHUB_INSTALLATION_ID`, `GITHUB_APP_PRIVATE_KEY`,
   `PANEL_PREVIEW_KEY` i `ACCESS_EMAILS`. Klucz App musi byc RSA PKCS8.
   `PANEL_PREVIEW_KEY` to losowe 32 bajty zakodowane base64, ten sam sekret
   zapisany w GitHub Actions. Nie drukowac sekretow ani nie zapisywac ich w Git.
4. Zachowac istniejacy Access: dokladnie zatwierdzone adresy, caly hostname,
   bez publicznych wyjatkow. Przed deploy sprawdzic, ze `ACCESS_EMAILS` zostal
   ustawiony jako sekret: przeniesiono go z jawnych vars. Brak blokuje panel.
   Przy migracji istniejacej zmiennej o tej samej nazwie uzyc atomowego
   `wrangler deploy --secrets-file .local/deployment-access.json`, nie
   `secret bulk`: stary binding zmiennej koliduje wtedy z nowym sekretem.
5. Wdrozyc Worker z migracja `rules-workspace-v1` i poczatkowo
   `PANEL_WRITES_ENABLED=false`. Zweryfikowac anonimowy brak dostepu i poprawne
   logowanie; nie logowac sie jako inna osoba bez jej udzialu.
6. Po sprawdzeniu konfiguracji ustawic `PANEL_WRITES_ENABLED=true` i wdrozyc.
   Zweryfikowac odczyt rzeczywistego HEAD, bazy oraz raportu. Test zapisu szkicu
   i testowy workflow wymagaja zgody na te konkretne operacje.
7. Nie zatwierdzac fikcyjnej zmiany cen dla testu produkcyjnego. Pierwsza
   rzeczywista zmiana wymaga decyzji dyrektora, podgladu i jego zatwierdzenia.

## Wylaczenie zapisu

Ustawienie `PANEL_WRITES_ENABLED=false` blokuje endpointy zapisu i pozostawia
zabezpieczony podglad. Nie usuwa prywatnych danych. Cofniecie reguly przez
historie jest nowa propozycja wymagajaca testu, nie resetem repozytorium.

## Stan aktywacji 15.10.2026

- Kod panelu wypchniety na main: `120239721d31c3e338abc2e467ec9c95e0580bf3`.
- Worker wdrozony: `9dee67f4-56c1-49fa-bd80-6b2b366a1899`.
- Migracja prywatnego magazynu wdrozona; integracja zapisu wlaczona.
- `ACCESS_EMAILS` jest sekretem. Zalogowana sesja odczytuje nowy panel;
  anonimowy dostep do strony, API i snapshotu przekierowuje do Access.
- GitHub App `5331512`, instalacja `171740754`: potwierdzono dostep tylko do
  `prejsik/discovercars-tool`, Contents/Actions write oraz Metadata read.
- Klucz App przechowywany w sekretach Workera, PANEL_PREVIEW_KEY w sekretach
  Workera i GitHub Actions. Nie zapisano sekretow w repozytorium.
- Potwierdzono odczyt main w panelu po zalogowaniu; 127 testow panelu przechodzi.
  Naprawiono wywolanie fetch z nieprawidlowym receiverem w Workers.
- Status opublikowanych raportow jest niedostepny i UI pokazuje ostrzezenie.
  Nie wykonano produkcyjnego testu zapisu szkicu, workflow podgladu ani publikacji
  cen. Nie zmieniono zasad, stawek, bazy ani harmonogramow.

## Publikacja bez przeliczenia wplywu

Na zyczenie uzytkownika publikacja nie wymaga przeliczenia raportu ani testowego
workflow. Serwer sprawdza aktualnosc szkicu, hash modelu, poprawna strukture zasad,
wersje konfiguracji i bazy oraz uprawnienia. Zapis main pozostaje fast-forward,
z prywatnym audytem i obsluga ponowienia po utracie odpowiedzi.
Panel pokazuje liste zmian i przycisk Opublikuj. Przeliczenie wplywu nie jest
czescia interfejsu zatwierdzania. Testy: 127/127 i simple-ui (publikacja bez
preview, anulowanie potwierdzenia, jeden zapis po potwierdzeniu).

## Podmiana pliku bazowego

Zakladka Plik bazowy: wybor XLSX, kontrola serwerowa i osobne zatwierdzenie.
Kontrola czyta wszystkie wiersze Sheet1 niezaleznie od filtrow i ukrycia,
sprawdza naglowki A-N, szesc przedzialow, daty, dodatnie stawki, klasy i stacje.
Porownanie z obecna baza chroni przed utrata istniejacych par klasa/lokalizacja.
Nie narzuca limitu liczby wierszy; limit przesylki 8 MB chroni zasoby panelu.
Zapis atomowo aktualizuje tylko kanoniczny XLSX i input/baseline-manifest.json.
Bajty XLSX pozostaja niezmienione. Konflikt main blokuje podmiane. Checkbox
importu to deklaracja uzytkownika, a nie automatyczne potwierdzenie brokera.
Oba harmonogramy korzystaja z tej wspolnej bazy po zatwierdzeniu.
Test na wdrozonym panelu: walidacja istniejacej bazy (24877 wierszy, 11 klas,
26 lokalizacji), bez zatwierdzania podmiany. Kontrola zapisu na GitHub jest
testowana na atrapach API; nie wykonywano fikcyjnej produkcyjnej podmiany.
Po dodatkowym przegladzie dopisano kontrole typow czesci XLSX i brakujacych
powiazan, zgodnosci formatow dat i adresow komorek oraz zmiany potwierdzenia
importu przy ponownym wgraniu identycznego pliku. Wynik: 145/145 testow panelu
oraz pelny zestaw testow interfejsu na desktopie i telefonie.

## Ostatnie wyniki i Telegram

Zakladka Ostatnie wyniki pokazuje ostatni opublikowany raport oraz ostatni Excel
oddzielnie. Dane obu zestawow moga pochodzic z roznych uruchomien, co jest jawnie
oznaczone. Stan kolejki i bledy pochodza z GitHub Actions, pomiete proby cron
nie sa traktowane jako wykonany scraper.
Pobrania XLSX sa chronione Access i przypiete do run_id oraz SHA256 manifestu.
HTML jest przypiety do uruchomienia i otwierany w izolowanej stronie; filtry
uzywaja fragmentu adresu, zachowujac identyfikator raportu.
Nowe manifesty zawieraja statystyki zmian i digesty raportu/podsumowania. Dla
starszych raportow dane pochodza z uwierzytelnionych artefaktow danego runa,
z weryfikacja zgodnosci bazy i digestow obu Exceli. Nie laczyc podsumowania
wylacznie po hashu bazy, poniewaz kolejne uruchomienia moga uzywac tej samej bazy.
Ustawienie importu jako bazy wymaga deklaracji wykonania importu, kontroli XLSX
i osobnego potwierdzenia. Pobranie pliku lub odczyt raportu nie zmienia bazy.
Kolejne wiadomosci Telegram zawieraja link do panelu z ?view=results.
