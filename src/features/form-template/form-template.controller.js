'use strict';
/** 개별기능[form-template]: API 라우트 */

function registerFormTemplateRoutes(router, { formTemplateService }) {
  router.add('GET', '/api/forms', async () => formTemplateService.list());
  router.add('GET', '/api/forms/:id', async ({ params }) => formTemplateService.get(params.id));
  router.add('POST', '/api/forms', async ({ body }) => formTemplateService.create(body));
  router.add('PUT', '/api/forms/:id', async ({ params, body }) => formTemplateService.update(params.id, body));
  router.add('DELETE', '/api/forms/:id', async ({ params }) => formTemplateService.remove(params.id));
}

module.exports = { registerFormTemplateRoutes };
