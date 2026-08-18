import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { expect, test } from "@playwright/test";

const installRoot = process.env.AIVS_STAGE3B_INSTALL_ROOT ?? "";
const video = process.env.AIVS_STAGE3B_SOURCE_VIDEO ?? "";
const runRoot = process.env.AIVS_STAGE3B_RUN_ROOT ?? "";
const packageAcceptanceConfigured = Boolean(installRoot && video && runRoot);
const exportsRoot = join(runRoot, "exports");
const userData = join(runRoot, "user-data");
const executable = join(installRoot, "Vortex Cut.exe");
const ffprobe = join(installRoot, "resources", "ffmpeg", "win-x64", "ffprobe.exe");
const ffmpeg = join(installRoot, "resources", "ffmpeg", "win-x64", "ffmpeg.exe");
const require = createRequire(import.meta.url);
const playwright = require(require.resolve("playwright", { paths: [dirname(require.resolve("@playwright/test"))] }));
const electron = playwright._electron;

const launch = () => electron.launch({ executablePath: executable, args: [`--user-data-dir=${userData}`], cwd: installRoot, env: {
  ...process.env, AIVS_E2E_ASSET_PATHS: JSON.stringify({ video }), AIVS_E2E_EXPORT_DIRECTORY: exportsRoot,
  AIVS_RESOURCES_PATH: undefined, AIVS_SIDECAR_EXECUTABLE: undefined, AIVS_SIDECAR_EXECUTABLE_ARGS: undefined,
  PYTHONPATH: undefined, ELECTRON_RUN_AS_NODE: undefined, NODE_OPTIONS: undefined
}});

async function terminalJob(page: any, id: string) {
  await expect.poll(async () => (await page.evaluate((value: string) => window.desktop.getJob(value as never), id)).status, { timeout: 300_000 }).toMatch(/^(succeeded|failed|cancelled|interrupted)$/);
  return page.evaluate((value: string) => window.desktop.getJob(value as never), id);
}
async function terminalBatch(page: any, id: string) {
  await expect.poll(async () => (await page.evaluate((value: string) => window.desktop.getReframeExportBatch(value), id)).status, { timeout: 300_000 }).toMatch(/^(succeeded|partial|failed|cancelled|interrupted)$/);
  return page.evaluate((value: string) => window.desktop.getReframeExportBatch(value), id);
}
function sensitive(value: unknown): boolean {
  const text = JSON.stringify(value).toLowerCase();
  return ["absolute_path","destination_path","source_path","stderr","ffmpeg_command","authorization","api_key","provider_payload","provider_response","caption_text","transcript_text","raw_exception","stack_trace", video.toLowerCase(), exportsRoot.toLowerCase(), userData.toLowerCase()].some(key => text.includes(key));
}
function probe(path: string, width: number, height: number) {
  const result = spawnSync(ffprobe, ["-v","error","-show_streams","-of","json",path], { encoding: "utf8", windowsHide: true });
  expect(result.status).toBe(0);
  const streams = JSON.parse(result.stdout).streams;
  const v = streams.find((item: any) => item.codec_type === "video");
  const a = streams.find((item: any) => item.codec_type === "audio");
  expect({ codec:v.codec_name,width:v.width,height:v.height,sar:v.sample_aspect_ratio,pix:v.pix_fmt }).toEqual({ codec:"h264",width,height,sar:"1:1",pix:"yuv420p" });
  expect({ codec:a.codec_name,rate:Number(a.sample_rate),channels:Number(a.channels) }).toEqual({ codec:"aac",rate:48000,channels:2 });
  expect(spawnSync(ffmpeg, ["-v","error","-i",path,"-f","null","NUL"], { windowsHide:true }).status).toBe(0);
}

test("installed Stage 3B preview, partial/retry, restart", async () => {
  test.skip(!packageAcceptanceConfigured, "requires an explicitly installed isolated package");
  test.setTimeout(900_000);
  await mkdir(exportsRoot, { recursive:true });
  const first = await launch();
  let saved: any;
  try {
    const page = await first.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktop?.getRuntime), null, { timeout:120_000 });
    expect(await page.evaluate(() => window.desktop.getRuntime())).toMatchObject({ status:"ready" });
    const setup = await page.evaluate(async () => {
      const project = await window.desktop.createProject({ name:"Stage 3B Installed Acceptance" });
      const imported = await window.desktop.importAsset({ project_id:project.project_id, kind:"video" });
      if (!imported) throw new Error("IMPORT_CANCELLED");
      const timeline = await window.desktop.createTimeline({ project_id:project.project_id, timeline:{ schema_version:1, source:{ kind:"full_asset",asset_id:imported.asset.asset_id }, default_layout:"crop_fill", caption_preset_id:"default-bottom" }});
      return { project_id:project.project_id, revision_id:timeline.current_revision.timeline_revision_id, clip_id:timeline.current_revision.document.clips[0].clip_id };
    });
    const platform = await page.evaluate(async () => (await window.desktop.listPlatformPresets()).items.find(item => item.allowed_rendition_ids.includes("portrait-9x16-v1") && item.allowed_rendition_ids.includes("landscape-16x9-v1"))!.platform_preset_id);
    const defs = [
      { rendition:"portrait-9x16-v1", h:"left", v:"center", pw:540, ph:960, ew:1080, eh:1920 },
      { rendition:"landscape-16x9-v1", h:"center", v:"top", pw:960, ph:540, ew:1920, eh:1080 }
    ];
    const reframes: any[] = [];
    for (const def of defs) {
      const created = await page.evaluate((x:any) => window.desktop.createRenditionPreview({ project_id:x.project_id, preview:{ timeline_revision_id:x.revision_id,platform_preset_id:x.platform,rendition_preset_id:x.rendition,layout_policy:"crop_fill_all",encoder_mode:"software" }}), { ...setup,platform,...def });
      if (created.job) expect((await terminalJob(page, created.job.job_id)).status).toBe("succeeded");
      const base = await page.evaluate(async (x:any) => (await window.desktop.listRenditionPreviews({ project_id:x.project_id,limit:100 })).items.find(item => item.preview.timeline_revision_id===x.revision_id && item.preview.rendition_preset_id===x.rendition && item.preview.layout_policy==="crop_fill_all"), { ...setup,...def });
      const made = await page.evaluate((x:any) => window.desktop.createRenditionReframePreview({ project_id:x.project_id,preview:{ base_rendition_snapshot_id:x.base,adjustments:[{ clip_id:x.clip_id,horizontal_anchor:x.h,vertical_anchor:x.v }],encoder_mode:"software" }}), { ...setup,...def,base:base.preview.rendition_snapshot_id });
      if (made.job) expect((await terminalJob(page, made.job.job_id)).status).toBe("succeeded");
      const ref = await page.evaluate(async (x:any) => (await window.desktop.listRenditionReframePreviews({ project_id:x.project_id,limit:100 })).items.find(item => item.preview.base_rendition_snapshot_id===x.base), { project_id:setup.project_id,base:base.preview.rendition_snapshot_id });
      expect(ref.preview.media_info.video).toMatchObject({ width:def.pw,height:def.ph,codec:"h264" });
      expect(ref.preview.media_info.audio).toMatchObject({ codec:"aac" });
      reframes.push({ ...ref,def });
    }
    const range = await page.evaluate(async (url:string) => { const r=await fetch(url,{ headers:{ Range:"bytes=0-31" }}); return { status:r.status,length:(await r.arrayBuffer()).byteLength }; }, reframes[0].media_url);
    expect(range).toEqual({ status:206,length:32 });
    const grant = await page.evaluate((id:string) => window.desktop.chooseExportDirectory(id as never), setup.project_id);
    const madeBatch = await page.evaluate((x:any) => window.desktop.createReframeExportBatch({ project_id:x.project_id,batch:{ directory_grant_id:x.grant,items:x.refs.map((r:any) => ({ rendition_reframe_snapshot_id:r.preview.rendition_reframe_snapshot_id,preview_artifact_id:r.preview.render_artifact_id,encoder_mode:"software" })) }}), { project_id:setup.project_id,grant:grant!.directory_grant_id,refs:reframes });
    expect(madeBatch.jobs).toHaveLength(2);
    const blocked = madeBatch.batch.items[1];
    await mkdir(join(exportsRoot, blocked.destination_display_name), { recursive:true });
    const jobs = await Promise.all(madeBatch.jobs.map((job:any) => terminalJob(page,job.job_id)));
    const partial = await terminalBatch(page,madeBatch.batch.reframe_export_batch_id);
    expect(partial.status).toBe("partial");
    expect(partial.items.filter((item:any) => item.status==="succeeded")).toHaveLength(1);
    expect(partial.items.filter((item:any) => ["failed","cancelled","interrupted"].includes(item.status))).toHaveLength(1);
    expect(jobs.some((job:any) => job.status==="succeeded")).toBe(true);
    expect(jobs.some((job:any) => ["failed","cancelled","interrupted"].includes(job.status))).toBe(true);
    const failed = partial.items.find((item:any) => item.status!=="succeeded");
    const retryGrant = await page.evaluate((id:string) => window.desktop.chooseExportDirectory(id as never), setup.project_id);
    const retried = await page.evaluate((x:any) => window.desktop.retryReframeExportBatch({ batch_id:x.batch,retry:{ directory_grant_id:x.grant,reframe_export_batch_item_ids:[x.item] }}), { batch:partial.reframe_export_batch_id,grant:retryGrant!.directory_grant_id,item:failed.reframe_export_batch_item_id });
    expect(retried.batch.reframe_export_batch_id).not.toBe(partial.reframe_export_batch_id);
    expect(retried.batch.retry_of_batch_id).toBe(partial.reframe_export_batch_id);
    expect(retried.batch.items[0].retry_of_item_id).toBe(failed.reframe_export_batch_item_id);
    expect(retried.batch.items[0].reframe_export_batch_item_id).not.toBe(failed.reframe_export_batch_item_id);
    expect(retried.jobs[0].job_id).not.toBe(failed.job_id);
    expect((await terminalJob(page,retried.jobs[0].job_id)).status).toBe("succeeded");
    const retryBatch = await terminalBatch(page,retried.batch.reframe_export_batch_id);
    expect(retryBatch.status).toBe("succeeded");
    const finalItems = [...partial.items.filter((item:any) => item.status==="succeeded"),retryBatch.items[0]];
    const exportsList = await page.evaluate(async (id:string) => (await window.desktop.listExports({ project_id:id as never,limit:100 })).items, setup.project_id);
    const outputChecks=[];
    for (const item of finalItems) {
      const record = exportsList.find((value:any) => value.export_record.export_record_id===item.export_record_id)?.export_record;
      expect(record).toBeTruthy();
      const output=join(exportsRoot,item.destination_display_name);
      const ref=reframes.find(value => value.preview.rendition_reframe_snapshot_id===item.rendition_reframe_snapshot.rendition_reframe_snapshot_id);
      probe(output,ref.def.ew,ref.def.eh);
      const hash=`sha256:${createHash("sha256").update(await readFile(output)).digest("hex")}`;
      expect(hash).toBe(record.sha256);
      expect((await stat(output)).size).toBe(record.size_bytes);
      outputChecks.push({ rendition:ref.def.rendition,h264:true,aac:true,sar_one:true,full_decode:true,hash_matches:true });
    }
    const providerJobs = await page.evaluate(async (id:string) => (await window.desktop.listJobs({ project_id:id as never,limit:100 })).items.filter(item => item.kind.includes("provider")).length, setup.project_id);
    expect(providerJobs).toBe(0);
    const publicState={ setup,reframes,range,partial,retryBatch,exportsList };
    expect(sensitive(publicState)).toBe(false);
    saved={ project_id:setup.project_id,revision_id:setup.revision_id,reframe_ids:reframes.map(item=>item.preview.render_artifact_id),batch_ids:[partial.reframe_export_batch_id,retryBatch.reframe_export_batch_id],providerJobs,outputChecks };
  } finally { await first.close().catch(() => undefined); }

  const second=await launch();
  try {
    const page=await second.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktop?.getRuntime),null,{ timeout:120_000 });
    expect(await page.evaluate(() => window.desktop.getRuntime())).toMatchObject({ status:"ready" });
    const timeline=await page.evaluate((id:string) => window.desktop.getTimeline(id as never),saved.project_id);
    expect(timeline.current_revision.timeline_revision_id).toBe(saved.revision_id);
    const previews=await page.evaluate(async (id:string) => (await window.desktop.listRenditionReframePreviews({ project_id:id as never,limit:100 })).items,saved.project_id);
    expect(saved.reframe_ids.every((id:string) => previews.some((item:any) => item.preview.render_artifact_id===id))).toBe(true);
    const batches=await page.evaluate(async (id:string) => (await window.desktop.listReframeExportBatches({ project_id:id as never,limit:100 })).items,saved.project_id);
    expect(saved.batch_ids.every((id:string) => batches.some((item:any) => item.reframe_export_batch_id===id))).toBe(true);
    const providerJobs=await page.evaluate(async (id:string) => (await window.desktop.listJobs({ project_id:id as never,limit:100 })).items.filter(item => item.kind.includes("provider")).length,saved.project_id);
    expect(providerJobs).toBe(0);
    expect(sensitive({ timeline,previews,batches })).toBe(false);
    const evidence={ schema_version:1,status:"passed",checks:{ installed_app_started:true,installed_stage3b_loop:true,installed_preview_range:true,installed_batch_partial:true,installed_retry_lineage:true,installed_restart:true,provider_job_count:0,sensitive_fields_detected:false,outputs:saved.outputChecks }};
    await writeFile(join(runRoot,"installed-result.json"),`${JSON.stringify(evidence,null,2)}\n`,"utf8");
  } finally { await second.close().catch(() => undefined); }
});



