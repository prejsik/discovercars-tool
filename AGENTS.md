# Zasady dla agentów (Codex i Claude Code)

Ten plik czytają oba narzędzia; `CLAUDE.md` tylko go importuje. Repozytorium jest publiczne.

## Folder i zakres

- Jedyny folder roboczy tego repo to `discovercars-tool`. Folder `Scrapper` obok to stara kopia z sierpnia 2026 z niezapisanymi resztkami: kod rozwijaj i commituj tylko tutaj.
- `src/rentcars/`, `RENTCARS_README.md` i workflow „RentCars manual run” to kopia RentCars z czerwca 2026. Aktualny RentCars jest w repo `prejsik/MMSL-Scrapper-Rentcars`.
- Działanie i polityka cen: `README.md` i `DISCOVERCARS_README.md`. Panel zasad (Cloudflare Worker): `rules-panel/`.

## Co uruchamia scalenie

- „DiscoverCars daily run” startuje z `main` codziennie rano i wieczorem: pobiera ceny, przygotowuje rekomendacje do arkusza stawek, publikuje raport na GitHub Pages i wysyła podsumowanie na Telegram. Scalona zmiana działa od najbliższego przebiegu.
- Zmiana rekomendacji, minimów, narzutów lub plików w `input/` wpływa na ceny MM Cars Rental: to wysokie ryzyko. Po zielonym CI zapytaj użytkownika przed scaleniem.
- `gh workflow run` i wdrożenie `rules-panel` (Wrangler) uruchamiaj tylko na wyraźną prośbę.

## Testy

- Lokalnie: `npm test` (Node i Python); pełny zestaw: `npm run test:all`.
- Na GitHubie „DiscoverCars regression tests” uruchamia się dla każdego PR.

## Publiczne repo

Wyniki (`output/`, `artifacts/`), sekrety i dane osobowe zostają poza commitami. Konfiguracja z sekretami trafia do repo tylko jako `*.example.json`.
