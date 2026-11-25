// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// JS-0455 checks DOM attributes; these are Three.js objects whose properties
// are checked by React Three Fiber's TypeScript types. Annotate only those props.

// Result probes in the viewport (KOF-389): a marker at each probe on the
// deformed surface and a label with its name and value; the point and the
// displacement vector show when the label is hovered. The min and max probes
// mark where the plotted field peaks. Mounted only while a static result is
// shown.

import type { SyntheticEvent } from "react";
import { Html } from "@react-three/drei";
import { useProbeReadings } from "../../hooks/useProbeReadings";
import { useModelStore } from "../../store/modelStore";
import { refinementChartVisible } from "../../store/studySlice";
import { probeLabel } from "../../lib/resultProbe";
import { formatHandCheckValue } from "../../lib/handCheck";
import { resultUnit } from "../../lib/resultField";
import { useT } from "../../i18n/useLocale";
import { resultsMessages } from "../../i18n/messages/results";
import styles from "./ProbeLayer.module.css";

type Vec3 = [number, number, number];

const formatVector = (v: readonly number[]) =>
  `(${v.map((c) => formatHandCheckValue(c, "")).join(", ")}) mm`;

// A label is hovered and focused, never a click on the model behind it: the
// viewport's pointer events listen on the canvas's parent, which the label's
// events would otherwise reach and place a probe under it.
const keepFromModel = (e: SyntheticEvent) => e.stopPropagation();

interface MarkerProps {
  testId: string;
  name: string;
  kind: "placed" | "min" | "max";
  at: Vec3;
  displacement: Vec3;
  value: number;
  unit: "mm" | "MPa";
  deformScale: number;
  radius: number;
}

function ProbeMarker({
  testId,
  name,
  kind,
  at,
  displacement: u,
  value,
  unit,
  deformScale,
  radius,
}: MarkerProps) {
  const text = useT(resultsMessages);
  const position: Vec3 = [
    at[0] + u[0] * deformScale,
    at[1] + u[1] * deformScale,
    at[2] + u[2] * deformScale,
  ];
  const color =
    kind === "min" ? "#2563eb" : kind === "max" ? "#dc2626" : "#0d1117";
  return (
    <group
      // skipcq: JS-0455 -- typed React Three Fiber property
      position={position}
    >
      <mesh
        // skipcq: JS-0455 -- typed React Three Fiber property
        raycast={() => null}
      >
        <sphereGeometry
          // skipcq: JS-0455 -- typed React Three Fiber property
          args={[radius, 12, 8]}
        />
        <meshBasicMaterial color={color} />
      </mesh>
      <Html zIndexRange={[20, 0]}>
        <div
          className={`${styles.label} ${kind === "placed" ? "" : styles[kind]}`}
          data-testid={`probe-label-${testId}`}
          tabIndex={0}
          onPointerDown={keepFromModel}
          onPointerUp={keepFromModel}
          onClick={keepFromModel}
        >
          {name} {formatHandCheckValue(value, unit)}
          <div
            className={styles.details}
            data-testid={`probe-label-details-${testId}`}
          >
            {text.probeAt(formatVector(at))}
            <br />U = {formatVector(u)}
          </div>
        </div>
      </Html>
    </group>
  );
}

export function ProbeLayer({
  deformScale,
  modelSize,
}: {
  deformScale: number;
  modelSize: number;
}) {
  const { placed, extremes } = useProbeReadings();
  const showExtremes = useModelStore((s) => s.showExtremeProbes);
  const resultType = useModelStore((s) => s.resultType);
  // The refinement chart covers the 3D view; its labels would float over it.
  const chartShown = useModelStore(refinementChartVisible);
  const text = useT(resultsMessages);
  const unit = resultUnit(resultType);
  const common = { unit, deformScale, radius: 0.008 * modelSize };
  if (chartShown) return null;
  return (
    <group name="result-probes">
      {showExtremes &&
        extremes?.kind === "value" &&
        (["min", "max"] as const).map((end) => (
          <ProbeMarker
            key={end}
            testId={end}
            name={text[end]}
            kind={end}
            {...extremes[end]}
            {...common}
          />
        ))}
      {placed.map(({ probe, reading }) =>
        reading?.kind === "value" ? (
          <ProbeMarker
            key={probe.id}
            testId={String(probe.id)}
            name={probeLabel(probe)}
            kind="placed"
            at={reading.at}
            displacement={reading.displacement}
            value={reading.value}
            {...common}
          />
        ) : null,
      )}
    </group>
  );
}
