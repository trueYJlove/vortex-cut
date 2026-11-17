/** M3-0 探针：import.meta.env 本地声明（渲染入口 DEV 门控用，见冻结方案 §7.1）。 */
interface ImportMetaEnvProbe {
  readonly DEV: boolean;
  readonly VITE_AIVS_PERF?: string;
  readonly VITE_AIVS_PREVIEW_IR_V2?: string;
  /** B13-R 判别诊断开关：强制软件解码（perf 诊断构建专用）。 */
  readonly VITE_AIVS_FORCE_SW_DECODE?: string;
  /** P33 解码 RTT 分段计时（=1 开启；默认关，生产零开销）。 */
  readonly VITE_AIVS_DECODE_TIMING?: string;
  /** WP-P227 Slice 2：WebGPU 合成器后端门控（诊断构建=1 启用；缺省/0=WebGL2）。 */
  readonly VITE_AIVS_GPU?: string;
  readonly PROD: boolean;
  readonly MODE: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnvProbe;
}
