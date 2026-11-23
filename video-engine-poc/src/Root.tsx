import { Composition } from "remotion";
import { EventLoopVideo } from "./Composition";
import { eventLoopStoryboard, videoSpec } from "./storyboard";

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      {...videoSpec}
      component={EventLoopVideo}
      defaultProps={{ storyboard: eventLoopStoryboard }}
    />
  );
};
