# DiscoverCars - scraper i kontrola cen

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
- wynik zapisuje jako artifact GitHub Actions: `report.html`, `results-latest.json`, `pricing-recommendations.json`, `final-pricing-recommendations.json`, `rates-import-ready.xlsx`, `rates-updated.xlsx`, `excel-rate-update-summary.json`, `mm-rate-sanity-check.json`, `scrape-quality.json`, `quality-alerts.json`, `run-manifest.json`, `run-log.txt`, opcjonalnie `state.json`,
- publikuje GitHub Pages z linkami dla pelnego raportu i najnowszego Excela; test po pushu nie powinien nadpisywac glownego pelnego raportu.

Domyslny zakres w chmurze:

- `locations`: wszystkie 21 punktow z `locations.config.json`, w tym wszystkie skonfigurowane oddzialy miejskie i lotniska,
- `rolling_days`: `60`
- `durations`: `2,3,4,5,6,7,8,9,10,11,12,13,14`
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
- `mm-rate-sanity-check.json` - obowiazkowy live sanity check pelnego i recznego runu; sprawdza do 13 probek, porownuje ponowny odczyt MM z pelnym scraperem i weryfikuje relacje ceny strony do stawki z potwierdzonego baseline,
- `quality-alerts.json` - alerty jakosciowe uzywane w Telegramie,
- `run-manifest.json` - status `success/degraded/failure`, zakres, lokalizacje, duration i SHA kodu dla konkretnego runa,
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

Powiadomienie Telegram po zakonczeniu jest celowo krotkie: pokazuje status, zakres, liczbe podwyzek i obnizek, liczbe zmian w Excelu, czas oraz bezposrednie linki do raportu i obu plikow Excel. Przy ostrzezeniu lub bledzie podaje najwazniejszy powod i link do GitHub Actions.

Workflow podaje linki GitHub Pages dopiero po udanym wdrozeniu strony. Gdy Pages zawiedzie, ale artefakty zostana przeslane, Telegram automatycznie poda linki do artefaktow. Brak raportu albo obu plikow Excel nie moze zostac pokazany jako sukces: komunikat otrzyma status `BLAD PUBLIKACJI`.

Status `failure` blokuje publikacje nowego Excela. Raport diagnostyczny i artefakty sa nadal publikowane, jesli ich wygenerowanie bylo mozliwe, a bramka jakosci oznacza run jako nieudany, aby kolejne zapasowe okno crona moglo wykonac ponowna probe.

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

API-first scraper (domyslnie wlaczony):

```powershell
node src/index.js --api-first
```

Ten tryb pobiera oferty bezposrednio z backendu DiscoverCars (`/api/v2/search/...`) i parsuje tylko `data.offers[]`, dzieki czemu ignoruje techniczne ceny z filtrow oraz pseudo-dostawcow typu `DiscoverCars choice`. Filtr skrzyni automatycznej korzysta z pola `vehicle.specifications.isAutomaticTransmission` oraz SIPP. DOM/Playwright zostaje jako fallback dla pustych/slabych wynikow i jako kontrolna probka sanity.

Sterowanie kontrola DOM:

```powershell
node src/index.js --api-dom-sanity-rate=0.05
node src/index.js --api-dom-sanity-rate=0
```

Codzienny workflow zapisuje checkpoint po scraperze i przygotowaniu rekomendacji, a weryfikacje DOM oraz publikacje wykonuje w osobnym jobie z nowym limitem 6 godzin. Rekomendacje do sprawdzenia sa dzielone wedlug pary data-dlugosc najmu na cztery rownolegle shardy i scalane przed utworzeniem Excela. Kazdy shard ma limit 150 minut; brakujace, zduplikowane lub niesprawdzone wyniki sa ustawiane jako `hold` i nie trafiaja do importu.

Przed weryfikacja powstaje `recommendation-workload.json` z liczba rekomendacji, liczba grup DOM, szacowanym czasem i wykorzystaniem budzetu. Prognoza korzysta z czasu poprzedniego pelnego runu. Po scaleniu DOM pelny run porownuje finalna liczbe aktywnych rekomendacji z poprzednim pelnym runem; wzrost o ponad 100% uruchamia osobny alert Telegram.

Awaryjny powrot do starego flow DOM:

```powershell
node src/index.js --no-api-first
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
- runner chunkowy dodatkowo pilnuje jednego globalnego budzetu przez `--max-active-pages` i automatycznie obniza zagniezdzona rownoleglosc, gdy ich iloczyn przekroczylby limit.

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

- jedna instancja Chromium jest wspoldzielona w ramach procesu/chunka, a kazda lokalizacja nadal dostaje swiezy, izolowany kontekst,
- w trybie `fast`/`turbo` brak wejscia na homepage przed direct search,
- w trybie `fast`/`turbo` blokada obrazkow, fontow i mediow,
- adres Galerii Krakowskiej korzysta bezposrednio z geo-search API strony zamiast powtarzac pelny formularz w przegladarce,
- odpowiedzi API z okresem innym niz zadany sa odrzucane zamiast trafiac do raportu,
- zapytania API maja osobny limit `20 s`, po ktorym nadal dzialaja retry i fallback przegladarkowy,
- gotowy wynik DOM jest wykrywany zdarzeniowo; poprzednie pelne czekanie pozostaje automatycznym fallbackiem,
- po przerwanym lub zdegradowanym chunku checkpoint zachowuje sukcesy i ponawiane sa tylko scenariusze z bledem,
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

Domyslnie runner dzieli daty co `7` dni, uruchamia maksymalnie `2` chunki rownolegle, uzywa wszystkich 21 lokalizacji daily workflow, `legacy-batch`, `fast`, `retries=0`, `scenario-concurrency=2`, `location-concurrency=3` i globalnego limitu `max-active-pages=8`. Przy takim ukladzie efektywna rownoleglosc lokalizacji jest bezpiecznie obnizana do `2` (`2 x 2 x 2 = 8`). Po scaleniu runner zapisuje `report.html`, `pricing-recommendations.json`, `final-pricing-recommendations.json`, a jesli podano `--workbook`, takze `rates-updated.xlsx` oraz `rates-import-ready.xlsx`.

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

Updater Excela bierze rekomendacje, mapuje lokalizacje na strefy z pliku stawek i zapisuje nowy workbook z kolorami. Daily workflow robi to automatycznie na bazie `input/mm-cars-rental-rates-inclusive-fp.xlsx` i publikuje dwa pliki: `rates-import-ready.xlsx` jako plik gotowy do importu z samym `Sheet1` oraz `rates-updated.xlsx` jako pelny raport kontrolny. Glowny arkusz rozwija wszystkie klasy, w tym stale `CFAV` i `PDAH` oraz lustrzana `EDAV`, na kazdy dzien od dnia uruchomienia do czterech miesiecy kalendarzowych naprzod. Oba Excele zachowuja te sama siatke `Pickup start date`, rozne grupy i strefy, pozycje bez zmian oraz formatowanie wierszy 1-4 w `Sheet1`; dodatkowy arkusz `Changed Positions` pokazuje tylko zmienione pozycje w pelnym raporcie. Przed zapisem obowiazuje bezwzgledny limit `27000` wierszy w `Sheet1`; jego przekroczenie blokuje oba pliki.
Booking date jest ignorowany przy dopasowaniu rekomendacji. Dopasowanie odbywa sie po `Pickup start date`, a duration wybiera odpowiednia kolumne `I-N`; `Pickup end date` jest ustawiany na taka sama wartosc jak `Pickup start date`, a `Booking end date` zawsze dostaje taka sama wartosc jak `Pickup end date`.
Wymaga biblioteki Python `openpyxl` (`pip install openpyxl`), jesli nie jest jeszcze zainstalowana.

Jedynym zrodlem mapowania lokalizacji jest `locations.config.json`. Zawiera profile uruchomien, kanoniczna nazwe scrapera, typ punktu, kody importowe, placeID/geo tam, gdzie sa znane, aliasy starszych runow oraz relacje lustrzane typu `KRTI = KRLO`. Node, workflow i updater Excela czytaja ten sam rejestr.

| Kod importu | Lokalizacja w scraperze | Uwagi |
|---|---|---|
| BYLO | Bydgoszcz Airport (BZG) | placeID 5827 |
| GD1 | Gdansk Downtown | placeID 3451 |
| GDLO | Gdansk Airport (GDN) | placeID 2106 |
| KA1 | Katowice Downtown | placeID 4145 |
| KALO | Katowice Airport (KTW) | placeID 4144 |
| KRDW | Krakow Train Station | placeID 8504 |
| KRGA | Galeria Krakowska Shopping Mall | osobny punkt geo przy Pawiej 5; zachowuje odrebny rynek ofert od dworca |
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

Standardowy plik importowy zawiera wszystkie rekomendowane zmiany, ktore przeszly reguly, floor cenowy i wykluczenia grup. Wszystkie duration nalezace do jednej kolumny Sheet1 sa najpierw scalane do jednej decyzji; wybierany jest najbardziej restrykcyjny limit pozwalajacy utrzymac cel w calym przedziale. Gdy scraper nie objal calego przedzialu kolumny, automat nie podnosi tej stawki ponad wartosc z pliku bazowego i pokazuje brakujace duration w Validation. Tryb `--accepted-only` pozostaje tylko reczna opcja awaryjna, ale daily workflow go nie uzywa i nie tworzy osobnego pliku accepted-only.

Rekomendacje uwzgledniaja kalibracje narzutu brokera DiscoverCars. `site_target_rate_pln_day` oznacza cene, w ktora narzedzie celuje na stronie DiscoverCars, a `suggested_rate_pln_day` oznacza stawke wpisywana do pliku importowego po odwroceniu szacowanego narzutu. Workflow publikuje `broker-markup-calibration.json`, deduplikuje obserwacje, uzywa mediany oraz minimalnej liczby probek i stosuje hierarchie lokalizacja+duration -> lokalizacja -> duration -> globalny fallback.

`input/baseline-manifest.json` zapisuje SHA256, status i date potwierdzenia pliku bazowego. Tylko status `confirmed_imported` albo `verified_live` z hashem zgodnym z `input/mm-cars-rental-rates-inclusive-fp.xlsx` pozwala zmienic Sheet1 i uczyc kalibracje narzutu. Nowy plik przygotowany, ale jeszcze niewgrany na DiscoverCars, nie moze zostac uzyty jako produkcyjny baseline. Udany obowiazkowy sanity check zapisuje wynik live w artefaktach runu i `run-manifest.json`.

Kolory w Excelu:

- zielony w glownym arkuszu - cena podniesiona; im mocniejszy zielony, tym wieksza dodatnia zmiana PLN/dzien,
- czerwony w glownym arkuszu - cena obnizona; im mocniejszy czerwony, tym wieksza ujemna zmiana PLN/dzien,
- zmieniona komorka w glownym arkuszu ma krotki komentarz: poprzednia stawka, nowa stawka i zmiana w PLN,
- arkusz `Changed Positions` ma u gory legende kolorow i kopiuje tylko zmienione pozycje,
- podobne zmiany dla wielu grup sa laczone w jednym wierszu, a grupy sa wypisane razem w kolumnie `A`; identyczne kwoty w kolumnach stawek i komentarzu sa pokazywane tylko raz,
- kolumna `O` w `Changed Positions` zawiera wyjasnienie proponowanej zmiany ceny, w tym efekt typu top1/top2/top3, bez lokalizacji, daty odbioru, duration i korekty grupy; pozostale komorki w tym arkuszu nie dostaja komentarzy.
- w `Changed Positions` niebieski oznacza rekomendacje `top1_gap`: MM Cars Rental jest top1, a top2 jest drozszy o co najmniej `10 PLN/dzien`; cel jest `1 PLN` ponizej top2.
- w `Changed Positions` czerwony oznacza rekomendacje `top3_small_decrease`: obnizka mniejsza niz `10 PLN/dzien` pozwala przeskoczyc wyzej ustawionego rywala z top3 ofert; cel jest `1 PLN` ponizej tej oferty.
- w `Changed Positions` pomaranczowy oznacza rekomendacje `top1_undercut`: MM Cars Rental jest top2 i brakuje mniej niz `10 PLN/dzien`, zeby zostac top1; cel jest `1 PLN` ponizej obecnego top1.

Minimalne stawki przy aktualizacji Excela:

- od `2026-07-01` do `2026-08-30` dla duration `1-7` stawka nie spada ponizej `70 PLN brutto/dzien`,
- w tym samym okresie dla duration `8-20` stawka nie spada ponizej `115 PLN brutto/dzien`,
- w tym samym okresie dla duration `21-35` stawka nie spada ponizej `100 PLN brutto/dzien`,
- od `2026-09-01` do `2027-01-31` dla duration `1-35` stawka nie spada ponizej `50 PLN brutto/dzien`,
- dla `2026-08-31` nie jest stosowany dodatkowy floor okresowy.

Domyslnie updater zmienia wszystkie grupy poza `CGAV`, `FVMD`, `SWAV`, `CFAV` i `PDAH`. Te grupy nie moga miec zmienianych stawek przez rekomendacje. `CGAV` moze byc tylko podswietlany kontrolnie ponizej `130 PLN/dzien`, a `SWAV` ponizej `150 PLN/dzien`. `CFAV` i `PDAH` maja wlasne stale stawki dobowe zalezne od duration. Updater dopisuje ich kompletne wiersze dla kazdej strefy i daty obecnej w grupie wzorcowej `CDMV`:

- `CFAV`: `1 dzien = 300 PLN`, `2 dni = 200 PLN`, `3-4 dni = 180 PLN`, `5-7 dni = 170 PLN`, `8-20 dni = 160 PLN`, `21-35 dni = 150 PLN`,
- `PDAH`: `1 dzien = 400 PLN`, `2 dni = 350 PLN`, `3-4 dni = 300 PLN`, `5-7 dni = 290 PLN`, `8-20 dni = 260 PLN`, `21-35 dni = 250 PLN`.

Klasa `EDAV` jest dopisywana na podstawie kompletnego zestawu wierszy `EDMV` i poza chronionymi okresami zawsze otrzymuje dokladnie te same stawki co `EDMV`. Na koncu generowania importu updater wyrownuje relacje grup: `CDMV`, `CWAV` i `CWMR` dostaja taka sama stawke bazowa, a `EDMV` i `EDAV` stawke o `1 PLN/dzien` wyzsza. Istniejace stawki nie sa zmieniane dla pickup start date od `2026-10-31` do `2026-11-02` oraz od `2026-12-15` do `2027-01-10` (daty wlacznie). Brakujace wiersze nowych klas sa nadal dopisywane, aby zachowac kompletna strukture pliku. Opcjonalnie `--groups=...` moze ograniczyc aktualizacje do wybranych grup, ale wykluczenia i okresy chronione nadal sa respektowane.

Przy aktywnej rekomendacji utrzymania top1 (`top1_gap` lub `force_top1_maintain`) stawka oddzialu miejskiego moze wynosic maksymalnie `130%` stawki odpowiadajacego lotniska dla tej samej daty, grupy i kolumny duration. Relacja miasto-lotnisko jest wyprowadzana z `locations.config.json`; brak wymaganej stawki lotniskowej albo konflikt z floorem blokuje zapis pliku importowego.

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
3. W oknie wybiera:
   - **dlugosci najmu**, pojedynczo albo zakresem `2-10` lub `2-20`,
   - **daty rozpoczecia najmu** jako zakres `Od-Do` albo konkretne dni,
   - **tryb dzialania** `fast`, `safe` lub `turbo`.
4. Dla konkretnych dat:
   - klikasz dni w kalendarzu albo wklejasz ich liste,
   - ponowne klikniecie tej samej daty usuwa ja z wyboru,
   - format listy to np. `2026-05-05, 2026-05-07, 2026-05-10`.
5. Po kliknieciu `Uruchom` scraper zapisuje JSON, generuje `output\report.html` i otwiera raport w przegladarce.

Uwagi:

- Lista lokalizacji pochodzi z profilu `daily` w `locations.config.json`.
- Przerwany run moze wznowic prace z `output\state.json`.
