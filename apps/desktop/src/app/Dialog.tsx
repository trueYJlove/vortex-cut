import { useEffect, useRef } from "react";
import type { KeyboardEvent, ReactNode } from "react";

type Props = {
  titleId?: string;
  label?: string;
  onClose: () => void;
  className?: string;
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

export function Dialog({ titleId, label, onClose, className = "", children }: Props) {
  const dialogRef = useRef<HTMLElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

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
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (!focusable.length) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return <div className="modal-backdrop">
    <section
      ref={dialogRef}
      className={`modal ${className}`.trim()}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-label={titleId ? undefined : label}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
    >
      {children}
    </section>
  </div>;
}
