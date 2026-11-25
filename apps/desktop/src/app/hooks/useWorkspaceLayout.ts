import type React from "react";
import { useEffect, useRef, useState } from "react";
import { defaultTimelineHeight } from "../appHelpers.js";

/** 管理编辑器工作区面板尺寸/折叠态及标题栏/播放器弹层的外部点击与 Esc 关闭逻辑。 */
export function useWorkspaceLayout() {
  const [projectSwitcherOpen, setProjectSwitcherOpen] = useState(false);
  const [projectSwitcherQuery, setProjectSwitcherQuery] = useState("");
  const projectSwitcherRef = useRef<HTMLDivElement | null>(null);
  const [activeMenu, setActiveMenu] = useState<string | null>(null);
  const appMenuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const appMenuCategoryRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const appMenuPopoverRef = useRef<HTMLDivElement | null>(null);

  const [leftWidth, setLeftWidth] = useState(320);
  // P4 参照窗格栏（ProjectView.tsx:4639-4661）的 layers/inspector 开关：映射为左素材池/右属性栏显隐。
  const [leftPaneOpen, setLeftPaneOpen] = useState(true);
  const [rightPaneOpen, setRightPaneOpen] = useState(true);
  const [paneSettingsOpen, setPaneSettingsOpen] = useState(false);
  const paneSettingsRef = useRef<HTMLSpanElement | null>(null);
  // 参照 DEFAULT_INSPECTOR = 360（openfilm PaneDivider.tsx:50）；原 336 是自定值。
  const [rightWidth, setRightWidth] = useState(360);
  // 时间线面板高度默认按视口比例给（2026-11-11）：参照 OpenFilm 录屏实测
  // 490px / 1440px ≈ 34%。固定 230px 在 1440 高窗口上只占 16%，轨道区一屏
  // 只能看到两轨半，与参照软件"时间线是画面下方一整块工作区"的观感差一倍。
  // 比例随窗口重算（下面的 effect）；用户一旦拖过，就以用户值为准。
  const [timelineHeight, setTimelineHeight] = useState(() => defaultTimelineHeight());
  // 用户是否亲手调过时间线高度。调过之后窗口缩放不再覆盖用户的选择。
  const timelineHeightPinnedRef = useRef(false);
  const resizeRef = useRef<{ kind: "left" | "right" | "timeline"; start: number; value: number } | undefined>(undefined);

  // 剪映式播放器弹层状态：画布缩放、音量、倍速/循环。
  const [zoomPopOpen, setZoomPopOpen] = useState(false);
  const zoomPopRef = useRef<HTMLDivElement | null>(null);
  const [volPopOpen, setVolPopOpen] = useState(false);
  const volPopRef = useRef<HTMLDivElement | null>(null);
  const [ratePopOpen, setRatePopOpen] = useState(false);
  const ratePopRef = useRef<HTMLDivElement | null>(null);

  // 时间线高度跟随窗口比例：窗口缩放（含最大化）时重算，除非用户拖过。
  useEffect(() => {
    const onResize = () => {
      if (timelineHeightPinnedRef.current) return;
      setTimelineHeight(defaultTimelineHeight());
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const resize = resizeRef.current;
      if (!resize) return;
      const delta = event.clientX - resize.start;
      if (resize.kind === "left") setLeftWidth(Math.max(220, Math.min(420, resize.value + delta)));
      else if (resize.kind === "right") setRightWidth(Math.max(240, Math.min(460, resize.value - delta)));
      else setTimelineHeight(Math.max(150, Math.min(520, resize.value - (event.clientY - resize.start))));
    };
    const end = () => {
      resizeRef.current = undefined;
      document.body.classList.remove("is-resizing");
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
    };
  }, []);

  const beginResize = (kind: "left" | "right" | "timeline", event: React.PointerEvent) => {
    event.preventDefault();
    // 用户开始拖时间线高度：从此这个高度归用户，窗口缩放不再重算。
    if (kind === "timeline") timelineHeightPinnedRef.current = true;
    resizeRef.current = {
      kind,
      start: kind === "timeline" ? event.clientY : event.clientX,
      value: kind === "left" ? leftWidth : kind === "right" ? rightWidth : timelineHeight,
    };
    document.body.classList.add("is-resizing");
  };

  useEffect(() => {
    if (!activeMenu) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (appMenuPopoverRef.current?.contains(target) || appMenuTriggerRef.current?.contains(target)) return;
      setActiveMenu(null);
    };
    window.addEventListener("mousedown", onPointerDown);
    return () => window.removeEventListener("mousedown", onPointerDown);
  }, [activeMenu]);

  useEffect(() => {
    if (!zoomPopOpen && !volPopOpen && !ratePopOpen) return;
    const listener = (event: MouseEvent) => {
      if (zoomPopRef.current && !zoomPopRef.current.contains(event.target as Node)) setZoomPopOpen(false);
      if (volPopRef.current && !volPopRef.current.contains(event.target as Node)) setVolPopOpen(false);
      if (ratePopRef.current && !ratePopRef.current.contains(event.target as Node)) setRatePopOpen(false);
    };
    window.addEventListener("mousedown", listener);
    return () => window.removeEventListener("mousedown", listener);
  }, [zoomPopOpen, volPopOpen, ratePopOpen]);

  useEffect(() => {
    if (!paneSettingsOpen) return;
    const closeOnOutsidePointer = (event: MouseEvent) => {
      if (!paneSettingsRef.current?.contains(event.target as Node)) setPaneSettingsOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setPaneSettingsOpen(false);
      paneSettingsRef.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
    };
    window.addEventListener("mousedown", closeOnOutsidePointer);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("mousedown", closeOnOutsidePointer);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [paneSettingsOpen]);

  useEffect(() => {
    if (!zoomPopOpen && !volPopOpen && !ratePopOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (zoomPopOpen) {
        setZoomPopOpen(false);
        (zoomPopRef.current?.previousElementSibling as HTMLButtonElement | null)?.focus();
      } else if (volPopOpen) {
        setVolPopOpen(false);
        (volPopRef.current?.previousElementSibling as HTMLButtonElement | null)?.focus();
      } else if (ratePopOpen) {
        setRatePopOpen(false);
        (ratePopRef.current?.previousElementSibling as HTMLButtonElement | null)?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [zoomPopOpen, volPopOpen, ratePopOpen]);

  useEffect(() => {
    if (!projectSwitcherOpen) return;
    const listener = (event: MouseEvent) => {
      if (projectSwitcherRef.current && !projectSwitcherRef.current.contains(event.target as Node)) {
        setProjectSwitcherOpen(false);
        setProjectSwitcherQuery("");
      }
    };
    window.addEventListener("mousedown", listener);
    return () => window.removeEventListener("mousedown", listener);
  }, [projectSwitcherOpen]);

  return {
    projectSwitcherOpen,
    setProjectSwitcherOpen,
    projectSwitcherQuery,
    setProjectSwitcherQuery,
    projectSwitcherRef,
    activeMenu,
    setActiveMenu,
    appMenuTriggerRef,
    appMenuCategoryRefs,
    appMenuPopoverRef,
    leftWidth,
    setLeftWidth,
    rightWidth,
    setRightWidth,
    timelineHeight,
    setTimelineHeight,
    leftPaneOpen,
    setLeftPaneOpen,
    rightPaneOpen,
    setRightPaneOpen,
    paneSettingsOpen,
    setPaneSettingsOpen,
    paneSettingsRef,
    beginResize,
    zoomPopOpen,
    setZoomPopOpen,
    zoomPopRef,
    volPopOpen,
    setVolPopOpen,
    volPopRef,
    ratePopOpen,
    setRatePopOpen,
    ratePopRef,
  };
}
