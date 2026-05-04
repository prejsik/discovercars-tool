DiscoverCars Tool - quick start
===============================

1) Run setup once:
   - double click: setup.bat

2) Run the tool:
   - double click: start.bat

3) In the window:
   - choose rental durations (you can select many),
   - choose pickup start dates:
     range From-To creates all dates automatically,
     or paste many specific dates at once,
   - choose speed mode:
     fast = quicker default test,
     safe = previous stable behavior,
     turbo = most aggressive,
   - click Run.

Notes:
- Output tables are printed in the console window.
- JSON result is saved automatically in:
  output\results-YYYYMMDD-HHMMSS.json
  output\results-latest.json
- If the run is interrupted, the next run resumes automatically
  from the checkpoint (output\state.json).
- If fast/turbo gives worse results, run again and choose safe.
