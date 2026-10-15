# Weryfikacja rozbudowy panelu, 15.10.2026

## Potwierdzone lokalnie

- Testy glownego scrapera: PASS, wlacznie z testami publikacji, zrodel,
  shardow, checkpointow, tozsamosci lokalizacji i bramki jakosci.
- Eksport Excel: PASS, stare zestawy oraz 60 testow polityki/struktury XLSX
  i 6 testow nowych minimow zakresowych.
- Panel: 124/124 testy w koncowym pelnym przebiegu, w tym cztery regresje
  wyscigu pollingu podgladu. Adapter podgladu i workflow: 28/28.
- Zgodnosc JS/Python: 1200 przypadkow nowej macierzy i 1350 przypadkow
  dotychczasowych minimow. To nie jest gwarancja przyszlej pozycji na rynku.
- UI: edycja, zapis, odtworzenie, konflikt dwoch kart, ochrona przed utrata
  szkicu, historia, rollback jako szkic, widok zrodel i rozne tryby zrodla.
- Widoki 320/390/768/1440 px bez poziomego przepelnienia. Edytor i podglad
  maja osobne zrzuty desktop/mobile; podglad mobile jest sprawdzany przy 390 px.
- Worker: 22 testy autoryzacji i zapisu oraz rzeczywisty lokalny runtime.
  Brak konfiguracji blokuje wszystkie zasoby i endpointy.
- SQLite Durable Object: rownolegly zapis daje sukces i konflikt, wersja
  przetrwala restart, odrebne przestrzenie sa izolowane.
- Build i `wrangler deploy --dry-run`: PASS, bez publikacji.
- `npm audit --omit=dev`: 0 znanych podatnosci.
- Baza, manifest, aktualne wartosci zasad, narzuty, mapowanie i istniejace
  harmonogramy pozostaly bez zmian. SHA-256 bazy:
  `3761c9d06fa9c7fb84d51726cbbe06b02c1e179c0da6c1c1ab545c39386965a2`.

## Przeglady

Niezalezny przeglad backendu wykryl i doprowadzil do poprawek: ujawnianie
adresow w konfiguracji, utrata audytu przy utracie odpowiedzi GitHub, hash
modelu zalezy od zapisanego ksztaltu, nadpisywanie nowszego podgladu, przerwany
lokalny job po restarcie i mylna rewizja publikacji po innym commicie.
Nowe testy najpierw odtworzyly te problemy.

Osobny przeglad UI wykonany przez dostepnego niezaleznego reviewera zamiast
niedostepnej dedykowanej roli Impeccable. Poprawiono etykiete trybu GitHub,
jawny wymog dat w nowej macierzy i zrzut mobilny podgladu.
Detector zglosil tylko Inter; zachowano font istniejacego systemu, bez redesignu.

## Ograniczenia

- Lokalny plikowy magazyn obsluguje jeden proces aplikacji. Produkcyjna
  wspolpraca korzysta z jednego Durable Object, nie z udzialu plikowego.
- Podglad korzysta z dostepnych zapisanych dowodow. Nieudokumentowane decyzje
  rynkowe pozostaja zamrozone; zakres ponownego przeliczenia jest jawny.
- Testy lokalne nie zastepuja testu GitHub App i wdrozonego workflow.
- Nie wykonano pusha, wdrozenia tej wersji, nowych uprawnien, wysylki Telegram
  ani nowego scrapera. Publikacja pozostaje wylaczona do zatwierdzonej aktywacji.
- Nie wykonano prawdziwego zatwierdzenia testowej zmiany cen na main.
- Brak pelnego testu czytnika ekranu oraz rzeczywistej tozsamosci obcej osoby.

## Proba na rzeczywistym raporcie

Podglad na opublikowanym `latest-full`, run `38653105190`, zakonczyl sie
poprawnie w 6,4 minuty bez nowego scrapowania. Testowa zmiana minimum miasta
60 -> 61 PLN dala 8238 zmienionych komorek; oba tymczasowe eksporty mialy
24901 wierszy. Odtworzono 2191 decyzji z zapisanych dowodow DOM; pozostale
12434 zachowano z raportu, z jawnym opisem tego ograniczenia. To roznica
miedzy dwoma przeliczeniami, nie import cen do DiscoverCars.

Lokalny wynik ma `testsSucceeded:false` i nie uprawnia do publikacji.
Plik bazowy i dokumenty zasad nie zostaly zmienione przez te probe.

## Dotychczasowy hosting

Wczesniejsza wersja tylko do podgladu byla wdrozona pod
`https://discovercars-rules-panel.bartek-prejs.workers.dev`, wersja
`5e85b452-76c9-496f-ab6b-aecc46cafb06`. Ta rozbudowa nie zostala tam jeszcze
wdrozona. Istniejaca ochrona Cloudflare Access nie zostala zmieniona.

Wymagane kolejne kroki zawiera `ACTIVATION.md`.
