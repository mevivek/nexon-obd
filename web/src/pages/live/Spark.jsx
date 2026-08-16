// One sparkline. See spark.js for the geometry and why it is a bare polyline.

import { sparkPath, SPARK_W, SPARK_H } from './spark.js';

/**
 * @param {{data: number[], color: string, zero?: boolean, label: string}} props
 *   `color` is a CSS variable reference, e.g. `var(--blue)`, applied through the
 *   style attribute. The firmware resolved it with getComputedStyle because it was
 *   building an HTML string; here the browser resolves it, which keeps the palette
 *   in the one stylesheet where it belongs.
 */
export function Spark({ data, color, zero, label }) {
  const p = sparkPath(data, zero);
  return (
    <svg
      class="spark"
      preserveAspectRatio="none"
      viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
      aria-label={label}
      role="img"
    >
      {p && (
        <polyline
          points={p.points}
          fill="none"
          style={`stroke:${color}`}
          stroke-width="2"
          stroke-linejoin="round"
          stroke-linecap="round"
          vector-effect="non-scaling-stroke"
        />
      )}
    </svg>
  );
}
