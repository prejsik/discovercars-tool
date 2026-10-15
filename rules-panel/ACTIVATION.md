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
- Worker wdrozony: `8f7dbf00-1fef-43da-8b4e-76ed51c818ca`.
- Migracja prywatnego magazynu wdrozona; zapis pozostaje wylaczony.
- `ACCESS_EMAILS` jest sekretem. Zalogowana sesja odczytuje nowy panel;
  anonimowy dostep do strony, API i snapshotu przekierowuje do Access.
- GitHub App nie jest jeszcze podlaczona: wymagane logowanie wlasciciela
  w przegladarce. Nie zmieniono zasad, stawek, bazy ani harmonogramow.
