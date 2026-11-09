import { useEffect, useId, useRef } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { X } from "lucide-react";

type Props = {
  titleId?: string;
  label?: string;
  title?: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  className?: string;
  bodyClassName?: string;
  footer?: ReactNode;
  closeLabel?: string;
  children: ReactNode;
};

const FOCUSABLE = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex=\"-1\"])",
].join(",");

export function Dialog({ titleId, label, title, subtitle, onClose, className = "", bodyClassName = "", footer, closeLabel, children }: Props) {
  const dialogRef = useRef<HTMLElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const generatedTitleId = useId();
  const headingId = titleId ?? (title !== undefined ? generatedTitleId : undefined);
  const framed = title !== undefined;

  useEffect(() => {
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const first = dialog.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? dialog).focus();
    return () => {
      const target = returnFocusRef.current;
      if (target && target.isConnected) target.focus();
    };
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE))
      .filter(element => element.closest('[role="dialog"]') === dialog);
    if (!focusable.length) {
      event.preventDefault();
      event.stopPropagation();
      dialog.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      event.stopPropagation();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      event.stopPropagation();
      first.focus();
    }
  };

  return <div className="modal-backdrop">
    <section
      ref={dialogRef}
      className={`modal ${className}`.trim()}
      role="dialog"
      aria-modal="true"
      aria-labelledby={headingId}
      aria-label={headingId ? undefined : label}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
    >
      {framed ? <>
        <div className="modal-heading">
          <div><h2 id={headingId}>{title}</h2>{subtitle !== undefined && <p>{subtitle}</p>}</div>
          <button type="button" className="icon-btn" aria-label={closeLabel ?? (label ? (/^[A-Za-z]/.test(label) ? `关闭 ${label}` : `关闭${label}`) : "关闭对话框")} title="关闭 · Esc" onClick={onClose}><X size={15} /></button>
        </div>
        <div className={`modal-body ${bodyClassName}`.trim()}>{children}</div>
        {footer !== undefined && <div className="modal-actions">{footer}</div>}
      </> : children}
    </section>
  </div>;
}
