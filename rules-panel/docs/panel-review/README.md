# Panel: poprawki po przegladzie A-G

Zakres: interfejs i odczyt istniejacych danych. Bez zmian regul cenowych, walidacji/zapisu bazy, scrapera, eksportu, endpointow ani konfiguracji.

## Co zmieniono

| Punkt | Zmiana | Sprawdzenie |
|---|---|---|
| A | Licznik menu korzysta z tego samego `dashboardOverview` i tej samej skrzyni co Pulpit. Opis obejmuje najblizsze 14 dni. | Test jednostkowy zakresu/dat/duration oraz UI obu skrzyn i zgodnosci liczb. |
| B | Jedna informacja o czasie/aktualnosci danych, szczegoly w tooltipie. Desktop: mapa miesci co najmniej 16 oddzialow; mobile: bez limitu wysokosci, sticky daty i pierwsza kolumna. | Pomiar widocznych wierszy i braku przewijania strony na desktopie; przewijanie strony i mapy na mobile. |
| C | Sprawdzenie pliku z raportu nie zapisuje bazy. Wspolne porownanie, ostrzezenia, zwijane konfiguracje, prawidlowe ID i etykiety, informacja o identycznym SHA. | Testy `baseline-followup`, `baseline-workspace`, `location-onboarding`, `reports`; zmiany przejete z otwartego PR #6. |
| D | Selecty oddzialow i kodow stref: Lotniska / Poza lotniskami, sortowanie polskich etykiet. Nieznane etykiety nie znikaja. | Test grupowania i sortowania oraz kontrola faktycznych optgroup/opcji w przegladarce. |
| E | Cztery zakladki na dole telefonu, min. 56 px, safe-area i odstep pod trescia. | Geometria paska, liczba pozycji i brak poziomego przewijania. |
| F | Stawki w Excelu wczytuja sie automatycznie tylko w aktywnym widoku. Wspolne DurationChips, reczne Odswiez. Wynik jest przypisany do wyboru; stary wynik nie pojawia sie po zmianie. | Dokladne kwoty po zmianie klasy/kodu/dlugosci, brak ukrytego odczytu macierzy i brak POST podczas przegladania. |
| G | Biernik dnia tygodnia; pojedynczy kod jako tekst; wybor widocznego kalendarza tylko dla wielu dlugosci. | Test daty oraz UI pojedynczego kodu i jednej/wielu dlugosci. |

## Weryfikacja

- `npm test`: 392 testy.
- `npm run test:engine`: 1350 porownan minimow i korekt z rzeczywistym silnikiem Python; nie jest to pelna symulacja rekomendacji.
- `npm run check:deploy`: build produkcyjny i pakowanie Wrangler `--dry-run`, bez wdrozenia.
- `npm run test:worker`: 34 testy oraz testy lokalnego runtime Workers.
- `npm run test:ui`: 25 skryptow Playwright; obejmuja rowniez 320/390/1024/1440 px, dokladne stawki, ochrone danych i brak zapisow w widokach odczytu.
- Browser plugin not available; uzyto istniejacego zestawu Playwright z izolowanymi profilami i kontrolowanymi odpowiedziami API.

## Zrzuty przed/po

Wszystkie ceny, pliki i odpowiedzi API na zrzutach to dane testowe, nie produkcyjne. Testy nie zapisaly rzeczywistej bazy ani regul.

Pulpit/rynek/oddzial/Excel: przed = `eda4c54` (stan PR #6), po = ta galaz. Baza: przed pochodzi z kontroli PR #6 wzgledem `db90888` (main po PR #5); po jest ponownie uchwycone na tej galezi. W starej bazie nie istnial etap samego sprawdzenia: kadr przed pokazuje odpowiedz po polaczonej operacji sprawdzenia i zapisu, wykonanej w mocku.

| Widok | 1440x1000 przed / po | 390x844 przed / po |
|---|---|---|
| Pulpit | [Przed](before/dashboard-1440.png) / [Po](after/dashboard-1440.png) | [Przed](before/dashboard-390.png) / [Po](after/dashboard-390.png) |
| Mapa | [Przed](before/map-1440.png) / [Po](after/map-1440.png) | [Przed](before/map-390.png) / [Po](after/map-390.png) |
| Oddzial | [Przed](before/branch-1440.png) / [Po](after/branch-1440.png) | [Przed](before/branch-390.png) / [Po](after/branch-390.png) |
| Stawki w Excelu | [Przed](before/excel-1440.png) / [Po](after/excel-1440.png) | [Przed](before/excel-390.png) / [Po](after/excel-390.png) |
| Baza: sprawdzony plik z raportu | [Przed](before/report-checked-1440.png) / [Po](after/report-checked-1440.png) | [Przed](before/report-checked-390.png) / [Po](after/report-checked-390.png) |
| Baza: nowe kody po sprawdzeniu | [Przed](before/new-codes-1440.png) / [Po](after/new-codes-1440.png) | [Przed](before/new-codes-390.png) / [Po](after/new-codes-390.png) |
