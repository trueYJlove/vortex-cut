/**
 * MediaDecoder 双后端抽象（MEDIA_DECODER_HEVC_PLANNING_GATE §2.1）。
 *
 * 合成器只认 decode(frameN) → DecodedFrame，不关心后端。VideoFrame 只在
 * webcodecs 分支出现；ffmpeg 分支走 plane_payload（CPU 平面，非 GPU 句柄）。
 * 两分支均以 release() 收口生命周期——禁止用「是否拿到 VideoFrame」隐式
 * 决定是否 close()。
 */
import type { DecodeBackendId, WebCodecsDecodeMode } from "@aivideo/contracts";
import type { DecodeResidencyInfo } from "./decode-worker.js";

export interface VideoFrameDecodedFrame {
  kind: "video_frame";
  frame: VideoFrame;
  timestampUs: number;
  frameN: number;
  /** 上传完成后释放（= frame.close()）。B13-R closed 计数依赖该契约。 */
  release(): void;
}

export interface PlanePayloadDecodedFrame {
  kind: "plane_payload";
  timestampUs: number;
  frameN: number;
  width: number;
  height: number;
  /** NV12（y+uv）或 I420（y+u+v）；transfer 语义与 VideoFrame 零拷贝路径对齐 */
  planes: { y: Uint8Array; uv?: Uint8Array; u?: Uint8Array; v?: Uint8Array };
  /** 缺省 BT.709，与冻结方案一致 */
  colorSpace?: "bt709";
  /** 上传完成后释放（detach 平面缓冲；与 video_frame 分支语义对齐）。 */
  release(): void;
}

export type DecodedFrame = VideoFrameDecodedFrame | PlanePayloadDecodedFrame;

export interface MediaDecoder {
  readonly backend: DecodeBackendId;
  readonly codec: string;
  readonly width: number;
  readonly height: number;
  /** 实际解码模式（诊断呈现用，不参与后端决策）；对齐现 worker 值。 */
  readonly hardware: WebCodecsDecodeMode | null;
  /**
   * 随机访问：frameN 为合成时间轴帧号。
   * 取样定位 PTS 最近邻 ±33_334μs；输出匹配半帧 ±16_667μs（见 decode-worker.worker.ts）。
   */
  decode(frameN: number, fps: number, signal?: AbortSignal): Promise<DecodedFrame>;
  residency(): Promise<DecodeResidencyInfo | null>;
  dispose(): void;
}

export interface MediaDecoderFactoryInput {
  /** aivideo:// 票据 */
  mediaUrl: string;
  /** 规范化 codec（avc/hevc/av1）或 RFC codec string（工厂内部规范化） */
  codec: string;
  width: number;
  height: number;
  forceSwDecode?: boolean;
  cacheCapBytes?: number;
  refreshTicket?: () => Promise<string>;
  /** H3 后端 B：窗口帧解码（Main→Core；响应为 AIV1 紧凑二进制）。 */
  decodeFrames?: (input: { frameNumbers: number[]; fps: number }) => Promise<ArrayBuffer>;
}

export interface MediaDecoderFactory {
  /** 能力表决策后调用；失败可 fallback 到次选后端。 */
  create(input: MediaDecoderFactoryInput, signal?: AbortSignal): Promise<MediaDecoder>;
}
