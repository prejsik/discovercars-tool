# Panel zasad DiscoverCars

Panel dyrektora operacyjnego do przegladania, przygotowania, sprawdzenia i
zatwierdzania zasad cenowych. Daty oznaczaja pickup/start date, kwoty PLN
brutto za dobe. Panel nie importuje cen do DiscoverCars i nie promuje
wygenerowanych Exceli do pliku bazowego.

## Tryby

- Lokalnie: wspolny szkic na tym komputerze, prywatne pliki w `.local`,
  podglad skutkow na istniejacych danych. Publikacja GitHub zawsze wylaczona.
- Cloudflare bez integracji: zabezpieczony odczyt snapshotu z chwili build,
  bez mozliwosci zapisu. Ten tryb pozostaje domyslny do aktywacji.
- Cloudflare z integracja: aktualne zasady z GitHub, prywatny wspolny szkic,
  historia, test GitHub Actions i zatwierdzenie przez zalogowanego dyrektora.
  Wymaga zatwierdzonej aktywacji opisanej w `ACTIVATION.md`.

## Obsluga

1. Sprawdz dane zrodla i pliku bazowego w widoku stanu.
2. Wybierz klasy dopuszczone do zmian lub minima dla lokalizacji, klas,
   okresu startu i szesciu przedzialow dlugosci najmu.
3. Zapisz szkic z uzasadnieniem. Konflikt wersji wymaga odswiezenia,
   nie nadpisuje automatycznie zmian drugiej osoby.
4. Opcjonalnie uruchom podglad. Porownanie uzywa istniejacego silnika i danych cenowych,
   bez uruchamiania scrapera. Zakres dowodow i ograniczenia sa jawne.
5. Zatwierdz aktualny, poprawny szkic tej samej wersji zrodla i bazy.
   Publikacja zasad nie wymaga przeliczania wplywu.
   Zapis na `main` jest atomowy, bez force push. Nastepny run korzysta z zasad
   ze swojego checkoutu; trwajacy run nie zmienia zasad w polowie pracy.

Przywrocenie historii tworzy nowy szkic wymagajacy sprawdzenia i zatwierdzenia.
Nie cofa GitHuba ani pliku bazowego automatycznie. Historia widoczna w panelu
obejmuje ostatnie 50 zdarzen; wersje pozostaja w prywatnym magazynie.

## Granice edycji

Walidacja serwerowa edytora zasad dopuszcza tylko jawne pola zasad. Nie pozwala zmieniac
repozytorium, parytetu klas, harmonogramu ani dowolnych kluczy konfiguracji.
Baza i nowe lokalizacje maja oddzielny proces zatwierdzania opisany ponizej. Nowa macierz minimow
korzysta z `mandatoryScopedFloorsPlnDay`; zgodnosc liczenia sprawdzaja testy
JS i Python. Istniejace obowiazkowe minima i wykluczenia sa zachowane.

Zakres Excela pozostaje zgodny z konfiguracja produkcyjna: tryb `source_ranges`
zachowuje wszystkie bazowe okresy odbioru w obu plikach Excel, bez limitu 100 dni.
Zakresy sa dzielone tylko dla dat obecnych w rekomendacjach scrapera oraz na
granicach obowiazkowych minimow i ochrony dat; pozostale pozostaja zwarte.
Zmiany rynkowe obejmuja tylko daty obecne w rekomendacjach. Harmonogram scrapera
pozostaje bez zmian: 45 dni w nocy i 20 dni w dzien. Limit liczby wierszy pozostaje
wylaczony (`max_import_rows: null`). Podglad nie zmienia tej konfiguracji.
Zapis zasad nie oznacza zaimportowania nowych cen u brokera.

## Nowe lokalizacje z pliku bazowego

W widoku `Plik bazowy` wybierz XLSX i sprawdz plik. Nieznane symbole stref
pojawia sie w formularzu konfiguracji; sama kontrola nie zmienia dzialajacej bazy.
Kazdy symbol trzeba powiazac z istniejacym punktem albo nowym punktem wybranym
z wyszukiwarki DiscoverCars. Nowy punkt wymaga jawnego wyboru istniejacej tabeli
stalego narzutu. Nie ma automatycznej kalibracji ani zgadywania identyfikatorow.
Mozna tez wskazac udzial punktu w obu codziennych harmonogramach.

Po sprawdzeniu kompletnej konfiguracji panel pokazuje miasto, typ, narzuty
i lotniska referencyjne wynikajace z tego samego miasta w rejestrze. Nowe
lokalizacje stosuja ogolne zasady klas, w tym dopuszczenia i wykluczenia,
chronione terminy oraz minima rozrozniajace lotnisko/miasto. Wybor zrodla
narzutu kopiuje tylko tabele narzutu, nie lokalne minima ani wyjatki innych
oddzialow; ustawia sie je osobno w zasadach.

Zatwierdzenie zapisuje oryginalny XLSX, manifest, rejestr lokalizacji i rozszerzona
tabele narzutu w jednym commicie i jednym fast-forward `main`. Do tego momentu
dotychczasowa konfiguracja pozostaje aktywna. Niekompletny formularz, brak punktu
w DiscoverCars, usuniete dotychczasowe dane albo konflikt wersji nie publikuja
zadnej czesci zmiany. W jednym pliku mozna skonfigurowac do 12 nowych symboli.
Wyszukiwarka obsluguje konkretne punkty w Polsce, bez pozycji `all locations`.

## Prywatnosc i publikacja

Repozytorium `prejsik/discovercars-tool` jest publiczne. Szkice, uzasadnienia,
adresy osob i audyt pozostaja w prywatnym Durable Object. GitHub otrzymuje
tylko dwa zatwierdzone dokumenty zasad oraz anonimowe potwierdzenie publikacji.
Wejscie podgladu i artefakt wyniku sa szyfrowane AES-256-GCM; publiczne logi
nie moga zawierac tresci szkicu ani sekretow.

Worker weryfikuje podpis Cloudflare Access, issuer, audience, waznosc oraz
allowliste. Naglowek z adresem osoby nie jest dowodem tozsamosci. Kazdy zasob
przechodzi przez Worker; odpowiedzi sa prywatne i niecacheowane. Zapisy
wymagaja JSON, zgodnego Origin i `X-Panel-Request: 1`. Brak konfiguracji blokuje
dostep, nie otwiera panelu publicznie. Adresy dostepu sa sekretem serwera,
nie wpisem w publicznym `wrangler.jsonc`.

GitHub App ma dostep tylko do tego repozytorium, Contents write i Actions write.
Zapis zasad ogranicza sie do `pricing-rules.config.example.json`,
`excel-rate-update.config.example.json` i `rules-panel-publication.json`.
Zapis bazy obejmuje tylko `input/mm-cars-rental-rates-inclusive-fp.xlsx` oraz
`input/baseline-manifest.json`; przy dodawaniu lokalizacji dodatkowo tylko
`locations.config.json` i `input/broker-markup-frozen.json`.
Publikacja zasad wymaga zgodnosci HEAD, konfiguracji, bazy i szkicu.
Dziennik zamiaru zatwierdzenia powstaje przed zapisem GitHub, aby
utrata odpowiedzi sieciowej nie zgubila tozsamosci zatwierdzajacego.

## Harmonogram scrapera

Istniejacy Worker uruchamia workflow `discovercars-daily.yml` na `main`:
09:37 Europe/Warsaw dla 20 dni i 18:07 dla 45 dni (raport nastepnego poranka).
Cron Cloudflare wywoluje lekki handler co minute, lecz GitHub jest odpytywany
tylko przez 30 minut po kazdej z tych godzin. Strefa Europe/Warsaw uwzglednia
zmiane czasu. Harmonogram GitHuba pozostaje zapasowym wyzwalaczem.

`SCRAPER_SCHEDULE_ENABLED=true` aktywuje wywolania. Uzywane sa juz istniejace
sekrety GitHub App i ta sama instalacja ograniczona do tego repozytorium.
Nie powstaje publiczny endpoint uruchamiajacy scraper ani nowe uprawnienia.
Oddzielny obiekt koordynacyjny `prejsik/discovercars-tool:scheduler` zapisuje
zamiar przed wyslaniem zlecenia. Zadanie oczekujace nie jest duplikowane;
niejednoznaczna odpowiedz POST wymaga potwierdzenia istniejacego przebiegu.
Maksymalnie trzy proby po potwierdzonych zakonczeniach, co najmniej 5 minut
odstepu. Dopiero krok `Run scraper` potwierdza rzeczywisty start.
Brak startu przez 15 minut jest oznaczany w logach jako opoznienie.
Ostateczna blokada duplikatow pozostaje w gate workflow GitHuba.
Wywolanie z Cloudflare nie gwarantuje dostepnosci runnera GitHub.

## Lokalnie

```powershell
npm.cmd ci
npm.cmd run dev
```

Domyslnie `http://127.0.0.1:4317`. Przy zajetym porcie wybierz inny przez
`-- --port 4319`. Nie wystawiaj Vite ani katalogu `dist` przez publiczny tunel:
lokalny serwer nie ma logowania. Nie dodawaj `.local` do GitHuba.

## Weryfikacja

```powershell
npm.cmd test
npm.cmd run test:engine
npm.cmd run test:worker
npm.cmd run test:storage
npm.cmd run test:ui
npm.cmd run check:deploy
```

Testy UI wymagaja uruchomionego lokalnego Vite i Playwright z glownego projektu.
Uzywaja izolowanych profili i fixture API, nie kont zalogowanych pracownikow.
Testy silnika wymagaja Pythona z openpyxl. Test magazynu uruchamia lokalny
runtime Durable Objects i sprawdza konflikt zapisu oraz trwalosc po restarcie.
`check:deploy` jest tylko buildem i dry-runem; nie publikuje do Cloudflare.
Testy calego scrapera i Excela uruchamia sie rowniez w katalogu glownym.

Stan aktywacji i ograniczenia weryfikacji opisuje `VERIFICATION.md`.
