// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useModelStore } from "../../store/modelStore";
import {
  SIDEBAR_DEFAULT_WIDTH,
  SMALL_SCREEN_QUERY,
} from "../../store/viewSlice";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { ModelTree } from "./ModelTree";
import { PropertiesPanel } from "./PropertiesPanel";
import styles from "./Sidebar.module.css";

// Slim bottom bar with the collapse button — arrow pointing right, bar on the
// left, mirroring the expand button's icon.
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
    </div>
  );
}

// Resizable / collapsible shell around the properties panel, docked on the
// right of the viewport (issue #339). On desktop the left edge drags to resize
// (double-click resets); on small screens the sidebar starts collapsed and,
// when opened, overlays the viewport with a tap-to-close backdrop instead of
// squeezing it. There the drawer also carries the model tree, which on desktop
// is its own column left of the viewport (see App).
export function Sidebar() {
  const open = useModelStore((s) => s.sidebarOpen);
  const width = useModelStore((s) => s.sidebarWidth);
  const setOpen = useModelStore((s) => s.setSidebarOpen);
  const setWidth = useModelStore((s) => s.setSidebarWidth);
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const small = useMediaQuery(SMALL_SCREEN_QUERY);

  // Follow breakpoint crossings: collapse when the screen becomes small,
  // reopen when it grows back to desktop size.
  useEffect(() => setOpen(!small), [small, setOpen]);

  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { startX: e.clientX, startWidth: width };
    setDragging(true);
  }

  function handlePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!drag.current) return;
    // The handle is on the panel's left edge: dragging left widens it.
    setWidth(drag.current.startWidth - (e.clientX - drag.current.startX));
  }

  function handlePointerUp() {
    drag.current = null;
    setDragging(false);
  }

  if (!open) {
    // Expand: bar on the right (the collapsed panel), arrow pointing left.
    return (
      <button
        className={styles.expandBtn}
        title="Show panel"
        aria-label="Show panel"
        onClick={() => setOpen(true)}
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
    );
  }

  return (
    <>
      <div className={styles.backdrop} onClick={() => setOpen(false)} />
      <div
        className={styles.sidebar}
        style={{ "--sidebar-width": `${width}px` } as CSSProperties}
      >
        {small && <ModelTree />}
        <PropertiesPanel />
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
