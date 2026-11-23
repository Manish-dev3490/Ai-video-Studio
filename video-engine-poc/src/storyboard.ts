import narration from "./narration.json";

type NarrationCue = {
  file: string;
  offsetInFrames: number;
};

type SceneBase = {
  title: string;
  subtitle: string;
  durationInFrames: number;
  narration?: NarrationCue;
};

export type IntroSceneData = SceneBase & {
  kind: "intro";
  steps: readonly [string, string, string];
  note: string;
};

export type CallStackSceneData = SceneBase & {
  kind: "stack";
  calls: readonly [string, string, string];
  code: readonly [string, string, string];
  notes: { push: string; pop: string; complete: string };
};

export type AsyncSceneData = SceneBase & {
  kind: "async";
  script: string;
  timerCall: string;
  timer: string;
  callback: string;
  headings: { stack: string; webApi: string; queue: string };
  notes: { schedule: string; wait: string; queued: string };
};

type Example = {
  code: readonly [string, string, string, string];
  promiseLabel: string;
  timerLabel: string;
  output: readonly [string, string, string, string];
};

export type QueuesSceneData = SceneBase & {
  kind: "queues";
  example: Example;
  notes: {
    sync: string;
    timer: string;
    promise: string;
    lastSync: string;
    priority: string;
  };
};

export type EventLoopSceneData = SceneBase & {
  kind: "loop";
  example: Example;
  notes: { ready: string; microtask: string; task: string; complete: string };
};

export type SceneData =
  | IntroSceneData
  | CallStackSceneData
  | AsyncSceneData
  | QueuesSceneData
  | EventLoopSceneData;

const example: Example = {
  code: [
    'console.log("A");',
    'setTimeout(() => console.log("D"), 0);',
    'Promise.resolve().then(() => console.log("C"));',
    'console.log("B");',
  ],
  promiseLabel: "Promise callback",
  timerLabel: "Timer callback",
  output: ["A", "B", "C", "D"],
};

export const eventLoopStoryboard: readonly SceneData[] = [
  {
    kind: "intro",
    title: "The JavaScript\nEvent Loop",
    subtitle: "How the browser decides which JavaScript runs next.",
    durationInFrames: 120,
    narration: narration.intro,
    steps: ["Run the current task", "Drain microtasks", "Run the next task"],
    note: "One call stack. Multiple sources of work.",
  },
  {
    kind: "stack",
    title: "The call stack",
    subtitle: "Every function call adds a frame. Returning removes it.",
    durationInFrames: 180,
    narration: narration.stack,
    calls: ["main()", "greet()", "format()"],
    code: [
      "main();",
      "function main() { greet(); }",
      "function greet() { format(); }",
    ],
    notes: {
      push: "The function on top is the one running now.",
      pop: "Last in, first out. format() returns before greet() and main().",
      complete: "The script finishes after main() returns. The stack is empty.",
    },
  },
  {
    kind: "async",
    title: "The browser handles timers",
    subtitle:
      "A browser Web API can manage a timer while the script continues.",
    durationInFrames: 210,
    narration: narration.async,
    script: "Current script",
    timerCall: "setTimeout(onTimer, 1000)",
    timer: "Timer running",
    callback: "onTimer()",
    headings: {
      stack: "Call stack",
      webApi: "Browser Web APIs",
      queue: "Task queue",
    },
    notes: {
      schedule: "setTimeout() registers the callback with the browser.",
      wait: "The browser tracks the delay while JavaScript can keep running.",
      queued:
        "When the delay elapses, the browser queues a task for the callback.",
    },
  },
  {
    kind: "queues",
    title: "Two kinds of queue",
    subtitle:
      "A fulfilled Promise’s .then() callback is a microtask. A timer callback runs as a task.",
    durationInFrames: 210,
    narration: narration.queues,
    example,
    notes: {
      sync: "The current script starts by logging A.",
      timer: "setTimeout(..., 0) schedules a timer. The script keeps running.",
      promise:
        "The resolved Promise queues its .then() callback as a microtask.",
      lastSync: "The script logs B before either callback can run.",
      priority:
        "The browser drains the microtask queue before it takes the next task.",
    },
  },
  {
    kind: "loop",
    title: "The event loop in action",
    subtitle:
      "After the current task, the browser drains microtasks before taking the next task.",
    durationInFrames: 180,
    narration: narration.loop,
    example,
    notes: {
      ready: "The script has finished. A and B are already in the console.",
      microtask: "The Promise callback runs as a microtask and logs C.",
      task: "With the microtask queue empty, the timer task runs and logs D.",
      complete: "The browser repeats this cycle as more work arrives.",
    },
  },
];

export const videoSpec = {
  id: "EventLoopExplainer",
  width: 1280,
  height: 720,
  fps: 30,
  durationInFrames: eventLoopStoryboard.reduce(
    (total, scene) => total + scene.durationInFrames,
    0,
  ),
};
