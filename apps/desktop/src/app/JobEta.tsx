import { useEffect, useRef, useState } from "react";
import type { Job } from "@aivideo/contracts";

// C2 任务剩余时间估计：对运行中任务的 progress 做速率采样，
// 用最近窗口的线性外推给出 ETA。样本不足或进度停滞时不显示。
type Sample = { at: number; progress: number };
const WINDOW_MS = 20_000;
const MIN_SPAN_MS = 4_000;
const MIN_PROGRESS_DELTA = 0.005;

const formatEta = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  if (seconds < 60) return `约 ${Math.max(1, Math.round(seconds))} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `约 ${minutes} 分 ${rest} 秒`;
};

export function JobEta({ job }: { job: Job }) {
  const samplesRef = useRef<Map<string, Sample>>(new Map());
  const [etaText, setEtaText] = useState("");
  // 心跳：即便 progress 未推送新值，也让 ETA 随时间推进重算。
  const [tick, setTick] = useState(0);
  const running = job.status === "running" && typeof job.progress === "number";
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setTick(value => value + 1), 1000);
    return () => clearInterval(timer);
  }, [running]);

  useEffect(() => {
    if (!running) {
      samplesRef.current.delete(job.job_id);
      samplesRef.current.delete(`${job.job_id}:start`);
      setEtaText("");
      return;
    }
    void tick;
    const samples = samplesRef.current;
    const now = Date.now();
    // 进度回退（重试/换阶段）时重置窗口锚点。
    const anchor = samples.get(`${job.job_id}:start`);
    if (!anchor || job.progress! <= anchor.progress || now - anchor.at > WINDOW_MS) {
      samples.set(`${job.job_id}:start`, { at: now, progress: job.progress! });
    }
    samples.set(job.job_id, { at: now, progress: job.progress! });
    const start = samples.get(`${job.job_id}:start`)!;
    const spanMs = now - start.at;
    const delta = job.progress! - start.progress;
    if (spanMs < MIN_SPAN_MS || delta < MIN_PROGRESS_DELTA) {
      setEtaText("估计中…");
      return;
    }
    const rate = delta / spanMs; // progress/ms
    const remainingMs = (1 - job.progress!) / rate;
    setEtaText(formatEta(remainingMs / 1000));
  }, [job.job_id, job.status, job.progress, tick, running]);

  if (!running || !etaText) return null;
  return <span className="job-eta" role="status" aria-label="剩余时间估计">{etaText}</span>;
}
