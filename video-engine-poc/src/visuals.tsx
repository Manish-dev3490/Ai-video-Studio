import type { CSSProperties, ReactNode } from "react";

export type Tone = "cyan" | "mint" | "amber" | "muted";

type Toned = { tone?: Tone; style?: CSSProperties };

export const Label = ({
  children,
  tone = "cyan",
  style,
}: Toned & { children: ReactNode }) => (
  <span className={`visual-label tone-${tone}`} style={style}>
    {children}
  </span>
);

export const Panel = ({
  label,
  tone = "muted",
  children,
  style,
}: Toned & { label: string; children: ReactNode }) => (
  <section className={`visual-panel tone-${tone}`} style={style}>
    <h2>{label}</h2>
    {children}
  </section>
);

type StackProps = {
  items: readonly string[];
  activeItem?: string;
  itemStyles?: readonly (CSSProperties | undefined)[];
  label?: string;
  style?: CSSProperties;
};

export const Stack = ({
  items,
  activeItem,
  itemStyles,
  label = "Call stack",
  style,
}: StackProps) => (
  <Panel label={label} tone="cyan" style={style}>
    <div className="stack-items">
      {items.length === 0 && <div className="empty-item">Stack is empty</div>}
      {items.map((name, index) => (
        <div
          key={name}
          className={`visual-item stack-item${name === activeItem ? " active" : ""}`}
          style={itemStyles?.[index]}
        >
          {name}
        </div>
      ))}
    </div>
  </Panel>
);

export const Queue = ({
  label,
  items,
  tone = "cyan",
  emptyLabel = "Queue is empty",
  style,
}: Toned & {
  label: string;
  items: readonly string[];
  emptyLabel?: string;
}) => (
  <Panel label={label} tone={tone} style={style}>
    <div className="queue-items">
      {items.length === 0 && <div className="empty-item">{emptyLabel}</div>}
      {items.map((name) => (
        <div key={name} className="visual-item queue-item active">
          {name}
        </div>
      ))}
    </div>
  </Panel>
);

type Direction = "right" | "left" | "up" | "down";

const arrowGeometry = {
  right: { line: "M4 12H94", tip: "M84 5L94 12L84 19", box: "0 0 100 24" },
  left: { line: "M96 12H6", tip: "M16 5L6 12L16 19", box: "0 0 100 24" },
  down: { line: "M12 4V94", tip: "M5 84L12 94L19 84", box: "0 0 24 100" },
  up: { line: "M12 96V6", tip: "M5 16L12 6L19 16", box: "0 0 24 100" },
};

export const Arrow = ({
  direction = "right",
  progress = 1,
  tone = "cyan",
  style,
}: Toned & { direction?: Direction; progress?: number }) => {
  const { line, tip, box } = arrowGeometry[direction];
  const vertical = direction === "up" || direction === "down";
  const fraction = Math.max(0, Math.min(1, progress));

  return (
    <svg
      aria-hidden="true"
      className={`visual-arrow tone-${tone}`}
      viewBox={box}
      width={vertical ? 24 : 68}
      height={vertical ? 68 : 24}
      preserveAspectRatio="none"
      style={style}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={line} opacity={0.2} vectorEffect="non-scaling-stroke" />
      <path
        d={line}
        pathLength={1}
        strokeDasharray={1}
        strokeDashoffset={1 - fraction}
        opacity={fraction === 0 ? 0 : 1}
        vectorEffect="non-scaling-stroke"
      />
      <path
        d={tip}
        opacity={0.2 + Math.max(0, (fraction - 0.8) * 4)}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
};

export const Caption = ({
  children,
  tone = "cyan",
}: {
  children: ReactNode;
  tone?: Tone;
}) => <div className={`scene-caption tone-${tone}`}>{children}</div>;
