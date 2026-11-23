# AI Video Studio rendering proof of concept

`EventLoopExplainer` is a narrated, 30-second educational video about the browser's JavaScript event loop. The Remotion composition is 1280 × 720 at 30 FPS with 900 frames.

## Preview in Remotion Studio

Run from the `video-engine-poc` directory.

```sh
npm ci
npm run dev
```

Open the local URL printed by the terminal and select **EventLoopExplainer**.

## Export an MP4

```sh
npx remotion render src/index.ts EventLoopExplainer out/EventLoopExplainer-Narrated.mp4 --codec=h264
```

Use `npm run lint` to run ESLint and TypeScript checks.

## Source

| File                                      | Role                                                                                                    |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `src/Root.tsx`                            | Registers the composition and its default storyboard props.                                             |
| `src/Composition.tsx`                     | Sequences the scenes and draws the transitions and progress bar.                                        |
| `src/storyboard.ts`                       | Defines the scene data types, durations, educational copy, and shared code example.                     |
| `src/narration.json`, `public/narration/` | Store the narration text, frame offsets, and five local WAV clips.                                      |
| `src/scenes/`                             | Contains five scene components for the introduction, call stack, browser timer, queues, and event loop. |
| `src/visuals.tsx`                         | Provides shared stack, queue, arrow, panel, label, and caption components.                              |
| `src/video.css`, `src/motion.ts`          | Provide the visual styles and frame-based easing.                                                       |

The composition takes a typed storyboard prop. The scene components display example JavaScript as text and animate prerecorded steps from the storyboard.

The timing follows the [HTML event loop](https://html.spec.whatwg.org/multipage/webappapis.html#event-loop-processing-model) and [timer](https://html.spec.whatwg.org/multipage/timers-and-user-prompts.html#timers) algorithms.

## Regenerate narration on Windows

Edit `src/narration.json`, then run `./scripts/generate-narration.ps1` in PowerShell with the Windows `System.Speech` assembly and Microsoft Heera voice available. Pass `-Voice '<installed voice name>'` to use another local voice. Check that any regenerated clip fits its scene, since voices and edits can change speech duration.
