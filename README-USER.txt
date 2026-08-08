DiscoverCars - szybki start
===========================

1) Jednorazowa instalacja:
   - kliknij dwukrotnie setup.bat

2) Uruchomienie narzędzia:
   - kliknij dwukrotnie start.bat

3) W oknie:
   - wybierz długości najmu; możesz zaznaczyć kilka,
   - wybierz daty rozpoczęcia najmu:
     zakres tworzy automatycznie wszystkie dni od daty „Od” do „Do”,
     albo wybierz konkretne dni w kalendarzu lub wklej ich listę,
     ponowne kliknięcie dnia usuwa go z listy,
   - wybierz tryb działania:
     fast = zalecany i szybszy,
     safe = wolniejszy, stabilny tryb,
     turbo = najbardziej agresywny,
   - kliknij „Uruchom”.

Ważne:
- Tabele wynikowe są wyświetlane w oknie konsoli.
- Po zakończeniu najnowszy raport HTML otwiera się automatycznie.
- Wynik JSON zapisuje się automatycznie w:
  output\results-YYYYMMDD-HHMMSS.json
  output\results-latest.json
- Raport HTML zapisuje się w:
  output\report-YYYYMMDD-HHMMSS.html
  output\report.html
- Po przerwaniu kolejny run wznawia pracę z pliku output\state.json.
- Jeśli fast lub turbo daje gorsze wyniki, uruchom ponownie w trybie safe.
