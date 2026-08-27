import type { GraphRow } from '../../utils/commitGraph';

const LANE_WIDTH = 14;
const ROW_HEIGHT = 40;
const DOT_RADIUS = 4;
const HALF = ROW_HEIGHT / 2;

type Props = {
  row: GraphRow;
  rowIndex: number;
};

export default function CommitGraphStrip({ row }: Props) {
  const svgWidth = Math.max(1, row.laneCount) * LANE_WIDTH + LANE_WIDTH;
  const cx = row.lane * LANE_WIDTH + LANE_WIDTH / 2;
  const cy = HALF;

  return (
    <svg
      width={svgWidth}
      height={ROW_HEIGHT}
      className="flex-shrink-0"
      aria-hidden="true"
    >
      {/* Straight-through vertical edges */}
      {row.edges.map((edge, i) => {
        const x = edge.fromLane * LANE_WIDTH + LANE_WIDTH / 2;
        return (
          <line
            key={`edge-${i}`}
            x1={x}
            y1={0}
            x2={x}
            y2={ROW_HEIGHT}
            stroke={edge.color}
            strokeWidth={2}
          />
        );
      })}

      {/* Vertical line through this commit's lane (top half) */}
      <line
        x1={cx}
        y1={0}
        x2={cx}
        y2={cy}
        stroke={row.color}
        strokeWidth={2}
      />

      {/* Merge / branch-off curves */}
      {row.mergeEdges.map((edge, i) => {
        const srcX = edge.fromLane * LANE_WIDTH + LANE_WIDTH / 2;
        const dstX = edge.toLane * LANE_WIDTH + LANE_WIDTH / 2;
        const midY = ROW_HEIGHT * 0.75;
        return (
          <path
            key={`merge-${i}`}
            d={`M ${srcX} ${cy} C ${srcX} ${midY}, ${dstX} ${midY}, ${dstX} ${ROW_HEIGHT}`}
            stroke={edge.color}
            strokeWidth={2}
            fill="none"
          />
        );
      })}

      {/* Vertical line through this commit's lane (bottom half — only if has parent) */}
      <line
        x1={cx}
        y1={cy}
        x2={cx}
        y2={ROW_HEIGHT}
        stroke={row.color}
        strokeWidth={2}
        opacity={0.4}
      />

      {/* Commit dot */}
      <circle
        cx={cx}
        cy={cy}
        r={DOT_RADIUS}
        fill={row.color}
        stroke="var(--background)"
        strokeWidth={1.5}
      />
    </svg>
  );
}
