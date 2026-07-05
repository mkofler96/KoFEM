// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useModelStore } from "../../store/modelStore";
import {
  SIDEBAR_DEFAULT_WIDTH,
  SMALL_SCREEN_QUERY,
} from "../../store/viewSlice";
import { LeftPanel } from "./LeftPanel";
import styles from "./Sidebar.module.css";

// Slim bottom bar with the collapse button — arrow pointing left, bar on the
// right, mirroring the expand button's icon.
function SidebarFooter({ onCollapse }: { onCollapse: () => void }) {
  return (
    <div className={styles.footer}>
      <button
        className={styles.collapseBtn}
        title="Hide panel"
        aria-label="Hide panel"
        onClick={onCollapse}
      >
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
          <path
            d="M13 3v10"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
          <path
            d="M9.5 8H3M6 5L3 8l3 3"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
    </div>
  );
}

// Resizable / collapsible shell around LeftPanel (issue #339). On desktop the
// right edge drags to resize (double-click resets); on small screens the
// sidebar starts collapsed and, when opened, overlays the viewport with a
// tap-to-close backdrop instead of squeezing it.
export function Sidebar() {
  const open = useModelStore((s) => s.sidebarOpen);
  const width = useModelStore((s) => s.sidebarWidth);
  const setOpen = useModelStore((s) => s.setSidebarOpen);
  const setWidth = useModelStore((s) => s.setSidebarWidth);
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  // Follow breakpoint crossings: collapse when the screen becomes small,
  // reopen when it grows back to desktop size.
  useEffect(() => {
    const mq = window.matchMedia(SMALL_SCREEN_QUERY);
    const onChange = (e: MediaQueryListEvent) => setOpen(!e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [setOpen]);

  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { startX: e.clientX, startWidth: width };
    setDragging(true);
  }

  function handlePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!drag.current) return;
    setWidth(drag.current.startWidth + e.clientX - drag.current.startX);
  }

  function handlePointerUp() {
    drag.current = null;
    setDragging(false);
  }

  if (!open) {
    // Expand: bar on the left (the collapsed panel), arrow pointing right.
    return (
      <button
        className={styles.expandBtn}
        title="Show panel"
        aria-label="Show panel"
        onClick={() => setOpen(true)}
      >
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
          <path
            d="M3 3v10"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
          <path
            d="M6.5 8H13M10 5l3 3-3 3"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
    );
  }

  return (
    <>
      <div className={styles.backdrop} onClick={() => setOpen(false)} />
      <div
        className={styles.sidebar}
        style={{ "--sidebar-width": `${width}px` } as CSSProperties}
      >
        <LeftPanel />
        <SidebarFooter onCollapse={() => setOpen(false)} />
        <div
          className={`${styles.resizeHandle} ${dragging ? styles.resizeHandleActive : ""}`}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          title="Drag to resize — double-click to reset"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onDoubleClick={() => setWidth(SIDEBAR_DEFAULT_WIDTH)}
        />
      </div>
    </>
  );
}
