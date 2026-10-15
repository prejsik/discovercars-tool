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
4. Uruchom podglad. Porownanie uzywa istniejacego silnika i danych cenowych,
   bez uruchamiania scrapera. Zakres dowodow i ograniczenia sa jawne.
5. Zatwierdz tylko swiezy, poprawny podglad tej samej wersji szkicu i bazy.
   Zapis na `main` jest atomowy, bez force push. Nastepny run korzysta z zasad
   ze swojego checkoutu; trwajacy run nie zmienia zasad w polowie pracy.

Przywrocenie historii tworzy nowy szkic wymagajacy sprawdzenia i zatwierdzenia.
Nie cofa GitHuba ani pliku bazowego automatycznie. Historia widoczna w panelu
obejmuje ostatnie 50 zdarzen; wersje pozostaja w prywatnym magazynie.

## Granice edycji

Walidacja serwerowa dopuszcza tylko jawne pola zasad. Nie pozwala zmieniac
repozytorium, lokalizacji scrapera, narzutow brokera, parytetu klas, pliku
bazowego, harmonogramu ani dowolnych kluczy konfiguracji. Nowa macierz minimow
korzysta z `mandatoryScopedFloorsPlnDay`; zgodnosc liczenia sprawdzaja testy
JS i Python. Istniejace obowiazkowe minima i wykluczenia sa zachowane.

Zakres Excela pozostaje zgodny z konfiguracja produkcyjna: 100 dni, bez
przywracania dawnego limitu liczby wierszy. Podglad nie zmienia tej konfiguracji.
Zapis zasad nie oznacza zaimportowania nowych cen u brokera.

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
Kod ogranicza zapis do `pricing-rules.config.example.json`,
`excel-rate-update.config.example.json` i `rules-panel-publication.json`.
Publikacja wymaga zgodnosci HEAD, konfiguracji, bazy, szkicu oraz potwierdzonego
workflow. Dziennik zamiaru zatwierdzenia powstaje przed zapisem GitHub, aby
utrata odpowiedzi sieciowej nie zgubila tozsamosci zatwierdzajacego.

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
