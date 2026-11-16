'use strict';
function registerAuthRoutes(router, { authService }) {
  router.add('GET', '/api/account/status', async () => ({ needsSetup: !authService.hasAdmin(), approvalRequired: true }));
  router.add('POST', '/api/account/setup', async ({ req, body }) => authService.setup(req, body));
  router.add('GET', '/api/account/me', async ({ req }) => ({ user: await authService.requireUser(req), mode: authService.config.mockMode ? 'mock' : 'live' }));
  router.add('GET', '/api/users', async ({ req }) => { await authService.requireUser(req, true); return authService.listUsers(); });
  router.add('PUT', '/api/users/:id', async ({ req, params, body }) => authService.updateUser(await authService.requireUser(req, true), params.id, body));
}
module.exports = { registerAuthRoutes };
