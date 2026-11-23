import { Easing, interpolate, useCurrentFrame } from "remotion";
import type { QueuesSceneData } from "../storyboard";
import { Caption, Label, Panel, Queue } from "../visuals";

const scriptSteps = [
  { end: 29, tone: "cyan", note: "sync" },
  { end: 67, tone: "amber", note: "timer" },
  { end: 106, tone: "mint", note: "promise" },
  { end: 139, tone: "cyan", note: "lastSync" },
] as const;

const promiseQueuedAt = 79;
const timerTaskQueuedAt = 124;
const outputFrames = [15, 116] as const;
const clamped = {
  extrapolateLeft: "clamp",
  extrapolateRight: "clamp",
} as const;
const rowHeight = 48;
const rowGap = 8;
const rowPitch = rowHeight + rowGap;
const [logA, scheduleTimer, queuePromise] = scriptSteps;
const highlightFrames = [
  0,
  logA.end,
  logA.end + 8,
  scheduleTimer.end,
  scheduleTimer.end + 8,
  queuePromise.end,
  queuePromise.end + 8,
];

const queuePulse = (frame: number, start: number, tone: "mint" | "amber") => {
  const opacity = interpolate(
    frame,
    [start, start + 6, start + 24],
    [0, 40, 0],
    clamped,
  );
  return `0 0 26px color-mix(in srgb, var(--${tone}) ${opacity}%, transparent)`;
};

export const QueuesScene: React.FC<{ scene: QueuesSceneData }> = ({
  scene,
}) => {
  const frame = useCurrentFrame();
  const { example, notes } = scene;
  const activeLine = scriptSteps.findIndex((step) => frame < step.end);
  const activeStep = scriptSteps[activeLine];
  const finishedScript = activeLine === -1;
  const promiseQueued = frame >= promiseQueuedAt;
  const timerTaskQueued = frame >= timerTaskQueuedAt;
  const timerScheduled = frame >= scriptSteps[0].end;
  const highlightAccent = `var(--${activeStep?.tone ?? "cyan"})`;
  const highlightY = interpolate(
    frame,
    highlightFrames,
    [0, 0, rowPitch, rowPitch, rowPitch * 2, rowPitch * 2, rowPitch * 3],
    { ...clamped, easing: Easing.inOut(Easing.cubic) },
  );
  const highlightOpacity = interpolate(frame, [139, 147], [1, 0], clamped);

  return (
    <>
      <div
        className="scene-body"
        style={{
          display: "grid",
          gridTemplateColumns: "585px minmax(0, 1fr)",
          gap: 32,
        }}
      >
        <Panel
          label="Example script"
          style={{ height: "100%", position: "relative" }}
        >
          <div
            style={{
              display: "grid",
              gap: rowGap,
              marginTop: 16,
              position: "relative",
            }}
          >
            <div
              style={{
                position: "absolute",
                inset: "0 0 auto",
                height: rowHeight,
                borderRadius: 8,
                border: `1px solid color-mix(in srgb, ${highlightAccent} 37%, transparent)`,
                background: `color-mix(in srgb, ${highlightAccent} 10%, transparent)`,
                opacity: highlightOpacity,
                transform: `translateY(${highlightY}px)`,
              }}
            />
            {example.code.map((line, index) => {
              const active = index === activeLine;

              return (
                <div
                  key={index}
                  style={{
                    position: "relative",
                    display: "flex",
                    gap: 14,
                    alignItems: "center",
                    height: rowHeight,
                    color: active ? "var(--text)" : "var(--muted)",
                    fontFamily: "var(--mono)",
                    whiteSpace: "pre",
                    padding: "0 10px",
                  }}
                >
                  <span
                    style={{
                      fontSize: 14,
                      color: active ? highlightAccent : "var(--muted)",
                    }}
                  >
                    {index + 1}
                  </span>
                  <code style={{ fontFamily: "inherit", fontSize: 17 }}>
                    {line}
                  </code>
                </div>
              );
            })}
          </div>

          <div
            style={{
              position: "absolute",
              inset: "auto 22px 23px",
              display: "flex",
              alignItems: "center",
              gap: 10,
              paddingTop: 16,
              borderTop: "1px solid var(--line)",
            }}
          >
            <span
              style={{ color: "var(--muted)", fontSize: 16, marginRight: 8 }}
            >
              Console output
            </span>
            {outputFrames.map((start, index) => {
              const arrival = interpolate(
                frame,
                [start, start + 8],
                [0, 1],
                clamped,
              );

              return (
                <Label
                  key={index}
                  tone="cyan"
                  style={{
                    fontFamily: "var(--mono)",
                    minWidth: 40,
                    justifyContent: "center",
                    opacity: arrival,
                    transform: `translateY(${(1 - arrival) * 7}px)`,
                  }}
                >
                  {example.output[index]}
                </Label>
              );
            })}
          </div>
        </Panel>

        <div
          style={{
            display: "grid",
            gridTemplateRows: "1fr 1fr 42px",
            gap: 14,
          }}
        >
          <Queue
            label="Microtask queue"
            items={promiseQueued ? [example.promiseLabel] : []}
            tone="mint"
            emptyLabel="Empty"
            style={{ boxShadow: queuePulse(frame, promiseQueuedAt, "mint") }}
          />
          <Queue
            label="Task queue"
            items={timerTaskQueued ? [example.timerLabel] : []}
            tone="amber"
            emptyLabel={timerScheduled ? "Waiting for timer" : "Empty"}
            style={{ boxShadow: queuePulse(frame, timerTaskQueuedAt, "amber") }}
          />
          <Label
            tone={finishedScript ? "mint" : "cyan"}
            style={{ alignSelf: "center", justifySelf: "start" }}
          >
            {finishedScript ? "Script finished" : "Script running"}
          </Label>
        </div>
      </div>

      <Caption tone={activeStep?.tone ?? "mint"}>
        {activeStep ? notes[activeStep.note] : notes.priority}
      </Caption>
    </>
  );
};
