import React from 'react';
import {Composition} from 'remotion';
import {ExplainerVideo} from './Composition.jsx';
import {assertRenderProps, COMPOSITION_ID, FPS, HEIGHT, WIDTH} from './layout.js';

export function RemotionRoot() {
  return <Composition
    id={COMPOSITION_ID}
    component={ExplainerVideo}
    width={WIDTH}
    height={HEIGHT}
    fps={FPS}
    durationInFrames={900}
    defaultProps={{storyboard: null, timeline: null, audioSources: {}}}
    calculateMetadata={({props}) => ({...assertRenderProps(props), props})}
  />;
}
