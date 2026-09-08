/** M3-0 探针：import.meta.env 本地声明（渲染入口 DEV 门控用，见冻结方案 §7.1）。 */
interface ImportMetaEnvProbe {
  readonly DEV: boolean;
  readonly VITE_AIVS_PERF?: string;
  readonly PROD: boolean;
  readonly MODE: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnvProbe;
}
