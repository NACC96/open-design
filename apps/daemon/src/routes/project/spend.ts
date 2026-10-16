import path from 'node:path';
import type { Express } from 'express';
import type { ProjectSpendResponse } from '@open-design/contracts';
import type { AuthorizeProjectRequest } from '../../collab/project-request-authority.js';
import type { RouteDeps } from '../../server-context.js';
import { computeProjectSpend } from '../../spend/project-spend.js';

export interface RegisterProjectSpendRoutesDeps
  extends RouteDeps<'db' | 'http' | 'paths' | 'projectStore' | 'appConfig'> {
  authorizeProjectRequest: AuthorizeProjectRequest;
}

export function registerProjectSpendRoutes(app: Express, ctx: RegisterProjectSpendRoutesDeps): void {
  const { db } = ctx;
  const { sendApiError } = ctx.http;
  const { getProject } = ctx.projectStore;

  // API-equivalent cost of the project's agent turns; see ProjectSpendResponse.
  app.get('/api/projects/:id/spend', async (req, res) => {
    const projectId = req.params.id;
    if (!getProject(db, projectId)) {
      return sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'project not found');
    }
    if (!await ctx.authorizeProjectRequest(req, res, projectId, { mode: 'read' })) return;
    try {
      const dataDir = ctx.paths.RUNTIME_DATA_DIR;
      const config = await ctx.appConfig.readAppConfig(dataDir);
      const body: ProjectSpendResponse = await computeProjectSpend(db, projectId, {
        runsLogDir: path.join(dataDir, 'runs'),
        overrides: config?.modelPriceOverrides ?? null,
      });
      res.json(body);
    } catch (err) {
      sendApiError(res, 500, 'INTERNAL_ERROR', String(err));
    }
  });
}
