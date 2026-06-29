# DiscoverCars Weekend Cheapest Offers CLI

Narzadzie CLI w Node.js + Playwright, ktore automatycznie:

- oblicza dynamicznie zakresy dat w strefie `Europe/Warsaw`:
  - domyslnie: start najmu od jutra, a potem kazdego kolejnego dnia przez 30 dni,
  - dla kazdego startu: domyslnie wynajem na 1..10 dni, z opcja wyboru do 20 dni,
- szuka ofert na `https://www.discovercars.com/` dla lokalizacji `Warsaw`, `Krakow`, `Gdansk`, `Katowice`, `Wroclaw`, `Poznan`, `Lodz`, `Bydgoszcz`, `Torun`,
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

Podstawowe uruchomienie (rolling, jutro + 30 dni, domyslnie 1..10 dni):

```powershell
node src/index.js
```

## Automatyczne uruchamianie w GitHub Actions

Workflow znajduje sie w `.github/workflows/discovercars-daily.yml`.

Jak dziala:

- uruchamia jeden pelny scraper codziennie z wyprzedzeniem, aby wynik byl gotowy okolo `07:00`; GitHub cron bywa opozniony, dlatego triggery sa ustawione poprzedniego wieczoru,
- GitHub cron dziala w UTC, dlatego workflow ma kilka wieczornych okien fallback oraz bramke, ktora realnie puszcza tylko pierwszy aktywny albo zakonczony sukcesem pelny run dla danej daty porannego raportu,
- nie uruchamia scraperow rownolegle; jesli GitHub opozni run, kolejny czeka w kolejce zamiast nakladac sie na poprzedni,
- `final-pricing-recommendations.json` pochodzi bezposrednio z aktualnego pelnego runa,
- ma tez reczny przycisk `Run workflow`, zeby przetestowac dzialanie bez czekania do porannego harmonogramu,
- uruchamia maly test smoke po pushu zmian w workflow, `src/`, `tools/`, `input/`, konfiguracji albo `package*.json`,
- wynik zapisuje jako artifact GitHub Actions: `report.html`, `results-latest.json`, `pricing-recommendations.json`, `final-pricing-recommendations.json`, `rates-import-ready.xlsx`, `rates-updated.xlsx`, `excel-rate-update-summary.json`, `mm-rate-sanity-check.json`, `quality-alerts.json`, `run-log.txt`, opcjonalnie `state.json`,
- publikuje GitHub Pages z linkami dla pelnego raportu i najnowszego Excela; test po pushu nie powinien nadpisywac glownego pelnego raportu.

Domyslny zakres w chmurze:

- `locations`: `Gdansk Downtown,Gdansk Airport (GDN),Katowice Downtown,Katowice Airport (KTW),Krakow Train Station,Krakow Airport (KRK),Poznan Downtown,Poznan Airport (POZ),Warsaw Train Station,Warsaw Chopin Airport (WAW),Wroclaw Downtown,Wroclaw Airport (WRO)`
- `rolling_days`: `30`
- `durations`: `1,2,3,4,5,6,7,8,9,10`
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
- `pricing-recommendations.json` - rekomendacje stawek wygenerowane bezposrednio z danego runa scrapera,
- `final-pricing-recommendations.json` - finalny zestaw rekomendacji do Excela z aktualnego runa,
- `rates-import-ready.xlsx` - gotowy plik importowy stawek, tylko `Sheet1`, ze wszystkimi rekomendowanymi zmianami zastosowanymi automatycznie,
- `rates-updated.xlsx` - pelny workbook kontrolny z `Sheet1`, `Changed Positions`, `Recommendations Review` i `Validation`,
- `excel-rate-update-summary.json` - podsumowanie zmian zastosowanych w workbooku,
- `mm-rate-sanity-check.json` - live sanity check kilku rekomendacji; porownuje aktualna cene MM Cars Rental ze strony z cena MM zapisana w rekomendacji,
- `quality-alerts.json` - alerty jakosciowe uzywane w Telegramie,
- `run-log.txt` - surowy log z uruchomienia,
- `state.json` - checkpoint, jesli zostal utworzony.

GitHub Pages:

Workflow potrafi opublikowac raporty jako strone statyczna. Domyslny adres dla tego repozytorium to:

```text
https://prejsik.github.io/discovercars-tool/
```

Stale linki:

- `https://prejsik.github.io/discovercars-tool/latest-full/report.html` - ostatni pelny raport,
- `https://prejsik.github.io/discovercars-tool/latest-excel/rates-import-ready.xlsx` - najnowszy Excel gotowy do importu,
- `https://prejsik.github.io/discovercars-tool/latest-excel/rates-updated.xlsx` - pelny raport Excel z arkuszami kontrolnymi.

Jesli Pages nie byly jeszcze wlaczone, wejdz w `Settings` -> `Pages` i ustaw `Build and deployment` -> `Source` na `GitHub Actions`. Po kolejnym udanym pelnym runie strona glowna pokaze pelny `report.html`.

Uwaga: GitHub Pages moze nie byc dostepne dla prywatnego repozytorium na niektorych planach GitHub. Wtedy workflow pominie publikacje Pages i zostawi link do artifactu jako backup.

Powiadomienie Telegram po zakonczeniu:

Workflow moze wyslac wiadomosc Telegram z typem runa, startem i koncem automatu, czasem scrapera, zakresem, liczba scenariuszy, liczba rekomendacji, liczba zmian w Excelu, informacja skad wzieto finalne rekomendacje, alertami jakosciowymi, linkiem do raportu danego runa, stalym linkiem `latest-full`, linkiem `latest-excel/rates-import-ready.xlsx` do pliku gotowego do importu, linkiem do pelnego raportu Excel, osobnym linkiem do artifactu Excela importowego, linkiem backupowym do artifactu i linkiem do runa GitHub Actions. Alerty jakosciowe obejmuja tez sanity check MM: kilka probek jest ponownie sprawdzanych live na DiscoverCars i roznica powyzej `10 PLN/dzien` trafia do Telegrama. Link GitHub Pages jest najwygodniejszy do codziennego ogladania raportu; linki do artifactow dzialaja dla osob zalogowanych do GitHuba z dostepem do repozytorium.

1. W Telegramie otworz `@BotFather`.
2. Utworz bota komenda `/newbot` i skopiuj token.
3. Napisz dowolna wiadomosc do nowego bota, np. `/start`.
4. Otworz w przegladarce:

```text
https://api.telegram.org/bot<TWOJ_TOKEN>/getUpdates
```

5. W odpowiedzi znajdz `message.chat.id` i skopiuj jego wartosc.
6. W repozytorium GitHub wejdz w `Settings` -> `Secrets and variables` -> `Actions`.
7. Dodaj sekrety:
   - `TELEGRAM_BOT_TOKEN` - token z `@BotFather`
   - `TELEGRAM_CHAT_ID` - wartosc `message.chat.id`

Jesli sekrety nie sa ustawione, workflow nie przerwie scrapera, tylko pominie powiadomienie Telegram.

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
node src/index.js --scenario-mode=rolling --rolling-days=30 --durations=1,2,3,4,5,6,7,8,9,10
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
node src/index.js --scenario-mode=rolling --rolling-days=30 --durations=1,2,3,4,5,6,7,8,9,10 --locations=Warsaw,Krakow,Gdansk,Katowice,Wroclaw,Poznan,Lodz,Bydgoszcz,Torun --strategy=legacy-batch --retries=1 --scenario-concurrency=auto --location-concurrency=auto --timeout=auto --direct-candidate-limit=2 --direct-offers-wait=6000
```

Ten sam zakres w szybkim profilu:

```powershell
node src/index.js --scenario-mode=rolling --rolling-days=30 --durations=1,2,3,4,5,6,7,8,9,10 --locations=Warsaw,Krakow,Gdansk,Katowice,Wroclaw,Poznan,Lodz,Bydgoszcz,Torun --strategy=legacy-batch --speed-mode=fast
```

Duzy manualny zakres, np. caly miesiac, najlepiej uruchamiac chunkami tygodniowymi. Kazdy chunk ma osobny checkpoint, a na koncu wyniki sa scalane do jednego standardowego `results-latest.json`, ktory dalej zasila raport, rekomendacje i Excel:

```powershell
npm run discovercars:chunked -- --month=2026-07 --durations=2,3,4,5,6,7,8,9,10,11,12,13,14 --output-dir=output\manual-july-2026-automatic --workbook="C:\path\to\rates.xlsx" --python="C:\path\to\python.exe"
```

Domyslnie runner dzieli daty co `7` dni, uruchamia maksymalnie `2` chunki rownolegle, uzywa standardowych 12 lokalizacji daily workflow, `legacy-batch`, `fast`, `retries=0`, `scenario-concurrency=2`, `location-concurrency=2` i po scaleniu zapisuje `report.html`, `pricing-recommendations.json`, `final-pricing-recommendations.json`, a jesli podano `--workbook`, takze `rates-updated.xlsx` oraz `rates-import-ready.xlsx`.

Daily workflow uzywa tego samego runnera z `--rolling-days`, `--chunk-days=7` i `--skip-postprocess`, zeby scraper tylko zebral i scalil `output/results-latest.json`; dalsze kroki workflow generuja standardowy raport, rekomendacje, Excel i sanity check.

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

## Rekomendacje cenowe i aktualizacja Excela

Po daily run workflow generuje dodatkowo:

- `pricing-recommendations.json` - rekomendacje zmian stawek MM Cars Rental per lokalizacja, data i duration.

Lokalnie mozna wygenerowac rekomendacje z ostatniego wyniku:

```powershell
node src/pricingRecommendations.js output/results-latest.json output/pricing-recommendations.json --config=pricing-rules.config.example.json
```

Updater Excela bierze rekomendacje, mapuje lokalizacje na strefy z pliku stawek i zapisuje nowy workbook z kolorami. Daily workflow robi to automatycznie na bazie `input/mm-cars-rental-rates-inclusive-fp.xlsx` i publikuje dwa pliki: `rates-import-ready.xlsx` jako plik gotowy do importu z samym `Sheet1` oraz `rates-updated.xlsx` jako pelny raport kontrolny. Glowny arkusz importowy rozwija pozycje na kazdy dzien od dnia uruchomienia do `2027-01-31`, zachowuje rozne grupy i strefy, pozycje bez zmian oraz formatowanie wierszy 1-4 w `Sheet1`; dodatkowy arkusz `Changed Positions` pokazuje tylko zmienione pozycje w pelnym raporcie.
Booking date jest ignorowany przy dopasowaniu rekomendacji. Dopasowanie odbywa sie po `Pickup start date`, a duration wybiera odpowiednia kolumne `I-N`; `Pickup end date` jest ustawiany na taka sama wartosc jak `Pickup start date`, a `Booking end date` zawsze dostaje taka sama wartosc jak `Pickup end date`.
Wymaga biblioteki Python `openpyxl` (`pip install openpyxl`), jesli nie jest jeszcze zainstalowana.

Mapowanie lokalizacji scrapera na kody importowe jest zapisane w `excel-rate-update.config.example.json` w `location_zones`. Dokladne lokalizacje sa preferowane przed ogolnym miastem, a ogolne aliasy typu `Warsaw` zostaja tylko dla wstecznej kompatybilnosci starszych runow.

| Kod importu | Lokalizacja w scraperze | Uwagi |
|---|---|---|
| BYLO | Bydgoszcz Airport (BZG) | placeID 5827 |
| GD1 | Gdansk Downtown | placeID 3451 |
| GDLO | Gdansk Airport (GDN) | placeID 2106 |
| KA1 | Katowice Downtown | placeID 4145 |
| KALO | Katowice Airport (KTW) | placeID 4144 |
| KRDW | Krakow Train Station | placeID 8504 |
| KRGA | Krakow Train Station | Galeria Krakowska z UI mapuje sie do najblizszego punktu DiscoverCars: Krakow Train Station, placeID 8504 |
| KRLO | Krakow Airport (KRK) | placeID 4146 |
| KRTI | Krakow Airport (KRK) | uzywa tych samych stawek co KRLO |
| LO1 | Lodz Downtown | placeID 3446 |
| LOLO | Lodz Lublinek Airport (LCJ) | placeID 1942 |
| LU1 | Lubin Downtown | placeID 7306 |
| OL1 | Olsztyn Downtown | placeID 5856 |
| OP1 | Opole Downtown | placeID 6089 |
| PO1 | Poznan Downtown | placeID 3449 |
| POLO | Poznan Airport (POZ) | placeID 1663 |
| TO1 | Torun Downtown | placeID 5829 |
| WA1 | Warsaw West Train Station | placeID 356108 |
| WA2 | Warsaw Train Station | placeID 8305 |
| WALO | Warsaw Chopin Airport (WAW) | placeID 1664 |
| WR1 | Wroclaw Downtown | placeID 3459 |
| WRLO | Wroclaw Airport (WRO) | placeID 2103 |

Workbook zawiera tez arkusze kontrolne:

- `Recommendations Review` - jeden wiersz na zgrupowana rekomendacje z kolumna `Akceptacja?`, polskim statusem, uwagami kontroli i opisem decyzji.
- `Validation` - szybkie kontrole przed importem, m.in. zgodnosc dat, duplikaty, puste stawki, wykluczone grupy i brak benchmarku.

Najpierw uruchom dry-run:

```powershell
python tools/update_excel_rates.py --workbook "C:\path\to\rates.xlsx" --recommendations output/pricing-recommendations.json --config excel-rate-update.config.example.json --dry-run
```

Realny zapis kopii pliku i czystego pliku importowego:

```powershell
python tools/update_excel_rates.py --workbook "C:\path\to\rates.xlsx" --recommendations output/pricing-recommendations.json --config excel-rate-update.config.example.json --output output/rates-updated.xlsx --import-output output/rates-import-ready.xlsx
```

Standardowy plik importowy zawiera wszystkie rekomendowane zmiany, ktore przeszly reguly, floor cenowy i wykluczenia grup. Tryb `--accepted-only` pozostaje tylko reczna opcja awaryjna, ale daily workflow go nie uzywa i nie tworzy osobnego pliku accepted-only.

Rekomendacje uwzgledniaja kalibracje narzutu brokera DiscoverCars. `site_target_rate_pln_day` oznacza cene, w ktora narzedzie celuje na stronie DiscoverCars, a `suggested_rate_pln_day` oznacza stawke wpisywana do pliku importowego po odwroceniu szacowanego narzutu. Workflow publikuje `broker-markup-calibration.json`, uczy sie z obserwacji `stawka w pliku -> live cena MM` i uzywa najnowszej kalibracji w kolejnym runie.

Kolory w Excelu:

- zielony w glownym arkuszu - cena podniesiona; im mocniejszy zielony, tym wieksza dodatnia zmiana PLN/dzien,
- czerwony w glownym arkuszu - cena obnizona; im mocniejszy czerwony, tym wieksza ujemna zmiana PLN/dzien,
- zmieniona komorka w glownym arkuszu ma krotki komentarz: poprzednia stawka, nowa stawka i zmiana w PLN,
- arkusz `Changed Positions` ma u gory legende kolorow i kopiuje tylko zmienione pozycje,
- podobne zmiany dla wielu grup sa laczone w jednym wierszu, a grupy sa wypisane razem w kolumnie `A`; identyczne kwoty w kolumnach stawek i komentarzu sa pokazywane tylko raz,
- kolumna `O` w `Changed Positions` zawiera wyjasnienie proponowanej zmiany ceny, w tym efekt typu top1/top2/top3, bez lokalizacji, daty odbioru, duration i korekty grupy; pozostale komorki w tym arkuszu nie dostaja komentarzy.
- w `Changed Positions` niebieski oznacza rekomendacje `top1_gap`: MM Cars Rental jest top1, a top2 jest drozszy o co najmniej `5 PLN/dzien`; cel jest `1 PLN` ponizej top2.
- w `Changed Positions` czerwony oznacza rekomendacje `top3_small_decrease`: obnizka mniejsza niz `10 PLN/dzien` pozwala przeskoczyc wyzej ustawionego rywala z top3 ofert; cel jest `1 PLN` ponizej tej oferty.
- w `Changed Positions` pomaranczowy oznacza rekomendacje `top1_undercut`: MM Cars Rental jest top2 i brakuje mniej niz `10 PLN/dzien`, zeby zostac top1; cel jest `1 PLN` ponizej obecnego top1.

Minimalne stawki przy aktualizacji Excela:

- globalnie stawka nie spada ponizej `70 PLN brutto/dzien`,
- dla duration od `21` dni (kolumna N) stawka nie spada ponizej `100 PLN brutto/dzien`,
- od `2026-06-25` do `2026-08-31` dla kolumn od `8` dni (M oraz N) stawka nie spada ponizej `115 PLN brutto/dzien`.

Domyslnie updater zmienia wszystkie grupy poza `CGAV`, `IDAH`, `SFAV` i `SWAV`. Na koncu generowania importu wyrownuje tez relacje grup: `CDMV`, `CWAV`, `CWMR`, `DDAC`/`DDAV` i `IGMV` dostaja taka sama stawke bazowa, a `EDAH` oraz `EDMV` dostaja stawke o `1 PLN/dzien` wyzsza. Opcjonalnie `--groups=...` moze ograniczyc aktualizacje do wybranych grup, ale wykluczenia nadal sa respektowane.

W trybie konsolowym:

- dla kazdego scenariusza dat jest wyswietlana jedna tabela,
- nad tabela jest informacja o okresie (`pickup -> dropoff`),
- ocena firmy jest pokazywana obok nazwy firmy w kolumnach `top*_company`,
- ceny w tabelach sa pokazywane jako stawki dobowe (`*_daily_rate`), liczone z `total_price / rental_days`,
- `MM Cars Rental` jest podswietlane kolorem w kolumnach `top*_company` i `mm_cars_rental_daily_rate`.
- `MM Cars Rental` ma czerwone podswietlenie, gdy jest drozsze maksymalnie o `10 PLN` na dobe od konkurenta na wyzszym miejscu.
- `MM Cars Rental` ma niebieskie podswietlenie, gdy jest w `top1`, a `top2` jest drozsze o co najmniej `5 PLN` na dobe.

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
  - pierwszy `pickup`: jutro o `11:00`,
  - kolejne pickupy: kazdego nastepnego dnia przez 30 dni,
  - `rental_days`: domyslnie 1..10 dla kazdego startu, opcjonalnie do 20 dni
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
  - miasta: `Warsaw,Krakow,Gdansk,Katowice,Wroclaw,Poznan,Lodz,Bydgoszcz,Torun`.
