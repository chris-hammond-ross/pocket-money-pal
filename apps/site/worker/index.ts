// The Worker's entry point. Only handlers may be exported from it (workerd checks), so the routes live in app.ts.
import { handle } from './app';

export default {
  fetch: (request, env) => handle(request, env),
} satisfies ExportedHandler<Env>;
