import type { FC } from "react";
import { useCurrentFrame } from "remotion";
import { easeInOut } from "../motion";
import type { CallStackSceneData } from "../storyboard";
import { Arrow, Caption, Label, Panel, Stack } from "../visuals";

const pushFrames = [5, 30, 56];
const returnFrames = [141, 117, 92];
const motionFrames = 12;

const move = (frame: number, start: number) =>
  easeInOut(frame, start, start + motionFrames);

export const CallStackScene: FC<{ scene: CallStackSceneData }> = ({
  scene,
}) => {
  const frame = useCurrentFrame();
  const frames = scene.calls
    .map((name, index) => ({
      name,
      enters: pushFrames[index],
      returns: returnFrames[index],
    }))
    .filter(
      ({ enters, returns }) =>
        frame >= enters && frame < returns + motionFrames,
    );
  const activeFrame = frames[frames.length - 1];
  const returning = returnFrames.findIndex((start) => frame >= start);
  const hasReturned = frame >= returnFrames[0] + motionFrames;
  const actionTone = returning === -1 ? "cyan" : "mint";
  const actionStart =
    returning === -1 ? activeFrame?.enters : returnFrames[returning];
  const currentCall =
    returning === -1
      ? (activeFrame?.name ?? scene.calls[0])
      : scene.calls[returning];
  const codeHighlight = frames.length - 1;

  return (
    <>
      <div className="scene-body">
        <Panel label="Function calls" style={{ width: 509, height: 332 }}>
          <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
            {scene.code.map((line, index) => {
              const active = index === codeHighlight;
              return (
                <div
                  key={line}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    minHeight: 49,
                    padding: "0 14px",
                    font: "19px var(--mono)",
                    borderRadius: 9,
                    border: `1px solid ${active ? "var(--cyan)" : "var(--line)"}`,
                    color: active ? "var(--text)" : "var(--muted)",
                    background: active
                      ? "rgba(96, 223, 255, 0.09)"
                      : "rgba(0, 0, 0, 0.1)",
                    whiteSpace: "pre",
                  }}
                >
                  {line}
                </div>
              );
            })}
          </div>

          <div
            style={{
              marginTop: 16,
              display: "flex",
              alignItems: "center",
              gap: 12,
            }}
          >
            <Label tone={hasReturned ? "muted" : actionTone}>
              {hasReturned ? "COMPLETE" : returning === -1 ? "PUSH" : "RETURN"}
            </Label>
            <span style={{ color: "var(--text)", font: "20px var(--mono)" }}>
              {hasReturned ? "Stack is empty" : currentCall}
            </span>
          </div>
        </Panel>

        <Arrow
          direction={returning === -1 ? "right" : "left"}
          tone={actionTone}
          progress={actionStart === undefined ? 0 : move(frame, actionStart)}
          style={{
            position: "absolute",
            left: 522,
            top: 144,
            width: 67,
            height: 36,
            opacity:
              returning === -1
                ? 1
                : 1 -
                  easeInOut(
                    frame,
                    returnFrames[returning] + 9,
                    returnFrames[returning] + 18,
                  ),
          }}
        />

        <Stack
          items={frames.map(({ name }) => name)}
          activeItem={activeFrame?.name}
          itemStyles={frames.map(({ enters, returns }) => {
            const arriving = move(frame, enters);
            const leaving = move(frame, returns);
            return {
              opacity: arriving * (1 - leaving),
              transform: `translateY(${-(1 - arriving) * 27 - leaving * 28}px)`,
            };
          })}
          style={{
            position: "absolute",
            right: 0,
            top: 0,
            width: 535,
            height: 332,
          }}
        />
      </div>

      <Caption tone={hasReturned ? "muted" : actionTone}>
        {hasReturned
          ? scene.notes.complete
          : returning === -1
            ? scene.notes.push
            : scene.notes.pop}
      </Caption>
    </>
  );
};
