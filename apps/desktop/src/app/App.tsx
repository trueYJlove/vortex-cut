import { useEffect, useMemo, useState, type ReactElement } from "react";
import type { Artifact, FileGrant, Job, MediaInfo } from "@aivideo/contracts";
import { createDesktopCoreClient, type CoreClient } from "../lib/core-client.js";

const activeStates = ["queued", "running", "cancelling"];

function formatDuration(us: number): string {
  const seconds = Math.round(us / 1000000);
  return Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
}

export function App(): ReactElement {
  const [client, setClient] = useState<CoreClient>();
  const [status, setStatus] = useState("Connecting to Core");
  const [grant, setGrant] = useState<FileGrant | null>(null);
  const [media, setMedia] = useState<MediaInfo | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let mounted = true;
    void window.desktop.getRuntime().then(runtime => {
      if (mounted) { setClient(createDesktopCoreClient(runtime)); setStatus("Core connected"); }
    }).catch(() => {
      if (mounted) { setStatus("Core connection failed"); setError("Unable to establish the Core session"); }
    });
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    if (!client || !job || !activeStates.includes(job.status)) return;
    return client.subscribe(job.job_id, setJob);
  }, [client, job?.job_id]);

  useEffect(() => {
    if (job?.status === "succeeded" && job.artifacts?.[0]) setArtifact(job.artifacts[0]);
  }, [job?.status, job?.artifacts]);

  const stream = useMemo(() => media?.video_streams[0], [media]);
  const jobType = job?.type ?? job?.kind;
  const canCreate = Boolean(client && media && !job);

  async function chooseMedia(): Promise<void> {
    setError(undefined);
    try {
      const selected = await window.desktop.chooseMedia();
      if (!selected) return;
      setGrant(selected.grant);
      setMedia(selected.media);
      setJob(null);
      setArtifact(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Media probe failed");
    }
  }

  async function createJob(kind: "proxy" | "portrait_sample"): Promise<void> {
    if (!client || !media) return;
    setError(undefined);
    try {
      setJob(await client.createJob(media.media_id, kind, {
        encoder_mode: "auto",
        start_us: 0,
        duration_us: kind === "portrait_sample" ? 10000000 : undefined,
        layout: "blurred_background"
      }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Job creation failed");
    }
  }

  async function cancelJob(): Promise<void> {
    if (!client || !job) return;
    try { setJob(await client.cancelJob(job.job_id)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Cancellation failed"); }
  }

  return <main className="workspace">
    <header className="topbar">
      <div><span className="brand-mark">AI</span><strong>AIVideo Studio</strong><span className="stage-label">Stage 0</span></div>
      <div className="status"><span className="status-dot" />{status}</div>
    </header>
    <section className="content">
      <div className="intro"><div><p className="eyebrow">LOCAL MEDIA PIPELINE</p><h1>Stage 0 verification</h1><p className="subhead">Grant a source file, probe it, create a Core job, and validate its artifact.</p></div><div className="protocol"><span>Protocol</span><strong>v1</strong><span>127.0.0.1</span></div></div>
      <div className="grid">
        <section className="panel"><div className="panel-heading"><h2>Media input</h2><span className="step">01</span></div><button className="dropzone" onClick={() => void chooseMedia()}><span className="drop-icon">+</span><strong>{grant ? grant.display_name : "Choose a video file"}</strong><small>{grant ? String((grant.size_bytes / 1048576).toFixed(1)) + " MB - granted" : "The path stays in the main process"}</small></button>{media && <div className="facts"><div><span>Duration</span><strong>{formatDuration(media.duration_us)}</strong></div><div><span>Frame</span><strong>{stream?.width} x {stream?.height}</strong></div><div><span>Rate</span><strong>{stream?.avg_frame_rate_num && stream?.avg_frame_rate_den ? String((stream.avg_frame_rate_num / stream.avg_frame_rate_den).toFixed(2)) + " fps" : "unknown"}</strong></div><div><span>Audio</span><strong>{media.audio_streams.length ? media.audio_streams[0].codec : "none"}</strong></div></div>}</section>
        <section className="panel"><div className="panel-heading"><h2>Generate sample</h2><span className="step">02</span></div><p className="panel-copy">Portrait output is 1080 x 1920, blurred_background, CFR 30 fps, H.264/AAC.</p><div className="actions"><button disabled={!canCreate} onClick={() => void createJob("proxy")}>Generate proxy</button><button className="primary" disabled={!canCreate} onClick={() => void createJob("portrait_sample")}>Generate portrait sample</button></div><div className="output-spec"><strong>1080 x 1920</strong><small>CFR 30 fps - H.264 + AAC</small></div></section>
        <section className="panel"><div className="panel-heading"><h2>Job status</h2><span className="step">03</span></div>{job ? <><div className="job-row"><div><strong>{jobType === "portrait_sample" || jobType === "vertical_sample" ? "Portrait sample" : "Proxy"}</strong><span className={"job-status " + job.status}>{job.status}</span></div>{activeStates.includes(job.status) && <button className="quiet" onClick={() => void cancelJob()}>Cancel</button>}</div><div className="progress"><span style={{ width: String(Math.max(0, (job.progress ?? 0) * 100)) + "%" }} /></div><div className="job-meta"><span>{job.stage}</span><span>{job.progress === null ? "processing" : String(Math.round(job.progress * 100)) + "%"}</span></div>{job.encoder && <div className="encoder">Encoder <strong>{job.encoder}</strong>{job.fallback_reason && <small>Fallback: {job.fallback_reason}</small>}</div>}</> : <div className="empty"><span>o</span><p>Choose media and create a job<br /><small>WebSocket events with polling fallback</small></p></div>}</section>
        <section className="panel"><div className="panel-heading"><h2>Artifact validation</h2><span className="step">04</span></div>{artifact ? <><div className="artifact-title"><span className="file-icon">MP4</span><div><strong>Validated artifact</strong><small>{String((artifact.size_bytes / 1048576).toFixed(2))} MB - SHA-256</small></div></div><div className="hash">{artifact.sha256}</div><div className="actions"><button onClick={() => void window.desktop.openArtifact(artifact.artifact_id)}>Open file</button><button onClick={() => void window.desktop.openArtifactFolder(artifact.artifact_id)}>Open folder</button></div></> : <div className="empty"><span>OK</span><p>Successful jobs show FFprobe and SHA-256 output</p></div>}</section>
      </div>{error && <div className="error-banner">{error}</div>}
    </section>
  </main>;
}
