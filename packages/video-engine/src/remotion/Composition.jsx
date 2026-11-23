import React, {useLayoutEffect} from 'react';
import {AbsoluteFill, Html5Audio, Sequence, cancelRender, continueRender, delayRender, staticFile, useCurrentFrame} from 'remotion';
import '@fontsource/inter/400.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import {assertRenderProps, clamp, sceneProgress, smooth} from './layout.js';
import {loadPinnedFonts} from './font-loading.js';
import {SceneTemplate} from './templates.jsx';
import './styles.css';

function WaitForFonts() {
  // Layout effects run before browser paint. Each setup owns a fresh handle,
  // including StrictMode cleanup/replay; no render-phase initializer leaks one.
  useLayoutEffect(() => {
    const handle = delayRender('Wait for pinned Inter fonts');
    let active = true;
    let released = false;
    const finish = () => { if (!released) { released = true; continueRender(handle); } };
    loadPinnedFonts(document.fonts)
      .then(() => { if (active) finish(); })
      .catch(error => {
        if (!active) return;
        // Mark cancellation before releasing: a missing font must never enable
        // a fallback-font screenshot, even momentarily.
        try { cancelRender(error); } finally { finish(); }
      });
    return () => { active = false; finish(); };
  }, []);
  return null;
}

function Scene({scene, timing, index, count}) {
  const frame = useCurrentFrame();
  const progress = sceneProgress(frame, timing.durationInFrames);
  const enter = smooth(frame / Math.max(1, Math.min(12, timing.durationInFrames * 0.08)));
  const leave = index === count - 1 ? 0 : smooth((frame - timing.durationInFrames + 9) / 9);
  return <AbsoluteFill className="engine-scene" data-scene-id={scene.sceneId} data-template={scene.template} style={{opacity: (0.8 + enter * 0.2) * (1 - leave * 0.2), transform: `translateY(${(1 - enter) * 9}px)`}}>
    <SceneTemplate scene={scene} progress={progress} />
  </AbsoluteFill>;
}

export function ExplainerVideo(props) {
  const spec = assertRenderProps(props);
  const {storyboard, timeline, audioSources} = props;
  const frame = useCurrentFrame();
  return <AbsoluteFill className="engine-canvas">
    <WaitForFonts />
    <div className="engine-background-orbit" aria-hidden="true" />
    {storyboard.scenes.map((scene, index) => {
      const timing = timeline.scenes[index];
      return <Sequence key={scene.sceneId} from={timing.startFrame} durationInFrames={timing.durationInFrames} name={scene.visualProps.title}>
        <Scene scene={scene} timing={timing} index={index} count={storyboard.scenes.length} />
        <Sequence from={timing.audioOffsetInFrames} durationInFrames={timing.durationInFrames - timing.audioOffsetInFrames} layout="none" name="Measured local narration">
          <Html5Audio src={staticFile(audioSources[scene.sceneId])} />
        </Sequence>
      </Sequence>;
    })}
    <div className="engine-footer" aria-hidden="true">
      <span>AI VIDEO STUDIO</span>
      <div className="engine-progress-track">
        {timeline.scenes.map(scene => <div key={scene.sceneId} className="engine-progress-part" style={{flexGrow: scene.durationInFrames}}><div style={{transform: `scaleX(${clamp((frame - scene.startFrame + 1) / scene.durationInFrames)})`}} /></div>)}
      </div>
      <span>{Math.min(Math.floor(frame / spec.fps), Math.ceil(spec.durationInFrames / spec.fps))}s</span>
    </div>
  </AbsoluteFill>;
}
