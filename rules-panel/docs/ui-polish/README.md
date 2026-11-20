# Panel: wykończenie wyglądu

Zakres: tylko warstwa wizualna. Jeden nowy plik `src/polish.css`, importowany jako ostatni. Bez zmian w regułach cenowych, danych, endpointach, strukturze ekranów i tekstach.

## Co zmieniono

| Nr | Zmiana | Po co |
|---|---|---|
| 1 | Pola formularzy mają jedną wysokość, ramkę o kontraście 3,4:1, rysowaną strzałkę i wyraźne zaznaczenie aktywnego pola. | Wcześniej każde pole wyglądało inaczej, a ramka miała kontrast 1,3:1. |
| 2 | Trzy grubości tekstu (400/500/600) i minimum 12 px (10-11 px w gęstych siatkach). | Style prosiły o grubości, których czcionka nie ma, więc prawie wszystko było pogrubione; część podpisów miała 9-11 px. |
| 3 | Nagłówki tabel stoją nad liczbami, wiersz pod kursorem się podświetla. | W „Stawkach w Excelu” nagłówki były z lewej, liczby z prawej. |
| 4 | Na telefonie zakładki są w jednym wierszu przewijanym palcem. | Łamały się na dwie linie z osieroconą pozycją. |
| 5 | Jeden niebieski dla akcji, czytelny stan wyłączony. | Były dwa odcienie, a wyłączony przycisk był blady. |
| 6 | Pulpit: pasek statusu z separatorami, liczby w kaflach w jednej linii. | Link „Excel dostępny” wisiał niżej niż sąsiednie wartości. |
| 7 | Przełączniki segmentowe są złączone, linia zakładek biegnie przez całą szerokość. | Podwójne krawędzie i urwana linia. |
| 8 | Lista reguł i klas w jednej ramce z zaokrągleniem. | Wiersze leżały luzem na szarym tle. |
| 9 | W szczegółach pasma i w „Bazie” wartość stoi przy etykiecie. | Wartość była dosunięta do prawej, daleko od etykiety. |
| 10 | Spójne okna, komunikaty i puste stany. | Różne zaokrąglenia i odcienie ostrzeżeń. |
| 11 | Lżejsze menu boczne, licznik w owalnej ramce. | Czytelność. |
| 12 | Mapa, macierz i kalendarze: podświetlenie komórki, łagodniejsze pasmo weekendu, ciągłe ramki. | Czytelność. |

## Weryfikacja

- `npm run build`: bez błędów.
- `npm test`: 413 testów.
- `npm run test:ui`: 25 skryptów Playwright (1440/390 px i pośrednie szerokości, brak poziomego przewijania strony, brak zapisów w widokach odczytu).
- Kontrast tekstu policzony dla nowych par kolorów: od 4,8:1 do 10,4:1.
- Sprawdzono tylko w Chromium. Safari na iPhonie, Firefox i prawdziwy telefon nie były sprawdzane.

## Zrzuty przed/po

Dane na zrzutach są testowe (te same, których używają testy), nie produkcyjne.

| Widok | Zestawienie |
|---|---|
| Pulpit | [1440 px](01-pulpit-1440.png) |
| Mapa | [1440 px](02-mapa-1440.png) · [390 px](02-mapa-390.png) |
| Szczegóły pasma | [1440 px](04-szczegoly-1440.png) |
| Stawki w Excelu | [1440 px](06-stawki-excel-1440.png) |
| Zasady cenowe | [1440 px](07-zasady-1440.png) · [390 px](07-zasady-390.png) |
| Nowa reguła | [1440 px](10-nowa-regula-1440.png) |
