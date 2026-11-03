# Operating design

## Direction
An operational pricing workbench for a daily review, following the approved
ui-redesign-3 mockups. Presentation only: no change to pricing, evidence sources,
publication gates, authentication, baseline, scraper or schedules.

## Structure
Four main sections: Pulpit, Ceny i rynek, Zasady cenowe, Baza i lokalizacje.
Price review defaults to a branch/date map; the branch table remains available.
A branch uses exact Excel bands 2, 3-4, 5-7 and 8-20 (market observations 8-14).
A side panel explains all observed durations, the base/import rates, and current
minimum separately from the historical Excel decision. No averaging of rates.
The calendar shows MM, competitor and absolute daily gap for each selected
duration. The dashboard uses the same loaded report as the market workspace.
Diagnostics and technical sources are disclosures; incident status remains
visible on the dashboard. Import/recommendations links retain their scoped IDs.

## Visual system
Local IBM Plex Sans 400/500/600 and IBM Plex Mono 500 for codes. Tabular numbers,
zero letter spacing, right-aligned numeric table columns. White and cool gray
surfaces, charcoal text, blue actions, yellow restricted to the brand symbol.
Active navigation is gray; tabs use an underline; segments use a dark selection.
Each surface has one primary action. Repeated metric items may have a 6px radius;
sections remain unframed with hairline separators.

## Price language
The source gap is competitor minus MM; presentation is always MM minus competitor.
Positive is MM more expensive, negative cheaper. Preserve the actual sign even
inside the neutral +/-5 PLN range. Colors accompany a sign, value or state label.
Missing MM means a confirmed missing offer; hatched question marks mean no
confirmed data. No inference of pricing permission from a market gap alone.
Dates use Polish labels and weekdays. Large changes use PLN and a multiplier
instead of very large percentages. Local browser storage is not described as
shared between users/computers.

## Interaction and evidence
Native buttons, links, disclosure and dialogs; focus-visible and keyboard tabs.
Side panels use a mobile modal bottom sheet; up/down selects adjacent days in
the same band, Escape closes. Desktop/mobile page must not scroll horizontally.
Only the branch/date map can scroll horizontally, with a sticky branch column.
Current rules (including draft) are not historical recommendation evidence.
Never substitute stale classes or mismatched runs; keep warnings, hashes,
confirmation gates and pinned Excel reuse. No new API endpoints or reads beyond
the existing shared market load.
