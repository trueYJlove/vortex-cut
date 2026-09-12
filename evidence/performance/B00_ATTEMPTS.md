# B00 failed attempts (preserved, not baseline evidence)

- `b00-smoke-20260908-01`: sandbox launch failed; no valid complete-App measurement.
- `b00-smoke-20260908-02`: obsolete project selector timed out; no valid baseline.
- `b00-smoke-20260908-03`: warmup reloaded the App and accidentally disabled renderer diagnostics.
  Although sample.enabled was true, seek.enabled/playback.enabled were false; the sample is INVALID.
  The following off launch fell back to interactive preview due to a missing media ticket.
  This is an observed baseline issue, not fixed as part of B00. No timing from this directory proves performance.
- `b00-smoke-20260908-04`: valid basic-CFR harness smoke, 1 warmup + 1 off/on pair,
  3 click seeks and 5s playback; not historical F01, full B00 or G0. Superseded by the later build/run
  for reset-generation handling. Keep source fingerprint with each result.

Application logs in ignored isolated user-data are local debugging only; do not publish tokens/paths.
