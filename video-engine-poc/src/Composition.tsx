import {
  AbsoluteFill,
  Html5Audio,
  Sequence,
  staticFile,
  useCurrentFrame,
} from "remotion";
import { easeInOut } from "./motion";
import { AsyncScene } from "./scenes/AsyncScene";
import { CallStackScene } from "./scenes/CallStackScene";
import { EventLoopScene } from "./scenes/EventLoopScene";
import { IntroScene } from "./scenes/IntroScene";
import { QueuesScene } from "./scenes/QueuesScene";
import type { SceneData } from "./storyboard";
import "./video.css";

export type EventLoopVideoProps = { storyboard: readonly SceneData[] };

const SceneContent = ({ scene }: { scene: SceneData }) => {
  switch (scene.kind) {
    case "intro":
      return <IntroScene scene={scene} />;
    case "stack":
      return <CallStackScene scene={scene} />;
    case "async":
      return <AsyncScene scene={scene} />;
    case "queues":
      return <QueuesScene scene={scene} />;
    case "loop":
      return <EventLoopScene scene={scene} />;
  }
};

const Scene = ({ scene }: { scene: SceneData }) => {
  const frame = useCurrentFrame();
  const entered = easeInOut(frame, 0, 10);
  const lastFrame = scene.durationInFrames - 1;
  const leaving =
    scene.kind === "loop" ? 0 : easeInOut(frame, lastFrame - 7, lastFrame);

  return (
    <AbsoluteFill
      style={{
        opacity: (0.66 + 0.34 * entered) * (1 - 0.34 * leaving),
        transform: `translateY(${(1 - entered) * 10 - 5 * leaving}px)`,
      }}
    >
      {scene.kind !== "intro" && (
        <header className="scene-header">
          <h1>{scene.title}</h1>
          <p>{scene.subtitle}</p>
        </header>
      )}
      <SceneContent scene={scene} />
    </AbsoluteFill>
  );
};

export const EventLoopVideo = ({ storyboard }: EventLoopVideoProps) => {
  const frame = useCurrentFrame();
  let cursor = 0;
  const segments = storyboard.map((scene) => {
    const from = cursor;
    cursor += scene.durationInFrames;
    return { scene, from };
  });

  return (
    <AbsoluteFill className="video-canvas">
      {segments.map(({ scene, from }) => (
        <Sequence
          key={scene.kind}
          from={from}
          name={scene.title}
          durationInFrames={scene.durationInFrames}
        >
          <Scene scene={scene} />
          {scene.narration && (
            <Sequence
              from={scene.narration.offsetInFrames}
              durationInFrames={
                scene.durationInFrames - scene.narration.offsetInFrames
              }
              name="Narration"
              style={{ pointerEvents: "none" }}
            >
              <Html5Audio
                src={staticFile(`narration/${scene.narration.file}`)}
              />
            </Sequence>
          )}
        </Sequence>
      ))}
      <div className="video-progress">
        {segments.map(({ scene, from }) => {
          const filled = Math.max(
            0,
            Math.min(1, (frame - from + 1) / scene.durationInFrames),
          );
          return (
            <div
              key={scene.kind}
              className="progress-segment"
              style={{ flexGrow: scene.durationInFrames }}
            >
              <div style={{ transform: `scaleX(${filled})` }} />
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
