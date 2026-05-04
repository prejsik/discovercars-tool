# DiscoverCars Weekend Cheapest Offers CLI

Narzadzie CLI w Node.js + Playwright, ktore automatycznie:

- oblicza dynamicznie zakresy dat w strefie `Europe/Warsaw`:
  - domyslnie: start najmu od jutra, a potem kazdego kolejnego dnia przez 30 dni,
  - dla kazdego startu: domyslnie wynajem na 2..10 dni, z opcja wyboru do 20 dni,
- szuka ofert na `https://www.discovercars.com/` dla lokalizacji `Warsaw`, `Krakow`, `Gdansk`, `Katowice`, `Wroclaw`, `Poznan`,
- priorytetowo wyciaga oferty z odpowiedzi sieciowych JSON/API (backend DiscoverCars),
- ma fallback do parsowania DOM, jesli payloady sieciowe nie zawieraja kompletnych danych,
- ma dodatkowy fallback awaryjny do stabilnego flow Playwright (legacy scraper), jesli direct API flow nie zwroci ofert,
- ma automatyczny fallback per scenariusz: jesli strategia direct nie zwroci kompletu ofert, brakujace lokalizacje sa dociagane przez stabilny legacy fallback,
- ma checkpoint resume (`output/state.json`) - po przerwaniu wznawia od brakujacych scenariuszy,
- ma automatyczny dobor wydajnosci (`scenario-concurrency`, `location-concurrency`, `timeout`) na podstawie skali uruchomienia,
- ma przelaczalne profile szybkosci: `safe`, `fast`, `turbo`,
- zwraca najtansza oferte per lokalizacja oraz najtansza oferte ogolem.
- zwraca top 3 najtansze firmy per lokalizacja.
- pokazuje cene dla firmy `MM Cars Rental` per lokalizacja (jesli wystepuje).
- pokazuje ocene firmy przy nazwie firmy, np. `MM Cars Rental (8.8)`, jesli DiscoverCars zwroci rating.
- obsluguje wiele opcji dat: domyslny tryb rolling i opcjonalny tryb weekday (czwartek/piatek).
- w trybie konsolowym pokazuje jedna krotka tabele na scenariusz (Top1/Top2/Top3 + `MM Cars Rental`).

## Struktura projektu

- `package.json`
- `src/index.js`
- `src/dateUtils.js`
- `src/discoverCars.js`
- `src/extractors.js`
- `src/formatters.js`

## Wymagania

- Node.js 18+ (testowane na Node 22)
- zainstalowany Chromium dla Playwright

## Instalacja

```powershell
cd C:\Users\barte\OneDrive\Codex
npm install
npx playwright install chromium
```

## Uruchomienie

Podstawowe uruchomienie (rolling, jutro + 30 dni, domyslnie 2..10 dni):

```powershell
node src/index.js
```

## Automatyczne uruchamianie w GitHub Actions

Workflow znajduje sie w `.github/workflows/discovercars-daily.yml`.

Jak dziala:

- uruchamia scraper codziennie o `17:00` czasu `Europe/Warsaw`,
- GitHub cron dziala w UTC, dlatego workflow ma dwa triggery (`15:00` i `16:00 UTC`) oraz bramke, ktora realnie puszcza scraper tylko wtedy, gdy w Warszawie jest `17:00`,
- ma tez reczny przycisk `Run workflow`, zeby przetestowac dzialanie bez czekania do 17:00,
- uruchamia maly test smoke po pushu zmian w workflow, `src/` albo `package*.json`,
- wynik zapisuje jako artifact GitHub Actions: `report.html`, `results-latest.json`, `run-log.txt`, opcjonalnie `state.json`.

Domyslny zakres w chmurze:

- `locations`: `Warsaw,Krakow,Gdansk,Katowice,Wroclaw,Poznan`
- `rolling_days`: `1` (tylko jutro jako start date)
- `durations`: `2,3,4,5,6,7,8,9,10`
- `speed_mode`: `fast`

Jak przetestowac recznie:

1. Wejdz w repozytorium na GitHub.
2. Otworz zakladke `Actions`.
3. Wybierz workflow `DiscoverCars daily run`.
4. Kliknij `Run workflow`.
5. Zostaw domyslne parametry na pierwszy test.
6. Po zakonczeniu wejdz w zakonczony run i pobierz artifact `discovercars-results-...`.
7. Rozpakuj artifact ZIP i otworz `report.html` w przegladarce, zeby zobaczyc kolorowe tabele.

Pliki w artifact:

- `report.html` - najlepszy do ogladania wynikow, ma kolorowe tabele jak lokalna konsola,
- `results-latest.json` - dane techniczne do dalszego przetwarzania,
- `run-log.txt` - surowy log z uruchomienia,
- `state.json` - checkpoint, jesli zostal utworzony.

Lokalne wygenerowanie HTML z JSON:

```powershell
node src/reportHtml.js output/results-latest.json output/report.html
```

Potem otworz plik `output/report.html` w przegladarce.

Tryb z widoczna przegladarka (headful):

```powershell
node src/index.js --headful
```

Tylko JSON (bez tabeli i podsumowania):

```powershell
node src/index.js --json
```

Zapis do pliku `results.json`:

```powershell
node src/index.js --save
```

Zapis do wlasnej sciezki:

```powershell
node src/index.js --save=output/results.json
```

Wlasna lista lokalizacji:

```powershell
node src/index.js --locations=Warsaw,Krakow
```

Przyklad rolling z jawna konfiguracja:

```powershell
node src/index.js --scenario-mode=rolling --rolling-days=30 --durations=2,3,4,5,6,7,8,9,10
```

Tryb weekday (kompatybilny ze starym sposobem):

```powershell
node src/index.js --scenario-mode=weekday --start-day=both --durations=2,3
```

Tryb z konkretnymi datami startu (multi start-date):

```powershell
node src/index.js --start-dates=2026-05-01,2026-05-03,2026-05-10 --durations=2,3
```

Skrot weekday do wszystkich opcji dat:

```powershell
node src/index.js --all-date-options
```

Tylko krotkie tabele + okres (bez logow technicznych, domyslnie):

```powershell
node src/index.js
```

Logi diagnostyczne (wolniejsze i bardziej gadatliwe):

```powershell
node src/index.js --verbose --strategy=hybrid
```

Szybszy profil do testow wydajnosci:

```powershell
node src/index.js --speed-mode=fast
```

Powrot do poprzedniego stabilnego profilu:

```powershell
node src/index.js --speed-mode=safe
```

Tryb bardzo agresywny, tylko do porownania:

```powershell
node src/index.js --speed-mode=turbo
```

Checkpoint resume (domyslnie wlaczone):

```powershell
node src/index.js --resume
```

Uruchomienie bez resume:

```powershell
node src/index.js --no-resume
```

Reset checkpointu:

```powershell
node src/index.js --reset-state
```

## Udostepnienie narzedzia innej osobie

Najprostsza opcja (Windows, bez budowy exe):

1. Spakuj caly folder projektu (`Codex`) do `.zip` i przeslij.
2. Odbiorca rozpakowuje i uruchamia:

```powershell
cd <sciezka_do_rozpakowanego_projektu>
.\install.ps1
.\run-tables.ps1
```

Rekomendacja praktyczna: ustaw domyslnie `--strategy=legacy-batch` (szybciej i stabilniej), a `--strategy=hybrid` tylko do debugu.

W launcherze `start.bat` osoba wybiera tez `Speed mode`:

- `fast` - domyslny test szybszego dzialania,
- `safe` - powrot do poprzedniego stabilnego zachowania,
- `turbo` - najmocniejsze przyspieszenie, ale wieksze ryzyko braku wynikow przy wolnej stronie.

Rollback lokalny po zmianach wydajnosci:

- backup poprzedniej wersji jest w `backups\before-speed-changes-20260503-152352.zip`,
- aby wrocic do starej wersji, rozpakuj ten ZIP do folderu projektu i nadpisz pliki.

## Wydajnosc

Domyslnie CLI dziala w stabilnym profilu `safe`, czyli zachowuje poprzednie sprawdzone timingi.
Launcher `start.bat` domyslnie proponuje `fast`, aby latwo porownac szybsze dzialanie bez wpisywania komend.

Profile:

- `safe` - poprzedni stabilny profil, najlepszy do rollbacku funkcjonalnego,
- `fast` - blokuje obrazki/fonty/media, pomija niepotrzebne wejscie na homepage przed direct search, skroca wait'y i zwieksza rownoleglosc,
- `turbo` - jeszcze krotsze wait'y i wieksza rownoleglosc, do testow na szybkim laczu/komputerze.

Auto-tuning:

- `scenario-concurrency` dobierane automatycznie do liczby scenariuszy i CPU,
- `location-concurrency` dobierane automatycznie do skali uruchomienia,
- `timeout` dobierany automatycznie do ciezkosci batcha.
- w trybach `fast`/`turbo` `max-pages` ogranicza liczbe jednoczesnych stron przegladarki, zeby komputer nie zostal zapchany.

Wymuszenie wartosci recznie:

```powershell
node src/index.js --scenario-concurrency=3 --location-concurrency=2 --timeout=50000
```

Powrot do trybu automatycznego:

```powershell
node src/index.js --scenario-concurrency=auto --location-concurrency=auto --timeout=auto
```

Ograniczenie liczby aktywnych stron Playwright:

```powershell
node src/index.js --speed-mode=fast --max-pages=6
```

Dlaczego teraz jest szybciej:

- jeden przebieg przegladarki na scenariusz (zamiast wielu uruchomien per miasto),
- w trybie `fast`/`turbo` brak wejscia na homepage przed direct search,
- w trybie `fast`/`turbo` blokada obrazkow, fontow i mediow,
- w trybie `fast`/`turbo` krotsze, nadal kontrolowane czekanie na wyniki,
- brak logow debugowych w standardowym uruchomieniu.

Aby przyspieszyc jeszcze bardziej:

- uzywaj mniejszej listy miast przez `--locations=`,
- uruchamiaj mniejszy zakres dat, np. `--rolling-days=7`,
- uruchamiaj mniej czasow trwania, np. `--durations=2,3,4`,
- nie wlaczaj `--verbose`, jesli nie diagnozujesz problemu.
- zwieksz rownolegle scenariusze: `--scenario-concurrency=2` (lub `3`),
- zwieksz rownolegle miasta per scenariusz: `--location-concurrency=2` (lub `3`),
- ogranicz direct-flow probe: `--direct-candidate-limit=2 --direct-offers-wait=6000`.

Przyklad szybki (z zachowaniem tych samych tabel):

```powershell
node src/index.js --scenario-mode=rolling --rolling-days=30 --durations=2,3,4,5,6,7,8,9,10 --locations=Warsaw,Krakow,Gdansk,Katowice,Wroclaw,Poznan --strategy=legacy-batch --retries=1 --scenario-concurrency=auto --location-concurrency=auto --timeout=auto --direct-candidate-limit=2 --direct-offers-wait=6000
```

Ten sam zakres w szybkim profilu:

```powershell
node src/index.js --scenario-mode=rolling --rolling-days=30 --durations=2,3,4,5,6,7,8,9,10 --locations=Warsaw,Krakow,Gdansk,Katowice,Wroclaw,Poznan --strategy=legacy-batch --speed-mode=fast
```

## Co zwraca skrypt

1. Tabele w konsoli (`console.table`) z wynikami sukcesow.
2. JSON na stdout z polami:
   - `results` (posortowane rosnaco po `total_price`)
   - `errors` (blad per lokalizacja, jesli wystapi)
   - `cheapest_by_location`
   - `cheapest_overall`
   - `top_3_by_location`
   - `mm_cars_rental_by_location`
   - `top_3_plus_mm_by_location`
   - przy wielu scenariuszach: `scenarios` (lista wynikow per scenariusz dat)
   - dane zakresu dat (`pickup_date`, `dropoff_date`, `rental_days`, `time_zone`)
3. Opcjonalny zapis JSON do pliku przez `--save`.

W trybie konsolowym:

- dla kazdego scenariusza dat jest wyswietlana jedna tabela,
- nad tabela jest informacja o okresie (`pickup -> dropoff`),
- ocena firmy jest pokazywana obok nazwy firmy w kolumnach `top*_company`,
- `MM Cars Rental` jest podswietlane kolorem w kolumnach `top*_company` i `mm_cars_rental_price`.
- `MM Cars Rental` ma inne, niebieskie podswietlenie, gdy jest drozsze maksymalnie o `10 PLN` na dobe od konkurenta na wyzszym miejscu.

Kazdy rekord sukcesu zawiera:

- `location`
- `provider_name`
- `provider_rating` (number lub `null`, jesli rating nie jest dostepny)
- `total_price` (number)
- `currency`
- `pickup_date`
- `dropoff_date`
- `rental_days`
- `car_name` (lub klasa auta, jesli tylko to bylo dostepne)
- `source_url`

## Zasady dat

Daty sa liczone dynamicznie (bez hardcode):

- strefa: `Europe/Warsaw`
- domyslnie:
  - pierwszy `pickup`: jutro o `10:00`,
  - kolejne pickupy: kazdego nastepnego dnia przez 30 dni,
  - `rental_days`: domyslnie 2..10 dla kazdego startu, opcjonalnie do 20 dni
- opcjonalnie (tryb weekday): start wg dnia tygodnia (`--scenario-mode=weekday --start-day=...`)
- `rental_days` jest liczone na podstawie roznicy dat

## Ograniczenia

- DiscoverCars to dynamiczna aplikacja webowa; selektory i payloady API moga sie zmieniac.
- Czasem oferty sa ladowane etapami lub czesciowo zaszyfrowane/minifikowane.
- Czesc cen moze zalezec od geolokalizacji, ciasteczek, A/B testow i aktualnego ruchu.
- Ustawienie waluty `PLN` i kraju rezydencji `Poland` jest realizowane "best effort" (UI moze wygladac inaczej zaleznie od wersji strony).

## Co dostroic, jesli UI sie zmieni

Najczesciej wymagajace korekty miejsca:

- mapowanie lokalizacji z autocomplete (`resolveLocationCandidates`)
- budowanie linku direct search (`buildDirectSearchUrl`)
- ekstrakcja odpowiedzi sieciowych (`tryExtractOffersFromResponse`)
- fallbacki ekstrakcji (`extractOffersFromDom`, `extractOffersFromPageScripts`)
- sygnaly gotowosci strony wynikow i cookies (`waitForResults`, `acceptCookies`)
- mapowanie pol w JSON-ach (`src/extractors.js`, stale `*_PATHS`)

Praktyczny debug:

```powershell
node src/index.js --headful --save
```

W przypadku bledu per lokalizacja skrypt zapisuje artefakty (`.png`, `.html`) w `artifacts/discovercars/`.

## Paczka Release (gotowa do wysylki)

Budowanie paczki release:

```powershell
npm run build:release
```

Po tej komendzie dostaniesz:

- folder: `release\discovercars-tool`
- ZIP: `release\discovercars-tool.zip`

To jest paczka z samymi potrzebnymi plikami + launcher (`setup.bat`, `start.bat`) dla osoby nietechnicznej.

## Wersja bez wpisywania komend (dla osoby trzeciej)

Masz gotowe 2 pliki do uruchamiania "double click":

- `setup.bat` - instalacja zaleznosci (jednorazowo),
- `start.bat` - uruchomienie narzedzia przez okno wyboru.

Jak to dziala:

1. Osoba uruchamia `setup.bat` (raz).
2. Potem uruchamia `start.bat`.
3. Pojawi sie okno z wyboru:
   - **dlugosci wynajmu**,
   - **dat startu** przez zakres `From-To` albo konkretne daty wpisane naraz,
   - **trybu szybkosci**.
4. Dla dlugosci:
   - domyslnie zaznaczona jest opcja `2-10 (all)`,
   - opcja `2-20 (all)`,
   - opcja `2-10 (all)`,
   - oraz pojedyncze opcje `2` ... `20`,
   - mozna zaznaczyc kilka naraz.
5. Dla start-date:
   - domyslnie wybierasz zakres `From` i `To`, a narzedzie samo tworzy wszystkie daty z tego przedzialu,
   - alternatywnie zaznaczasz `Specific dates` i klikasz konkretne dni w kalendarzu,
   - ponowne klikniecie tej samej daty usuwa ja z wyboru,
   - nadal mozesz tez wkleic wiele dat naraz, np. `2026-05-05, 2026-05-07, 2026-05-10`,
   - nie trzeba klikac `Add date` dla kazdej pojedynczej daty.
6. Po kliknieciu `Run` narzedzie uruchamia sie automatycznie i pokazuje tabele.

Uwagi:

- UI pyta o dwa parametry: durations i start-dates.
- Pozostale parametry sa stale:
  - przekazuje wybrane daty przez `--start-dates=...`,
  - miasta: `Warsaw,Krakow,Gdansk,Katowice,Wroclaw,Poznan`.
