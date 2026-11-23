import { interpolate, useCurrentFrame } from "remotion";
import { easeInOut } from "../motion";
import type { EventLoopSceneData } from "../storyboard";
import { Caption, Label, Panel, Queue, Stack } from "../visuals";

const microtask = { dispatch: 19, arrive: 54, log: 63, clear: 77 };
const task = { dispatch: 86, arrive: 121, log: 130, clear: 144 };
const outputTones = ["cyan", "cyan", "mint", "amber"] as const;
const clamped = {
  extrapolateLeft: "clamp",
  extrapolateRight: "clamp",
} as const;
const promiseRouteY = 82;
const timerRouteY = 220;
const stackRouteY = 210;
const routePath = (originY: number) =>
  `M 9 ${originY} H 116 L 228 ${stackRouteY} H 367`;

const Route: React.FC<{
  originY: number;
  tone: "mint" | "amber";
  value: string;
  progress: number;
}> = ({ originY, tone, value, progress }) => {
  if (progress === 0) {
    return null;
  }

  const accent = `var(--${tone})`;
  const travelling = progress < 1;
  const bendLength = Math.hypot(112, originY - stackRouteY);
  const bendStart = 107;
  const bendEnd = bendStart + bendLength;
  const distance = progress * (bendEnd + 139);
  const bendProgress = interpolate(
    distance,
    [bendStart, bendEnd],
    [0, 1],
    clamped,
  );
  const tokenX =
    9 +
    Math.min(distance, bendStart) +
    112 * bendProgress +
    Math.max(0, distance - bendEnd);
  const tokenY = interpolate(bendProgress, [0, 1], [originY, stackRouteY]);

  return (
    <>
      <path
        d={routePath(originY)}
        fill="none"
        stroke={accent}
        strokeWidth={3}
        strokeLinejoin="round"
        strokeDasharray={100}
        strokeDashoffset={(1 - progress) * 100}
        strokeOpacity={travelling ? 0.85 : 0.35}
        pathLength={100}
      />
      {travelling && (
        <g transform={`translate(${tokenX} ${tokenY})`}>
          <circle r={15} fill={accent} />
          <text
            fill="var(--ink)"
            fontFamily="var(--mono)"
            fontSize={15}
            fontWeight={700}
            textAnchor="middle"
            dominantBaseline="central"
          >
            {value}
          </text>
        </g>
      )}
    </>
  );
};

export const EventLoopScene: React.FC<{ scene: EventLoopSceneData }> = ({
  scene,
}) => {
  const frame = useCurrentFrame();
  const { example, notes } = scene;
  const microtaskProgress = easeInOut(
    frame,
    microtask.dispatch,
    microtask.arrive,
  );
  const taskProgress = easeInOut(frame, task.dispatch, task.arrive);
  const microtaskRunning = frame >= microtask.arrive && frame < microtask.clear;
  const taskRunning = frame >= task.arrive && frame < task.clear;
  const activeCallback = microtaskRunning
    ? example.promiseLabel
    : taskRunning
      ? example.timerLabel
      : undefined;
  const outputFrames = [0, 0, microtask.log, task.log];
  const checkpoint = frame < task.dispatch;
  const complete = frame >= task.clear;
  const activeTone = checkpoint || complete ? "mint" : "amber";
  const note = complete
    ? notes.complete
    : frame < microtask.dispatch
      ? notes.ready
      : checkpoint
        ? notes.microtask
        : notes.task;

  return (
    <>
      <div
        className="scene-body"
        style={{
          display: "grid",
          gridTemplateColumns: "370px 376px 390px",
          gridTemplateRows: "262px 103px",
          rowGap: 20,
        }}
      >
        <div
          style={{
            display: "grid",
            gridTemplateRows: "repeat(2, minmax(0, 1fr))",
            gap: 14,
          }}
        >
          <Queue
            label="Microtask queue"
            items={frame <= microtask.dispatch ? [example.promiseLabel] : []}
            tone="mint"
            emptyLabel="Empty"
          />
          <Queue
            label="Task queue"
            items={frame <= task.dispatch ? [example.timerLabel] : []}
            tone="amber"
            emptyLabel="Empty"
          />
        </div>

        <div style={{ position: "relative" }}>
          <svg
            width={376}
            height={262}
            viewBox="0 0 376 262"
            style={{ overflow: "visible" }}
            aria-hidden="true"
          >
            <path
              d={`${routePath(promiseRouteY)} ${routePath(timerRouteY)}`}
              fill="none"
              stroke="var(--line)"
              strokeWidth={2}
              strokeLinejoin="round"
            />
            <Route
              originY={promiseRouteY}
              tone="mint"
              value={example.output[2]}
              progress={microtaskProgress}
            />
            <Route
              originY={timerRouteY}
              tone="amber"
              value={example.output[3]}
              progress={taskProgress}
            />
            <path
              d={`M 357 ${stackRouteY - 9} l 10 9 -10 9`}
              fill="none"
              stroke={`var(--${activeTone})`}
              strokeWidth={2.5}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          </svg>

          <div
            style={{
              position: "absolute",
              inset: "21px 0 auto",
              display: "grid",
              justifyItems: "center",
              gap: 8,
              color: "var(--muted)",
            }}
          >
            <Label tone={activeTone}>Event loop</Label>
          </div>
          <div
            style={{
              position: "absolute",
              inset: "90px 12px auto 150px",
              textAlign: "center",
              color: "var(--muted)",
              fontSize: 16,
            }}
          >
            {complete
              ? "Both queues empty"
              : checkpoint
                ? "Microtask checkpoint"
                : "Next task"}
          </div>
        </div>

        <Stack
          label="Call stack"
          items={activeCallback ? [activeCallback] : []}
          activeItem={activeCallback}
        />

        <Panel
          label="Console output"
          style={{ gridColumn: "1 / -1", justifyContent: "center" }}
        >
          <div
            style={{
              position: "absolute",
              inset: "18px 22px 18px 210px",
              display: "grid",
              gridTemplateColumns: "repeat(4, 1fr)",
              gap: 12,
            }}
          >
            {example.output.map((value, index) => {
              const start = outputFrames[index];
              const arrival =
                index < 2
                  ? 1
                  : interpolate(frame, [start, start + 8], [0, 1], clamped);
              const accent = `var(--${outputTones[index]})`;

              return (
                <div
                  key={index}
                  style={{
                    position: "relative",
                    display: "grid",
                    placeItems: "center",
                    border: "1px dashed var(--line)",
                    borderRadius: 10,
                    color: "var(--muted)",
                  }}
                >
                  <span style={{ opacity: 1 - arrival }}>·</span>
                  <div
                    style={{
                      position: "absolute",
                      inset: -1,
                      display: "grid",
                      placeItems: "center",
                      border: `1px solid color-mix(in srgb, ${accent} 44%, transparent)`,
                      borderRadius: 10,
                      background: `color-mix(in srgb, ${accent} 10%, var(--ink))`,
                      color: accent,
                      fontFamily: "var(--mono)",
                      fontSize: 31,
                      fontWeight: 700,
                      opacity: arrival,
                      transform: `translateY(${(1 - arrival) * 7}px)`,
                    }}
                  >
                    {value}
                  </div>
                </div>
              );
            })}
          </div>
        </Panel>
      </div>

      <Caption tone={activeTone}>{note}</Caption>
    </>
  );
};
