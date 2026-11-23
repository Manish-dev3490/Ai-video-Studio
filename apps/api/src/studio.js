import {Router} from 'express';
import {buildProjectRouter} from './projects/index.js';
import {buildGenerationRouter} from './jobs/router.js';
import {buildMediaRouter} from './media.js';
import {buildAssistantRouter} from './assistant/index.js';
import {buildReportRouter} from './reports/index.js';

export function buildStudioRouter({connection, config, models, planner, assistant}) {
  const router = Router();
  router.use(buildProjectRouter({connection, config, models, ...(planner ? {planner} : {})}));
  router.use(buildAssistantRouter({connection, config, models, ...(assistant ? {assistant} : {})}));
  router.use(buildGenerationRouter({connection, config, models}));
  router.use(buildMediaRouter({connection, config, models}));
  router.use(buildReportRouter({connection, config, models}));
  return router;
}
