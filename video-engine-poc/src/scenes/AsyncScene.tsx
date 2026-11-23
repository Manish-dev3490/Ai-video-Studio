import type { FC } from "react";
import { interpolate, useCurrentFrame } from "remotion";
import { easeInOut } from "../motion";
import type { AsyncSceneData } from "../storyboard";
import { Arrow, Caption, Label, Panel, Queue, Stack } from "../visuals";

const scheduleAt = 20;
const timerStartsAt = 45;
const timerExpiresAt = 105;
const taskArrivesAt = 135;
const scriptEndsAt = 175;

const progressAt = (frame: number, from: number, to: number) =>
  interpolate(frame, [from, to], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

const Transfer: FC<{
  frame: number;
  from: number;
  to: number;
  left: number;
  tone: "cyan" | "amber";
}> = ({ frame, from, to, left, tone }) => {
  const movement = easeInOut(frame, from, to);

  return (
    <>
      <Arrow
        tone={tone}
        progress={progressAt(frame, from, from + 10)}
        style={{
          position: "absolute",
          left,
          top: 147,
          width: 90,
          height: 36,
          opacity: movement < 1 ? 1 : 0.65,
        }}
      />
      {movement > 0 && movement < 1 ? (
        <div
          style={{
            position: "absolute",
            left: left + movement * 83,
            top: 159,
            width: 12,
            height: 12,
            borderRadius: "50%",
            color: `var(--${tone})`,
            background: "currentColor",
            boxShadow: "0 0 16px currentColor",
          }}
        />
      ) : null}
    </>
  );
};

export const AsyncScene: FC<{ scene: AsyncSceneData }> = ({ scene }) => {
  const frame = useCurrentFrame();
  const elapsed = progressAt(frame, timerStartsAt, timerExpiresAt);
  const timerStarted = frame >= timerStartsAt;
  const timerDone = frame >= timerExpiresAt;
  const callbackQueued = frame >= taskArrivesAt;
  const scriptLeaving = progressAt(frame, scriptEndsAt - 12, scriptEndsAt);
  const queueEntry = progressAt(frame, taskArrivesAt, taskArrivesAt + 12);

  return (
    <>
      <div className="scene-body">
        <Stack
          label={scene.headings.stack}
          items={scriptLeaving < 1 ? [scene.script] : []}
          activeItem={scene.script}
          itemStyles={[
            {
              opacity: 1 - scriptLeaving,
              transform: `translateY(${-24 * scriptLeaving}px)`,
            },
          ]}
          style={{ position: "absolute", left: 0, width: 300, height: 332 }}
        />
        <div
          style={{
            position: "absolute",
            left: 18,
            top: 104,
            width: 264,
            color: "var(--text)",
            font: "16px var(--mono)",
            textAlign: "center",
            padding: "13px 6px",
            border: `1px solid ${frame >= scheduleAt ? "var(--cyan)" : "var(--line)"}`,
            borderRadius: 9,
            background:
              frame >= scheduleAt
                ? "rgba(96, 223, 255, 0.09)"
                : "rgba(0, 0, 0, 0.1)",
            opacity: 1 - scriptLeaving,
            whiteSpace: "nowrap",
          }}
        >
          {scene.timerCall}
        </div>

        <Transfer
          frame={frame}
          from={scheduleAt}
          to={timerStartsAt}
          left={312}
          tone="cyan"
        />

        <Panel
          label={scene.headings.webApi}
          tone={timerStarted ? "cyan" : "muted"}
          style={{ position: "absolute", left: 414, width: 308, height: 332 }}
        >
          <div
            style={{
              display: "grid",
              justifyItems: "center",
              alignContent: "center",
              gap: 15,
              flex: 1,
              minHeight: 200,
            }}
          >
            <svg
              width="112"
              height="112"
              viewBox="0 0 112 112"
              aria-hidden="true"
            >
              <circle
                cx="56"
                cy="56"
                r="45"
                fill="none"
                stroke="var(--line)"
                strokeWidth="5"
              />
              <circle
                cx="56"
                cy="56"
                r="45"
                fill="none"
                stroke={timerDone ? "var(--mint)" : "var(--cyan)"}
                strokeWidth="5"
                strokeLinecap="round"
                pathLength="1"
                strokeDasharray="1"
                strokeDashoffset={1 - elapsed}
                opacity={timerStarted ? 1 : 0}
                transform="rotate(-90 56 56)"
              />
              <path
                d="M56 56L56 28 M56 56L74 56"
                fill="none"
                stroke={timerStarted ? "var(--text)" : "var(--muted)"}
                strokeWidth="4"
                strokeLinecap="round"
                transform={`rotate(${elapsed * 360} 56 56)`}
              />
              <circle cx="56" cy="56" r="4" fill="var(--text)" />
            </svg>
            <Label tone={timerDone ? "mint" : timerStarted ? "cyan" : "muted"}>
              {timerDone
                ? "Delay elapsed"
                : timerStarted
                  ? scene.timer
                  : "Waiting for request"}
            </Label>
          </div>
        </Panel>

        <Transfer
          frame={frame}
          from={timerExpiresAt}
          to={taskArrivesAt}
          left={734}
          tone="amber"
        />

        <Queue
          label={scene.headings.queue}
          items={callbackQueued ? [scene.callback] : []}
          tone="amber"
          emptyLabel="No tasks queued"
          style={{ position: "absolute", right: 0, width: 300, height: 332 }}
        />
        {callbackQueued ? (
          <Label
            tone="amber"
            style={{
              position: "absolute",
              left: 860,
              top: 83,
              opacity: queueEntry,
              transform: `translateY(${(1 - queueEntry) * 8}px)`,
            }}
          >
            {scriptLeaving < 1 ? "Waiting to run" : "Ready to run"}
          </Label>
        ) : null}
      </div>

      <Caption tone={callbackQueued ? "amber" : "cyan"}>
        {callbackQueued
          ? scene.notes.queued
          : timerStarted
            ? scene.notes.wait
            : scene.notes.schedule}
      </Caption>
    </>
  );
};
