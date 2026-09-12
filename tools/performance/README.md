# B00 performance tooling — partial implementation

## Status / scope

This is a **complete-App smoke/measurement harness**, not the historical standalone preview probe.
B00 is **not complete and G0 is not approved**. The supported scene is `F01/basic-cfr`
(single synthetic 12-second CFR clip), NOT the historical F01 PiP/speed/non-aligned-width recipe.
The runner rejects F02–F07 instead of relabeling this simple scene.

No Provider calls, network downloads, real user database, package build, commit or push are required.
Every Electron launch uses a new benchmark-owned user-data directory. Existing output is never overwritten.
Generated media/screenshots/user-data are ignored by Git; JSON and this documentation are reviewable.
Do not publish user-data logs/traces: unlike diagnostic event JSON, application logs can contain local paths.

## Reproduce (PowerShell, repository root)

```powershell
Set-Location C:\DataFolder\codes\AI-Vidio
# Use NEW names below, or reuse the existing immutable fixture manifest.
.venv\Scripts\python.exe tools/performance/make_fixtures.py --scenarios F01 --output evidence/performance/my-fixtures --seed 20260908
$env:VITE_AIVS_PERF = '1'
try { pnpm --filter @aivideo/desktop build } finally { Remove-Item Env:VITE_AIVS_PERF }
node tools/performance/run_editor_benchmark.mjs --fixtures evidence/performance/my-fixtures --output evidence/performance/my-smoke --runs 1 --seeks 3 --playback-seconds 5 --smoke
# Longer workload; still PARTIAL B00, not G0 even if this passes:
node tools/performance/run_editor_benchmark.mjs --fixtures evidence/performance/my-fixtures --output evidence/performance/my-measurement --runs 5 --seeks 100 --playback-seconds 300
# Restore ordinary production build after benchmarking:
pnpm --filter @aivideo/desktop build
pnpm --filter @aivideo/desktop verify:probe-isolation
```

Electron and project Python may require approval to launch outside the desktop filesystem sandbox.
Rebuild after modifying renderer sources: the runner launches compiled output, NOT the development server.
It records source fingerprint but does not prove that an existing build matches those sources.
Record builds and runs together; never compare evidence from an unknown/stale build.

`make_fixtures.py` can generate raw media for F02/F03/F04/F05/F07, but these are NOT complete
scene recipes. F02/F03/F05 generation requires `--allow-large` and free space, and is not run by default.
No F06 ASR/model download is performed. Fixture generation is reproducible with the same bundled
FFmpeg toolchain and seed; SHA256 must match before importing. Different encoder/toolchain output
must not silently inherit the same benchmark baseline.

## Workload and validity

- One diagnostic-on warmup launch, then `runs` off/on launch pairs. Warmup playback is at most 5s.
- Each launch creates/imports a fixture project, reloads the real App and restores diagnostics.
- The harness verifies synthetic preview status and advancing playhead before timing seeks.
- An existing project-load ticket race may trigger fallback. At most one explicit **UI retry** is
  allowed; `setup_recovery_count` records it. Recovered and clean launches are not interchangeable.
- Seeded slider clicks are spaced by 300ms; action wall time **includes this wait**, and is not seek latency.
- Internal seek duration ends at decode/upload readiness before compose submission; it is NOT click-to-photon.
- A click may invoke more than one internal seek. Requested click count and completed seek count differ.
- Playback is wall-clock time, restarting the 12-second clip on end. This is not a 30-second source fixture.
- Seeks and playback get separate event windows. Cumulative counts/duration totals survive ring overflow,
  but reset between phases. Worker acknowledgements from older reset generations are discarded.
- Renderer ring: 4096 numeric events. Unacknowledged compose correlation: maximum 512 entries.
  Dropped correlation entries mean counts can have fewer submissions than compose requests; not GPU loss.
- Core ring: 4096 events with cumulative stage counts. Flushes a snapshot every ~5s via a thread and atomic
  replacement, plus graceful lifespan flush. Forced Windows termination can omit the last interval.
- Electron process CPU/memory are sampled at ~1Hz through Main; Core subprocess is not included.
  Windows working-set values are NOT interchangeable with RSS/VRAM, and shared pages must not be double-counted.
- Source fingerprint, runtime/OS/CPU/RAM/GPU info/refresh rate, viewport/DPR, fixture SHA are retained.
  “Cold” means fresh application user-data, not cleared OS disk cache.
- Screenshot is captured after timed playback, never during it. UI readiness/clock advancement is not proof
  of correct displayed pixels; visual parity requires separate readback/reference checks.
- Errors write `failure.json` with a safe error type, not raw exception text. Incomplete runs abort the workload;
  previously finished runs can remain in `results.json` and MUST NOT imply a complete baseline.

## Diagnostics interface

Only a `VITE_AIVS_PERF=1` build exposes `window.__editorPerf`:

```javascript
window.__editorPerf.configure(true);
window.__editorPerf.reset();
window.__editorPerf.snapshot();
window.__editorPerf.configure(false);
```

Ordinary builds expose no endpoint; diagnostics default off. No per-frame logging or Electron IPC
is added. Diagnostics ON adds a worker `submitted(seq)` acknowledgement after GL commands return.
**Submitted means a worker round trip, NOT GPU completion, display presentation, or actual FPS.**
No `gl.finish`, timed readback, credentials, media tickets, captions or Provider payloads are recorded.
Numeric event fields are kind/time/duration/session/request/epoch/frame/input; frame means source
frame for decode/upload, and timeline frame for compose/submitted/seek. IDs are process-local, not
cross-process timestamps or globally unique IDs. React production builds without profiling callbacks
report commit data unavailable, not zero commits.

## Comparing results

```powershell
.venv\Scripts\python.exe tools/performance/compare_results.py --baseline evidence/performance/baseline --candidate evidence/performance/candidate --output evidence/performance/comparison.md
```

The report uses non-warmup diagnostic-on runs and compares median per-run retained-window p95.
It rejects disabled/mislabeled snapshots and incompatible environment, fixture, viewport, workload,
duration or setup-recovery counts. A missing distribution is `unavailable`, never a zero latency.
This is exploratory, not a significance test or gate approval; a single run cannot establish improvement.
The tool currently compares the full GPU metadata object conservatively; incidental differences may
reject compatible hardware rather than risk an invalid percentage comparison.

## Remaining before G0

1. Historical F01 parity and actual F02–F07 scene assembly, IR fingerprints, audio/visual correctness checks.
2. Full-run unique/skip/freeze semantics excluding seek/buffering/repeats; audio underrun reporting.
3. VideoFrame/worker/object-URL lifetime and estimated texture bytes, Core process resources,
   Canvas layer-specific counts, supported React profiling build and request-queue wait metrics.
4. Presentation trace/proxy calibration, completed-request vs attempted-request statistics,
   automatic per-process teardown verification, and complete-run manifest validation.
5. 5 repetitions × 100 seeks, 5min playback, 30–60min memory tests on frozen representative hardware.
6. Proper paired off/on overhead analysis (<3% median): fixed-wait action timings or one smoke pair
   cannot validate overhead. Fixed off/on ordering and OS cache effects must be accounted for.
7. Independent verification and consensus under AGENTS.md. No G0 approval is implied by passing tests.
