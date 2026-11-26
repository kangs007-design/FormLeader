'use strict';
function registerAuthRoutes(router, { authService }) {
  router.add('GET', '/api/account/status', async () => ({ needsSetup: !authService.hasAdmin(), approvalRequired: true }));
  router.add('POST', '/api/account/setup', async ({ req, body }) => authService.setup(req, body));
  router.add('GET', '/api/account/me', async ({ req }) => {
    const user = await authService.requireUser(req, false, { allowPasswordChange: true });
    return { user, mode: authService.config.mockMode ? 'mock' : 'live', mustChangePassword: authService.mustChangePassword(user.id), features: { credentialReset: true } };
  });
  router.add('POST', '/api/users/:id/reset-password', async ({ req, params }) => authService.resetPassword((await authService.requireUser(req, true)).id, params.id));
  router.add('GET', '/api/users', async ({ req }) => { await authService.requireUser(req, true); return authService.listUsers(); });
  router.add('PUT', '/api/users/:id', async ({ req, params, body }) => authService.updateUser(await authService.requireUser(req, true), params.id, body));
}
module.exports = { registerAuthRoutes };
