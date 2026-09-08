import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { cpus, totalmem, release } from "node:os";
import { expect, test } from "@playwright/test";
import { expectCurrentProject } from "./project-switcher";

const require = createRequire(import.meta.url);
const { _electron: electron } = require(require.resolve("playwright", { paths: [dirname(require.resolve("@playwright/test"))] }));
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
test("B00 complete editor basic CFR playback and seek (not standalone probe)", async () => {
  test.skip(process.env.AIVS_PERF_RUN !== "1", "Explicit benchmark entry only; not an ordinary E2E load");
  const output = process.env.AIVS_PERF_RESULT!;
  const fixtures = process.env.AIVS_PERF_FIXTURES!;
  const manifest = JSON.parse(await readFile(join(fixtures, "manifest.json"), "utf8"));
  const fixture = manifest.fixtures.F01;
  if (fixture.file !== "F01.mp4") throw new Error("Unexpected fixture filename");
  const media = join(fixtures, fixture.file);
  expect(createHash("sha256").update(await readFile(media)).digest("hex")).toBe(fixture.sha256);
  const runs = Number(process.env.AIVS_PERF_RUNS ?? 5);
  const seeks = Number(process.env.AIVS_PERF_SEEKS ?? 100);
  const seconds = Number(process.env.AIVS_PERF_PLAY_SECONDS ?? 300);
  test.setTimeout(((2 * runs + 1) * (seconds + seeks * 10 + 150) + 300) * 1000);
  const results: unknown[] = [];
  const config = JSON.parse(await readFile(join(output, "run-config.json"), "utf8"));
  // Separate launches permit opt-in diagnostics overhead A/B. First run is warmup only.
  for (let runIndex = -1; runIndex < runs; runIndex++) {
    for (const enabled of runIndex < 0 ? [true] : [false, true]) {
      const runDir = join(output, `${runIndex < 0 ? "warmup" : `run-${runIndex}`}-${enabled ? "on" : "off"}`);
      await mkdir(runDir, { recursive: true });
      const app = await electron.launch({ args: [join(root, "apps/desktop/out/main/index.cjs"), `--user-data-dir=${join(runDir, "user-data")}`],
        cwd: join(root, "apps/desktop"), env: { ...process.env,
          AIVS_RESOURCES_PATH: join(root, "resources"), AIVS_E2E_ASSET_PATHS: JSON.stringify({ video: media }),
          AIVS_SIDECAR_EXECUTABLE: join(root, ".venv/Scripts/python.exe"),
          AIVS_SIDECAR_EXECUTABLE_ARGS: JSON.stringify(["-m", "aivs_core.bootstrap"]),
          AIVS_PERF_METRICS: enabled ? "1" : "0", AIVS_PERF_OUTPUT: join(runDir, "core.json"),
          PYTHONPATH: join(root, "services/core/src"), ELECTRON_RUN_AS_NODE: undefined, NODE_OPTIONS: undefined,
        } });
      let sample: any;
      let setupRecoveryCount = 0;
      try {
        const page = await app.firstWindow();
        await page.waitForFunction(() => Boolean(window.desktop?.getRuntime));
        await page.evaluate(() => window.desktop.getRuntime());
        await page.waitForFunction(() => Boolean((window as any).__editorPerf));
        await page.evaluate(on => (window as any).__editorPerf.configure(on), enabled);
        const started = Date.now();
        await page.evaluate(async () => {
          const project = await window.desktop.createProject({ name: "B00 benchmark" });
          const imported = await window.desktop.importAsset({ project_id: project.project_id, kind: "video" });
          if (!imported) throw new Error("Fixture import cancelled");
          await window.desktop.createTimeline({ project_id: project.project_id, timeline: { schema_version: 1,
            source: { kind: "full_asset", asset_id: imported.asset.asset_id }, default_layout: "fit", caption_preset_id: "default-bottom" } });
          return project.project_id;
        });
        await expectCurrentProject(page, "B00 benchmark");
        await page.reload();
        await page.waitForFunction(() => Boolean((window as any).__editorPerf));
        await page.evaluate(on => (window as any).__editorPerf.configure(on), enabled);
        await expectCurrentProject(page, "B00 benchmark");
        // Baseline bug: media tickets can race project loading. Allow ONE explicit UI
        // recovery, recorded separately; never silently count it as a clean cold start.
        await expect.poll(async () => {
          if (await page.getByRole("button", { name: "重试合成预览", exact: true }).isVisible()) return "fallback";
          return (await page.getByLabel("预览状态", { exact: true }).textContent()) === "合成预览" ? "ready" : "loading";
        }, { timeout: 60000 }).not.toBe("loading");
        const retry = page.getByRole("button", { name: "重试合成预览", exact: true });
        if (await retry.isVisible()) { setupRecoveryCount++; await retry.click(); }
        await expect(page.locator(".synthetic-canvas")).toBeVisible({ timeout: 60000 });
        await expect(page.getByLabel("预览状态", { exact: true })).toHaveText("合成预览", { timeout: 60000 });
        // Require an advancing ready preview, not merely an allocated canvas.
        await page.getByRole("button", { name: "播放", exact: true }).click();
        await expect.poll(async () => Number(await page.getByRole("slider", { name: "时间线播放头" }).getAttribute("aria-valuenow")), { timeout: 30000 }).toBeGreaterThan(500000);
        await page.getByRole("button", { name: "暂停", exact: true }).click();
        const readyMs = Date.now() - started;
        await page.evaluate(() => (window as any).__editorPerf.reset());
        const seekActions: number[] = [];
        const slider = page.getByRole("slider", { name: "时间线播放头" });
        const box = await slider.boundingBox(); if (!box) throw new Error("No timeline slider");
        let seed = 20260908;
        for (let i = 0; i < seeks; i++) {
          seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
          const at = Date.now();
          await slider.click({ position: { x: 1 + (seed / 2**32) * (box.width - 2), y: box.height / 2 } });
          // Fixed interval is part of the workload, NOT a measured frame presentation time.
          await page.waitForTimeout(300);
          seekActions.push(Date.now() - at);
        }
        const seekMetrics = await page.evaluate(() => (window as any).__editorPerf.snapshot());
        await page.evaluate(() => (window as any).__editorPerf.reset());
        const processSamples: unknown[] = [];
        const stopAt = Date.now() + (runIndex < 0 ? Math.min(seconds, 5) : seconds) * 1000;
        while (Date.now() < stopAt) {
          const play = page.getByRole("button", { name: "播放", exact: true });
          if (await play.isVisible()) await play.click();
          await page.waitForTimeout(1000);
          processSamples.push(await app.evaluate(({ app: mainApp }) => mainApp.getAppMetrics().map(item => ({ pid: item.pid, type: item.type, cpu: item.cpu, memory: item.memory }))));
        }
        const pause = page.getByRole("button", { name: "暂停", exact: true });
        if (await pause.isVisible()) await pause.click();
        const playbackMetrics = await page.evaluate(() => (window as any).__editorPerf.snapshot());
        expect(seekMetrics.enabled).toBe(enabled);
        expect(playbackMetrics.enabled).toBe(enabled);
        if (enabled) {
          expect(seekMetrics.counts.seek ?? 0).toBeGreaterThan(0);
          expect(playbackMetrics.counts.submitted ?? 0).toBeGreaterThan(0);
        } else {
          expect(seekMetrics.events).toHaveLength(0);
          expect(playbackMetrics.events).toHaveLength(0);
        }
        const environment = await app.evaluate(async ({ app: mainApp, screen }) => ({ versions: process.versions, platform: process.platform, arch: process.arch, gpu: await mainApp.getGPUInfo("basic"), refresh_hz: screen.getPrimaryDisplay().displayFrequency }));
        Object.assign(environment, { cpu_model: cpus()[0]?.model, logical_cpus: cpus().length, ram_bytes: totalmem(), os_release: release() });
        const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio, userAgent: navigator.userAgent }));
        sample = { schema_version: 1, scenario: "F01/basic-cfr", run: runIndex, enabled, ready_ms: readyMs, setup_recovery_count: setupRecoveryCount,
          workload: { seeks, seed: 20260908, build_mode: "production-diagnostics", code_fingerprint: config.code_fingerprint },
          seek_action_wall_ms_including_300ms_wait: seekActions, seek: seekMetrics, playback: playbackMetrics, process_samples: processSamples,
          environment, viewport, fixture_sha256: fixture.sha256, playback_seconds: seconds,
          scope: "complete App, source CFR, no PiP/captions; app cold launch + warm seeks; OS cache uncontrolled",
          unavailable: ["actual presentation", "React commits in non-profiling production React", "audio underrun", "video-frame lifetime", "GPU actual VRAM", "Core RSS", "30–60min memory", "F01 historical parity", "F02–F07"] };
        // Screenshot outside timing region; no readback in measured playback.
        await page.screenshot({ path: join(runDir, "editor.png") });
      } catch (error) {
        // Do not persist exception text: decoder failures can include media tickets/paths.
        await writeFile(join(runDir, "failure.json"), JSON.stringify({ schema_version: 1, run: runIndex, enabled,
          status: "invalid-incomplete", error_type: error instanceof Error ? error.name : "unknown", setup_recovery_count: setupRecoveryCount }, null, 2));
        throw error;
      } finally {
        try { await app.close(); } finally {
        if (sample) { await writeFile(join(runDir, "result.json"), JSON.stringify(sample, null, 2)); results.push(sample); }
        await writeFile(join(output, "results.json"), JSON.stringify(results, null, 2));
        }
      }
    }
  }
});


