import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { test } from "@playwright/test";

const require = createRequire(import.meta.url);
const playwright = require(require.resolve("playwright", { paths: [dirname(require.resolve("@playwright/test"))] })) as { _electron: { launch: (o: Record<string, unknown>) => Promise<any> } };
const electron = playwright._electron;
const currentDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(currentDir, "..", "..", "..");
const desktop = resolve(currentDir, "..");
const resources = join(root, "resources");
const fixture = process.env.AIVS_PROBE_MEDIA ?? "";
const label = process.env.AIVS_PROBE_LABEL ?? "diag";
// P203 复测（2026-11-05）：代理就绪等待窗。默认 0 = 原行为（导入即测，不等代理）；
// >0 时在点播放前轮询 getPreviewSource 直到 mode=proxy，用于判定「代理生效后是否仍挂死」。
const waitProxyMs = Number(process.env.AIVS_PROBE_WAIT_PROXY ?? "0");
// 单次 page.evaluate 的硬上限：主线程被堵死时 evaluate 会永久 pending（无内置超时），
// 原实现 Promise.resolve("EVAL_BLOCKED") 恒先完成，竞速形同虚设。
const evalCapMs = Number(process.env.AIVS_PROBE_EVAL_CAP_MS ?? "2000");

test(`diag: ${label}`, async () => {
  test.setTimeout(Number(process.env.AIVS_PROBE_TIMEOUT_MS ?? String(180_000)));
  // 跳过而非失败：本探针需要真实素材，由 AIVS_PROBE_MEDIA 指定；未设或文件不在时跳过。
  test.skip(!existsSync(fixture), "requires AIVS_PROBE_MEDIA to point at a real media fixture");
  const dir = join(root, "test-results", `diag-${label}-${process.pid}`);
  await mkdir(join(dir, "user-data"), { recursive: true });
  const env = { ...process.env,
    AIVS_RESOURCES_PATH: resources, AIVS_E2E_MEDIA_PATH: fixture,
    AIVS_E2E_ASSET_PATHS: JSON.stringify({ video: fixture }),
    AIVS_SIDECAR_EXECUTABLE: join(root, ".venv", "Scripts", "python.exe"),
    AIVS_SIDECAR_EXECUTABLE_ARGS: JSON.stringify(["-m", "aivs_core.bootstrap"]),
    PYTHONPATH: [join(root, "services", "core", "src"), process.env.PYTHONPATH].filter(Boolean).join(";"),
    ELECTRON_RUN_AS_NODE: undefined, NODE_OPTIONS: undefined };
  const app = await electron.launch({ args: [join(desktop, "out", "main", "index.cjs"), `--user-data-dir=${join(dir, "user-data")}`], cwd: desktop, env });
  const evidence: Record<string, unknown> = { label, fixture, waitProxyMs, evalCapMs };
  try {
    const page = await app.firstWindow();
    const logs: string[] = [];
    page.on("console", m => logs.push(`[${m.type()}] ${m.text().slice(0, 400)}`));
    page.on("pageerror", e => logs.push(`[pageerror] ${String(e).slice(0, 600)}`));
    // 有界 evaluate：主线程堵死时返回 EVAL_BLOCKED，而不是让整轮测试挂到用例超时。
    const bounded = async (body: any, arg?: any, capMs = evalCapMs): Promise<any> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cap = new Promise<string>(res => { timer = setTimeout(() => res("EVAL_BLOCKED"), capMs); });
      try {
        const call = arg === undefined ? page.evaluate(body) : page.evaluate(body, arg);
        return await Promise.race([call as Promise<any>, cap]);
      } catch (error) {
        return `EVAL_ERROR: ${String(error).slice(0, 200)}`;
      } finally { if (timer) clearTimeout(timer); }
    };
    await page.waitForFunction(() => Boolean((window as any).desktop?.getRuntime));
    await page.evaluate(() => (window as any).desktop.getRuntime());
    await page.getByRole("tab", { name: "素材", exact: true }).waitFor({ timeout: 30_000 });
    // 装探针：记录点击后主线程是否还能响应 + 解码器状态
    await page.evaluate(() => {
      const w = window as any;
      w.__DIAG = { before: performance.now(), after: 0, heartbeats: 0 };
      // title 镜像：document.title 由渲染进程主线程写、由**浏览器进程**缓存并经 IPC
      // 推送，主进程 getTitle() 读取无需渲染进程配合。主线程真堵死 ⇒ title 冻结；
      // 主线程活着而 CDP evaluate 超时 ⇒ 是 CDP 通道被饿死，不是应用挂死。
      // 同时镜像 composed_frames：标题推进即证明「画面还在合成」。
      setInterval(() => {
        w.__DIAG.heartbeats += 1;
        const m = w.__aivsPreviewMetrics;
        document.title = "hb:" + w.__DIAG.heartbeats
          + "|cf:" + (m ? m.composed_frames : -1)
          + "|df:" + (m ? m.dropped_frames : -1)
          + "|be:" + (m && m.decode_backend ? m.decode_backend : "-")
          + "|hm:" + (m && m.hdr_media === true ? 1 : 0);
      }, 100);
    });
    // 主进程侧观测（不经渲染进程）：崩溃与否 + 标题镜像。CDP evaluate 被饿死时
    // 这条通道仍然可用，用于把「应用挂死」和「探针失真」区分开。
    const readMain = async (): Promise<any> => {
      try {
        return await app.evaluate(({ BrowserWindow }) => {
          const wins = BrowserWindow.getAllWindows();
          return wins.map(w => ({
            title: w.getTitle(),
            crashed: w.webContents.isCrashed(),
            destroyed: w.webContents.isDestroyed(),
            responsive: (w.webContents as any).isCurrentlyAudible ? true : true,
            url: String(w.webContents.getURL()).slice(0, 50),
          }));
        });
      } catch (error) { return "MAIN_EVAL_ERROR: " + String(error).slice(0, 200); }
    };
    const projectName = `Diag ${label}`;
    await page.getByRole("button", { name: "切换项目" }).click();
    await page.getByRole("listbox", { name: "选择项目" }).getByRole("menuitem", { name: "项目管理" }).click();
    await page.getByLabel("新项目名称").fill(projectName);
    await page.getByLabel("新建项目画布比例").selectOption("169");
    await page.getByRole("button", { name: "创建项目" }).click();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "导入视频" }).click();
    const assetName = fixture.split(/[\\/]/).pop()!;
    await page.locator(".asset-row").filter({ hasText: assetName }).waitFor({ timeout: 120_000 });
    // 素材/项目 id（供代理作业与预览源查询）
    const ids = await page.evaluate(async ({ name, project }: any) => {
      const w = window as any;
      const projects = await w.desktop.listProjects({ limit: 100 });
      const hit0 = projects.items.find((i: any) => i.name === project);
      const list = await w.desktop.listAssets({ project_id: hit0.project_id, limit: 100 });
      const hit = list.items.find((i: any) => i.asset.display_name === name);
      return { project_id: hit0.project_id, asset_id: hit.asset.asset_id };
    }, { name: assetName, project: projectName });
    evidence.ids = ids;
    console.log(`[diag] ids = ${JSON.stringify(ids)}`);
    // 测量 (1)(2)：代理作业状态 + sourceResolver 同一 IPC 的解析结果（mode=auto）。
    const probeSource = async (tag: string) => {
      const snap = await bounded(async ({ project_id, asset_id }: any) => {
        const w = window as any;
        const out: any = { at: Math.round(performance.now()), heartbeats: w.__DIAG?.heartbeats ?? -1 };
        try {
          const src = await w.desktop.getPreviewSource({ project_id, asset_id, mode: "auto" });
          out.preview_source = { status: src.status, mode: src.mode, job_id: src.job_id,
            cache_key: src.cache_key ? src.cache_key.slice(0, 12) : null, profile_id: src.profile_id,
            coded_width: src.coded_width, coded_height: src.coded_height, rotation: src.rotation };
        } catch (error) { out.preview_source_error = String(error).slice(0, 240); }
        try {
          const statuses = ["queued", "running", "succeeded", "failed", "cancelling", "cancelled", "interrupted"];
          const pages = await Promise.all(statuses.map((s: string) =>
            w.desktop.listJobs({ project_id, status: s, limit: 50 }).catch((e: any) => ({ items: [], error: String(e).slice(0, 120) }))));
          out.proxy_jobs = pages.flatMap((p: any) => p.items ?? [])
            .filter((j: any) => j.kind === "proxy" && j.asset_id === asset_id)
            .map((j: any) => ({ job_id: j.job_id, status: j.status, stage: j.stage, progress: j.progress,
              error: j.error ? String(j.error.message ?? j.error).slice(0, 200) : null, updated_at: j.updated_at }));
        } catch (error) { out.jobs_error = String(error).slice(0, 240); }
        return out;
      }, ids, 4000);
      console.log(`[diag] ${tag} = ${JSON.stringify(snap)}`);
      return snap;
    };
    const initialSource = await probeSource("source@import");
    evidence.sourceAtImport = initialSource;
    await page.evaluate(async ({ name, project }: any) => {
      const w = window as any;
      const canvas = document.querySelector('canvas[aria-label="时间线画布"]') as HTMLCanvasElement;
      const rect = canvas.getBoundingClientRect();
      const projects = await w.desktop.listProjects({ limit: 100 });
      const hit0 = projects.items.find((i: any) => i.name === project);
      const list = await w.desktop.listAssets({ project_id: hit0.project_id, limit: 100 });
      const hit = list.items.find((i: any) => i.asset.display_name === name);
      const tr = new DataTransfer();
      tr.setData("application/x-vortex-cut-asset", hit.asset.asset_id);
      const y = rect.top + Math.min(112, rect.height - 8);
      canvas.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: tr, clientX: rect.left + 200, clientY: y }));
      canvas.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: tr, clientX: rect.left + 200, clientY: y }));
    }, { name: assetName, project: projectName });
    await page.getByLabel("预览比例").selectOption("169");
    const ready = await page.evaluate(() => Boolean((window as any).__aivsPreviewMetrics));
    console.log(`[diag] metrics ready before play = ${ready}`);
    // 等待代理就绪（可选）：代理生成是 ffmpeg 整段转码，远长于一次导入；
    // 不等就无法回答「代理生效后是否仍挂死」。等待期间主线程应是空闲的。
    if (waitProxyMs > 0) {
      const deadline = Date.now() + waitProxyMs;
      const timeline: unknown[] = [];
      let proxyReady = false;
      while (Date.now() < deadline) {
        const snap = await probeSource("source@wait" + timeline.length);
        timeline.push(snap);
        const ps = (snap as any)?.preview_source;
        if (ps?.status === "ready" && ps?.mode === "proxy") { proxyReady = true; break; }
        await page.waitForTimeout(3000);
      }
      evidence.proxyWait = { proxyReady, polls: timeline.length, timeline };
      console.log(`[diag] proxyReady = ${proxyReady} after ${timeline.length} polls`);
      if (proxyReady) {
        // 代理就绪 → App 失效解析缓存并 bump proxyReadyEpoch → 会话自然切换点重建。
        // 留出重建余量，并等 __aivsPreviewMetrics 反映出新会话（hdr_media 归零即代理生效）。
        for (let i = 0; i < 10; i++) {
          await page.waitForTimeout(1000);
          const hm = await bounded(() => {
            const m = (window as any).__aivsPreviewMetrics;
            return m ? { hdr_media: m.hdr_media, decode_backend: m.decode_backend, last_error: m.last_error, at: Math.round(m.at) } : null;
          }, undefined, 4000);
          console.log(`[diag] post-proxy metrics +${i + 1}s = ${JSON.stringify(hm)}`);
          if (hm && typeof hm === "object" && (hm as any).hdr_media === false && (hm as any).decode_backend) break;
        }
      }
    }
    const sourceBeforePlay = await probeSource("source@before-play");
    evidence.sourceBeforePlay = sourceBeforePlay;
    const hb0 = await page.evaluate(() => (window as any).__DIAG.heartbeats);
    console.log(`[diag] heartbeats before click = ${hb0}`);
    console.log(`[diag] main before click = ${JSON.stringify(await readMain())}`);
    const playStartedAt = Date.now();
    // **不 await click**：用 race 让点击与心跳采样并行
    const clickPromise = page.getByRole("button", { name: "播放", exact: true }).click({ timeout: 60_000 }).then(() => "clicked").catch(e => `click-error: ${String(e).slice(0, 120)}`);
    const samples: unknown[] = [];
    for (let i = 0; i < 12; i++) {
      await page.waitForTimeout(1500);
      const t0 = Date.now();
      const st = await bounded(() => {
        const w = window as any;
        const m = w.__aivsPreviewMetrics ?? null;
        return { hb: w.__DIAG.heartbeats, metrics: Boolean(m),
          decode_backend: m?.decode_backend ?? null, decode_ms_p50: m?.decode_ms_p50 ?? null,
          decode_ms_p95: m?.decode_ms_p95 ?? null, dropped_frames: m?.dropped_frames ?? null,
          composed_frames: m?.composed_frames ?? null, last_error: m?.last_error ?? null,
          hdr_media: m?.hdr_media ?? null, at: m ? Math.round(m.at) : null };
      });
      const main = await readMain();
      samples.push({ elapsedMs: Date.now() - playStartedAt, evalTookMs: Date.now() - t0, probe: st, main });
      console.log(`[diag] +${(i + 1) * 1.5}s probe = ${JSON.stringify(st)}`);
      console.log(`[diag] +${(i + 1) * 1.5}s main  = ${JSON.stringify(main)}`);
    }
    evidence.playSamples = samples;
    const clickResult = await Promise.race([clickPromise, Promise.resolve("still-pending")]);
    console.log(`[diag] click result = ${clickResult}`);
    evidence.clickResult = clickResult;
    // 测量 (4)：能播时的解码口径（最终快照）。
    const finalMetrics = await bounded(() => {
      const m = (window as any).__aivsPreviewMetrics ?? null;
      if (!m) return null;
      return { hb: (window as any).__DIAG?.heartbeats ?? -1, decode_backend: m.decode_backend,
        decode_hardware: m.decode_hardware, decode_ms_p50: m.decode_ms_p50, decode_ms_p95: m.decode_ms_p95,
        dropped_frames: m.dropped_frames, composed_frames: m.composed_frames, last_error: m.last_error,
        hdr_media: m.hdr_media, hdr_decodable: m.hdr_decodable, task_ms_p50: m.task_ms_p50,
        task_ms_p95: m.task_ms_p95, chain: m.chain ?? null, at: m.at ? Math.round(m.at) : null };
    }, undefined, 6000);
    console.log(`[diag] finalMetrics = ${JSON.stringify(finalMetrics)}`);
    evidence.finalMetrics = finalMetrics;
    const sourceAfterPlay = await probeSource("source@after-play");
    evidence.sourceAfterPlay = sourceAfterPlay;
    const hb1 = await bounded(() => (window as any).__DIAG.heartbeats, undefined, 6000);
    evidence.heartbeats = { before: hb0, after: hb1 };
    console.log(`[diag] heartbeats after = ${JSON.stringify(hb1)}`);
    await writeFile(join(dir, "console.log"), logs.join("\n"), "utf8");
    await writeFile(join(dir, "probe.json"), JSON.stringify(evidence, null, 2), "utf8");
    console.log(`[diag] console lines captured = ${logs.length}; saved to ${join(dir, "console.log")}`);
    console.log(`[diag] evidence saved to ${join(dir, "probe.json")}`);
  } finally { await writeFile(join(dir, "probe.json"), JSON.stringify(evidence, null, 2), "utf8").catch(() => undefined); await app.close(); }
});
