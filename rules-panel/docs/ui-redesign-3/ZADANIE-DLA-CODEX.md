# Zadanie: nowa szata graficzna panelu (`rules-panel`), wersja pod `main` 08008a8

Repozytorium: `prejsik/discovercars-tool`, katalog `rules-panel/`. **Punkt wyjścia: `main` na commicie `08008a8`** (macierz pasm Excela i „Zobacz aktualne reguły” już są).
Ten plik zastępuje wcześniejsze zadanie „ui-redesign-2”.

Makiety:
- `zrzuty/*.png`: obraz docelowy;
- `makiety-html/*.html`: statyczny HTML z dokładnymi kolorami, odstępami i tekstami;
- `zrzuty/teraz/*.png`: jak panel wygląda dziś (punkt odniesienia).

Liczby na makietach są przykładowe. W panelu mają pochodzić z danych.

Zakres zatwierdził dyrektor operacyjny. **Wykonuj tylko etapy 1–5.** Lista „Poza zakresem” na końcu jest wiążąca.

## Twarde ograniczenia

- NIE zmieniaj zasad cenowych ani ich plików: `pricing-rules.config.example.json`, `excel-rate-update.config.example.json`, `locations.config.json`, `input/*`.
- NIE zmieniaj scrapera (`src/`), workflow (`.github/`), harmonogramu, silnika Python, `rules-panel/server/*` ani logiki `src/policy.mjs`.
- Zmieniasz wyłącznie prezentację i nawigację. Agregacje do wyświetlenia liczysz z istniejących danych (`data.rows`, `buildBandMatrix`, `bandEvidence`, `branchOverview`, `overviewRows`). Nie dodawaj nowych zapytań do API.
- Zachowaj działanie istniejących funkcji: macierz pasm (`BandMatrix`), `InlineDecision`, `RuleContext` („Zobacz aktualne reguły”), przyciski Import / Rekomendacje, `locationLabel`, kolejność i źródła stawek, ostrzeżenia o różnych uruchomieniach.
- NIE pushuj na `main` i nie wdrażaj (`wrangler deploy`). Każdy etap to osobna gałąź i osobny PR.
- Po każdym etapie: `npm test`, `npm run test:engine`, `npm run build` i testy UI dotyczące zmienianych widoków (m.in. `matrix-rules-ui.mjs`, `market-workspace-ui.mjs`, `market-autoload-ui.mjs`, `inline-decision-ui.mjs`).
- Testy UI, które sprawdzają stare etykiety lub układ, zaktualizuj **bez osłabiania sprawdzeń zachowania**. Muszą zostać: dokładne stawki pasm, przełączanie klasy, brak zapisów (POST), brak poziomego przewijania przy 320 / 390 / 1024 / 1440 px, ponowne użycie odczytu Excela w szczegółach.
- Teksty po polsku z polskimi znakami. Kontrast tekstu ≥ 4,5:1. Elementy klikalne ≥ 40 px wysokości. Prawdziwe `<button>` i `<a>`. Kolor nigdy nie jest jedynym nośnikiem informacji: zawsze idzie ze znakiem i liczbą.

## Konwencja znaku (ważne)

W kodzie `row.gap = konkurent − MM` (wartość dodatnia oznacza, że MM jest tańsze), a w `buildBandMatrix` `worstGap = min(gap)`.
**W interfejsie zawsze pokazuj „MM − konkurent” = `−gap`:** `+18` = MM droższe o 18 PLN/d, `−22` = MM tańsze o 22 PLN/d.

---

## Etap 1 – Fundamenty wyglądu i drobne poprawki (jeden PR)

Makiety: `wyglad-A-cyfry-i-kwoty.png`, `wyglad-B-fonty.png`, `wyglad-C-menu-i-przyciski.png`, `wyglad-D-jezyk-i-formaty.png`. Każda pokazuje PRZED (lewo) i PO (prawo).

### 1.1 Tokeny kolorów (`src/styles.css`, `:root`)

```css
/* baza */
--bg: #F4F5F7; --surface: #FFFFFF; --line: #E3E6EA; --line-soft: #EEF0F3;
--ink: #14171C; --ink-2: #3A404B; --muted: #5B6271;
--accent: #2457D6;          /* akcje, linki, zaznaczenie */
--brand: #F2C230;           /* tylko logo */
--nav-active: #ECEEF2;
/* MM droższe (czerwień) */
--over-1: #FDE4E2; --over-1-ink: #7A1712;   /* > +5  */
--over-2: #F7B9B3; --over-2-ink: #5F120D;   /* ≥ +10 */
--over-3: #E5675C; --over-3-ink: #2B0603;   /* ≥ +20 */
--over-4: #B42318; --over-4-ink: #FFFFFF;   /* ≥ +40 */
/* MM tańsze (zieleń) */
--under-1: #DFF3E5; --under-1-ink: #14532D; /* < −5  */
--under-2: #A8DDB8; --under-2-ink: #0E3B20; /* ≤ −20 */
--under-3: #237A45; --under-3-ink: #FFFFFF; /* ≤ −30 */
--neutral: #F1F2F5; --neutral-ink: #5B6271; /* |różnica| ≤ 5 */
/* stany specjalne */
--missing: #1B2230; --missing-ink: #FFFFFF; /* brak oferty MM */
--nodata: repeating-linear-gradient(45deg, #9AA0AB 0 2px, #FFFFFF 2px 5px); /* brak danych */
```

- W `src/market-model.mjs` dodaj `export const NEUTRAL_BAND_PLN = 5` oraz `export function priceTone(mmMinusCompetitor)`, która zwraca `over-1..4`, `under-1..3` albo `neutral`. Progi: droższe 5 / 10 / 20 / 40, tańsze 5 / 20 / 30. Dodaj klasy CSS `.tone-over-1` … `.tone-neutral`, `.tone-missing`, `.tone-nodata` (tło + kolor tekstu z tokenów).
- Etykieta różnicy: `+7,20` / `−6,71`, a w zakresie ±5: `±4,44` (szara). Brak MM: ciemna etykieta „brak MM”. Brak danych: kreskowanie z „?”.

### 1.2 Cyfry i kwoty (makieta A)

- `font-variant-numeric: tabular-nums` na `:root`.
- Kolumny z kwotami i liczbami wyrównane do prawej we wszystkich tabelach (`AttentionView`, `BandMatrix`, `Dashboard`, `PricesView`, `ChangeReview`, lista reguł, `InlineDecision`).
- Tam, gdzie MM i konkurent są w jednej komórce („125,22 / 117,37”), rozdziel je na osobne kolumny.

### 1.3 Fonty (makieta B)

- Zastąp `@fontsource-variable/inter` (import w `src/main.jsx`) pakietami `@fontsource/ibm-plex-sans` (400, 500, 600) i `@fontsource/ibm-plex-mono` (500). Fonty lokalne, nie z Google Fonts.
- `--font-sans: "IBM Plex Sans", Arial, sans-serif; --font-mono: "IBM Plex Mono", monospace;`
- Klasa `.code`: mono, 12 px, tło `--neutral`, `padding: 1px 5px`, `border-radius: 3px`. Stosuj ją do kodów stref (KRLO, KALO) i klas (CDMV, EDAV) wszędzie, także w selektorach „Klasa w tabeli” i „Kod w tabeli”.

### 1.4 Menu i przyciski (makieta C)

- Menu boczne: aktywna pozycja na tle `--nav-active`, pogrubiona, bez żółtego tła i ramki. Żółty tylko w logo (znak 24–28 px).
- Licznik przy „Ceny i rynek” (`attentionCount` w `main.jsx`): pokazuj samą liczbę, np. `126`, z `aria-label="126 pozycji bez oferty MM"`, zamiast „Brak MM: 126”, które łamie nazwę pozycji na dwie linie. Przy „Zasady cenowe” pokazuj „szkic”, gdy są nieopublikowane zmiany.
- Zakładki („Do sprawdzenia / Wykres / Kalendarz cen / Stawki w Excelu” oraz „Reguły / Klasy pojazdów / Sprawdź minimum / Historia”) jako podkreślenie: `role="tablist"`, aktywna z dolną linią 2 px `--ink`, bez obramowanych kafelków.
- Przełączniki („Wszystkie auta / Automaty”, „Lista / Kalendarz”, kod strefy) jako segmenty: wspólna ramka, aktywny segment ciemny.
- Najwyżej jeden przycisk główny (`--accent`) na ekran. „Odśwież ceny” to przycisk drugorzędny (z ramką), bo dane wczytują się automatycznie.
- Bez kart w kartach i bez ramek wokół samych grup filtrów.

### 1.5 Język i formaty (makieta D, wszystkie 9 wierszy)

| Miejsce | Ma być |
|:--|:--|
| Nazwa lokalizacji | `locationLabel` wszędzie, z kodem w `.code` |
| Data w tabelach | z dniem tygodnia: „pt 13.11.2026”, a w macierzy i siatkach krótko: „pt 13.11” |
| Miesiąc | „listopad 2026” (`Intl.DateTimeFormat('pl-PL', {month:'long', year:'numeric'})`) zamiast „November 2026”. Obok natywnych pól daty pokaż sformatowaną datę po polsku albo użyj przycisku zakresu jak na makiecie widoku oddziału. |
| Liczebniki | `countLabel` / `Intl.PluralRules('pl-PL')`: „1 zmiana”, „2 zmiany”, „5 zmian” |
| Zakres reguły | „9 lotnisk (19 kodów stref) · 6 klas · 1–20 dni” (już częściowo jest: „9 punktów odbioru (19 kodów w Excelu)”, ujednolić) |
| Duża zmiana | „+4969 PLN · ×166,6”. Procent tylko przy zmianie mniejszej niż ×3. |
| Pozycja bez oferty MM | „Brak oferty MM · konkurent 123,28 PLN/d” zamiast podwójnego „Brak porównania cen” (`gapLabel`, `MarketDetail`) |
| Tryb lokalny | „Wspólny szkic na tym komputerze. Publikacja do GitHuba jest wyłączona.” |
| Długie opisy różnic | w tabelach skrót `+7,20` z kolorem (pełne zdanie „MM droższe o 7,20 PLN/dobę” tylko w panelu szczegółów i w `aria-label`) |

### 1.6 Drobne poprawki

- Diagnostyka na Pulpicie (`ReportsView`): jedna zwinięta linia „Diagnostyka uruchomienia · przebieg N · start HH:MM · [stan Excela]”. Treść po rozwinięciu bez zmian.
- Harmonogram pokazany tylko raz.

---

## Etap 2 – „Do sprawdzenia”: mapa oddziałów × dni jako widok domyślny

Makieta: `2-do-sprawdzenia-mapa.png` (dziś: `teraz/2-przeglad-oddzialow.png`).

- W `AttentionView`, gdy nie wybrano oddziału, pokaż przełącznik **„Mapa | Tabela oddziałów”**. Domyślna jest **Mapa**. Obecna tabela z `branchOverview` zostaje jako drugi widok, w nowym stylu.
- **Wiersze:** oddziały (`locationLabel` + `.code` z pierwszym kodem strefy). **Kolumny:** dni z zakresu filtra (domyślnie dziś + 13). Ostatnia kolumna „Σ” = liczba komórek problemowych.
- **Komórka (oddział, dzień)** agreguje wiersze z bieżącego filtra skrzyni (najem 2–14), w tej kolejności:
  1. wszystkie wiersze bez potwierdzonych danych: „?” na kreskowaniu;
  2. choć jeden wiersz `marketConfirmed && mm === null`: ciemna komórka „brak”;
  3. w pozostałych przypadkach najgorsze MM − konkurent = `max(−gap)`, z kolorem z `priceTone` i tekstem „+18” / „−22”; w zakresie ±5 tylko „·”.
- **Komórka problemowa** (do Σ i sortowania): „brak” albo MM droższe o ponad 10.
- **Sortowanie oddziałów:** malejąco po Σ, potem po nazwie.
- **Nagłówki dni:** dzień tygodnia + numer, weekendy na tle `--nav-active`, „dziś” podpisane. Wydarzenia z `CalendarEvents` (`eventsForDay`) jako mały znacznik. Nie wpisuj świąt na sztywno.
- **Legenda** nad mapą jak na makiecie.
- **Komórka** to `<button>` z `aria-label`, np. „Kraków · Lotnisko, 05.11: MM droższe o 8 PLN/d”.
- **Kliknięcie komórki albo nazwy oddziału** otwiera widok oddziału (etap 3) dla tego oddziału. Po kliknięciu komórki dzień jest podświetlony i przewinięty do widoku.
- Przy 390 px mapa przewija się poziomo w swoim kontenerze, a kolumna oddziałów jest przyklejona (`position: sticky; left: 0`). Agregację licz w `useMemo`.

---

## Etap 3 – Widok oddziału: nowy wygląd istniejącej macierzy pasm

Makieta: `4-widok-oddzialu-macierz.png` i `makiety-html/4-widok-oddzialu-macierz.html` (dziś: `teraz/5-widok-oddzialu-szczegoly.png`).
**Dane, źródła i liczby bez zmian.** Zmienia się układ i wygląd `BandMatrix` oraz panelu szczegółów.

- **Nagłówek:** okruszek „Wszystkie oddziały ›”, strzałki poprzedni / następny oddział (kolejność jak w mapie), nazwa oddziału, „8 z 25 w przeglądzie”. Po prawej podsumowanie: „5 dni bez MM · 29 z 164 MM droższe >10 · 0 brak danych” (z `branchOverview` dla tego oddziału).
- **Jeden pasek filtrów:** przycisk zakresu dat („wt 03.11 – pn 16.11 ▾”, otwiera pola Start od / Start do), segment „Wszystkie auta | Automaty”, „Stawka z Excela dla: klasy [CDMV ▾]” oraz kod strefy jako segment (`KRLO | KRTI`). **Usuń zdublowane** „Oddziały przeglądu” (select) i przycisk „Wszystkie oddziały” z tego widoku. Filtr typu oddziałów zostaje tylko w przeglądzie (etap 2).
- **Macierz:** wiersz 44 px, kolumna „Start” = „śr 04.11”, weekendy z lekkim tłem. Kolumny pasm 2 · 3–4 · 5–7 · 8–20 (z dopiskiem „rynek 8–14”).
  - W komórce po prawej **stawka do importu** (600, wyrównana do prawej), po lewej **etykieta różnicy** z `priceTone` dla `−worstGap`: `+7,20`, `−5,65`, `±4,44`.
  - Gdy `missingMM > 0`: ciemna etykieta „brak MM” zamiast różnicy. Liczba braków trafia do `aria-label` („brak MM w 1 z 4 długości”).
  - Gdy brak stawki w Excelu: „Brak stawki” w kolorze `--muted`.
  - Zaznaczona komórka: tło `#EAF0FD` i obrys 2 px `--ink`.
- **Szczegóły pasma w panelu bocznym** (desktop: z prawej, telefon: wysuwany od dołu, jak obecny `MarketDetail`) zamiast rozwijanego wiersza pod tabelą:
  - nagłówek „śr 04.11 · pasmo 3–4 dni” + oddział i `.code` klasy i kodu;
  - trzy liczby obok siebie: Baza · Do importu (z różnicą do bazy) · Minimum reguł (z `previewPolicy`, tak jak w `RuleContext`);
  - tabela „Rynek w tym paśmie”: dla każdej długości pasma MM, konkurent, MM − konkurent, pozycja („Top 2”) i nazwa konkurenta;
  - **ostrzeżenie „Niespójne pasmo”**, gdy w jednym paśmie jedna długość ma MM − konkurent > +5, a inna < −5;
  - uzasadnienie z `InlineDecision` (skrócone, „Szczegóły zapisanej decyzji” zwinięte);
  - przyciski: „Zobacz reguły dla tej pozycji” (główny, `RuleContext`), „Scenariusz” i „Pełna tabela” (drugorzędne);
  - ↑ / ↓ przechodzą do sąsiedniego dnia w tym samym paśmie (jak dziś nawigacja w `MarketDetail`), Esc zamyka panel.
- Legenda w jednej linii pod tabelą: „Liczba: stawka do importu · etykieta: najgorsza różnica rynku MM − konkurent w paśmie · ■ brak MM w paśmie”.
- Stronicowanie „Pokaż kolejne 20 dat” zostaje.

---

## Etap 4 – Kalendarz cen

Makieta: `3-kalendarz-cen.png` (dziś: `teraz/7-kalendarz.png`). Dotyczy `PriceCalendar` w `src/MarketWorkspace.jsx`.

- **Komórka dnia:** numer dnia (i znacznik wydarzenia), w środku cena MM (18 px, 600), na dole „konk. 117” i różnica MM − konkurent w PLN („+8”). Tło z `priceTone`. **Procent usuń.**
- **Stany:** dziś obrysowany, dni bez danych w raporcie z przerywaną ramką i „poza raportem”, dni spoza miesiąca puste, weekendy z lekkim tłem.
- **Długości najmu** jako chipy `2 d · 3 d · 4 d · 5 d · 7 d · 10 d · 14 d` (wielokrotny wybór) zamiast `<details>` z checkboxami. Pozostałe długości pod „więcej”.
- **Nawigacja miesiąca:** strzałki + „listopad 2026 · 3 dni” (bez natywnego `input type="month"` pokazującego „November 2026”). Obok „MM Top1: 16 z 27 dni · średnio −2,10 PLN/d” z widocznych dni.
- Jedna linia legendy pod kalendarzem. Kliknięcie dnia otwiera obecny `MarketDetail`.

---

## Etap 5 – Pulpit

Makieta: `1-pulpit.png` (dziś: `teraz/1-pulpit.png`). Rozbuduj `Dashboard.jsx`, **zachowując przyciski Import / Rekomendacje**. „Przejrzyj ceny” zamień na „Zacznij przegląd” (przycisk główny, prowadzi do mapy z etapu 2). Import / Rekomendacje stają się przyciskami drugorzędnymi z ikoną pobierania.

- **Pasek stanu** (jedna belka, 4 pola): raport (aktualny / starszy niż 24 h, godzina, % sprawdzeń), Excel (OK / zablokowany + tytuł z `incident`, link do diagnostyki), szkic zasad (liczba zmian, w tym dużych, link „Przejrzyj”), następny start (`nextSchedule`). Kropka koloru zawsze z tekstem.
- **Nagłówek:** „Przegląd na wtorek, 3 listopada” + „Najbliższe 14 dni · 25 oddziałów · najem 2–14 dni · wszystkie auta · N sprawdzeń”.
- **4 liczniki** (`overviewRows`): brak oferty MM · MM droższe o ponad 10 PLN/d · Top1 z zapasem ≥ 30 PLN/d · brak potwierdzonych danych. Każdy ma:
  - kontekst („w 7 z 25 oddziałów”);
  - mini-wykres słupkowy 14 dni (`role="img"` z `aria-label` podającym wartości);
  - kliknięcie otwierające mapę z tym filtrem.
- **„Najpilniejsze”** (6): najpierw brak MM (najbliższe daty), potem największe MM − konkurent. Kolumny: oddział + `.code`, start („pt 07.11”), najem, MM, konkurent, pasek różnicy z wartością. Link „Wszystkie (N)”. Kliknięcie wiersza otwiera widok oddziału z tym dniem.
- **„Oddziały z największą liczbą pozycji”** (6) z `branchOverview`: liczba i dwukolorowy pasek (brak MM / MM droższe >10) z legendą.
- Diagnostyka zgodnie z 1.6.

---

## Poza zakresem (nie rób)

- Oś czasu w „Zasadach cenowych” (dyrektor odrzucił).
- Funkcje wygody: przyczyna przy pozycji (minimum / import / ochrona jako ikony), statusy „sprawdzone / odłóż”, zaznaczanie komórek → „ustaw minimum”, nowe skróty klawiszowe (poza ↑ ↓ i Esc w panelu), zapisane widoki, znacznik „nowe od ostatniego raportu”.
- Przycisk „Sprawdź wpływ” przed publikacją.
- Zmiany w scraperze, Excelu, zasadach, publikacji i backendzie panelu.

## Definicja ukończenia (każdy etap)

- Wszystkie testy przechodzą. Nowe zachowania mają testy: `priceTone`, agregacja komórki mapy, ostrzeżenie „Niespójne pasmo”, formaty dat i liczebników, nawigacja poprzedni / następny oddział.
- Do PR dołączone zrzuty 390 i 1440 px porównane z makietą.
- `git diff --stat` dotyczy tylko `rules-panel/` (oraz `package.json` / `package-lock.json` panelu przy fontach).
