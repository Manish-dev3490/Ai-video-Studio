import { useCurrentFrame } from "remotion";
import { easeInOut } from "../motion";
import type { IntroSceneData } from "../storyboard";
import { Caption, Panel } from "../visuals";

const steps = [
  { x: 250, y: 24, tone: "cyan" },
  { x: 406, y: 238, tone: "mint" },
  { x: 94, y: 238, tone: "amber" },
] as const;

const routes = [
  { d: "M272 33C357 42 410 92 414 199", tip: "M407 190l7 9 6-10" },
  { d: "M365 244C292 275 209 275 135 244", tip: "M147 243l-12 1 7 10" },
  { d: "M87 199C90 92 143 42 228 33", tip: "M218 27l10 6-9 7" },
] as const;

export const IntroScene = ({ scene }: { scene: IntroSceneData }) => {
  const frame = useCurrentFrame();

  return (
    <>
      <div className="intro-body">
        <div className="intro-title">
          <h1>{scene.title}</h1>
          <p>{scene.subtitle}</p>
        </div>
        <Panel label="Inside the browser" style={{ width: 546, height: 377 }}>
          <div className="intro-diagram">
            <svg
              viewBox="0 0 500 280"
              width="500"
              height="280"
              aria-hidden="true"
            >
              {routes.map(({ d, tip }, index) => {
                const { tone } = steps[index];
                const from = 14 + index * 15;
                const drawn = easeInOut(frame, from, from + 24);
                return (
                  <g
                    key={d}
                    fill="none"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d={d} stroke="var(--line)" />
                    <path
                      d={d}
                      stroke={`var(--${tone})`}
                      pathLength={1}
                      strokeDasharray={1}
                      strokeDashoffset={1 - drawn}
                      opacity={drawn > 0 ? 0.82 : 0}
                    />
                    <path
                      d={tip}
                      stroke={`var(--${tone})`}
                      opacity={drawn ** 5}
                    />
                  </g>
                );
              })}
            </svg>
            <div className="loop-center">
              Event
              <br />
              loop
            </div>
            {scene.steps.map((label, index) => {
              const { x, y, tone } = steps[index];
              const entered = easeInOut(frame, 5 + index * 15, 20 + index * 15);
              return (
                <div
                  className={`intro-node tone-${tone}`}
                  key={label}
                  style={{
                    left: x,
                    top: y,
                    opacity: 0.25 + 0.75 * entered,
                    transform: `translate(-50%, ${(1 - entered) * 10}px)`,
                  }}
                >
                  {label}
                </div>
              );
            })}
          </div>
        </Panel>
      </div>
      <Caption>{scene.note}</Caption>
    </>
  );
};
