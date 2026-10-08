import Fastify, { LogController } from "fastify";
import type { FastifyServerOptions, FastifyError } from "fastify";
import type { ServerOptions as HttpsOptions } from "node:https";
import type { Pool } from "pg";
import type { TokenVerifier } from "@j-auth/token-verifier";
import { assertCustomerTenantId } from "@j-auth/contracts";
import { TALK_PATHS } from "@j-talk/contracts";
import { ApiError, unavailable } from "./errors.js";
import { memberGate } from "./auth.js";
import { TalkSettings } from "./settings.js";
const EMPTY = { type: "object", additionalProperties: false };
const ORIGIN = {
  type: "object",
  additionalProperties: false,
  required: ["origin"],
  properties: { origin: { type: "string", maxLength: 2048 } },
};
const ROUTES = new Set([
  "GET /health/live",
  "GET /health/ready",
  "GET /talk/settings/origins",
  "POST /talk/settings/origins",
  "DELETE /talk/settings/origins",
  "GET /talk/settings/widget-key",
  "POST /talk/settings/widget-key",
  "GET /ext/talk/v1/preflight",
  "OPTIONS /ext/talk/v1/preflight",
]);
export function createApp(options: {
  pool: Pool;
  tenant: string;
  keycloakOrigin: string;
  verifier?: TokenVerifier;
  fetch?: typeof globalThis.fetch;
  https?: HttpsOptions;
  logger?: FastifyServerOptions["logger"];
}) {
  assertCustomerTenantId(options.tenant);
  const app = Fastify({
    exposeHeadRoutes: false,
    trustProxy: false,
    bodyLimit: 8192,
    ajv: { customOptions: { removeAdditional: false } },
    ...(options.https ? { https: options.https } : {}),
    logger: options.logger ?? false,
    logController: new LogController({ disableRequestLogging: true }),
  });
  const member = memberGate(options),
    settings = new TalkSettings(options.pool, options.tenant);
  app.addHook("onRoute", (route) => {
    if (!ROUTES.has(`${route.method} ${route.url}`))
      throw new Error("Route access must be declared.");
    if (route.url.startsWith("/talk/"))
      route.onRequest = async (request) => {
        await member(request, "talk:write");
      };
    else if (route.url === TALK_PATHS.visitorPreflight)
      route.onRequest = async (request, reply) => {
        const origin = await settings.requireOrigin(request.headers.origin);
        reply
          .header("Access-Control-Allow-Origin", origin)
          .header("Vary", "Origin");
      };
  });
  app.addHook("onRequest", async (_request, reply) => {
    reply
      .header("Cache-Control", "no-store")
      .header("Referrer-Policy", "no-referrer")
      .header("X-Content-Type-Options", "nosniff");
  });
  app.setErrorHandler<FastifyError>((error, request, reply) => {
    const safe =
      error instanceof ApiError
        ? error
        : "validation" in error ||
            [400, 413, 415].includes(Number(error.statusCode))
          ? new ApiError(
              Number(error.statusCode ?? 400),
              "invalid_input",
              "Invalid request.",
            )
          : unavailable();
    if (safe.status === 503)
      request.log.warn(
        { code: safe.code, requestId: request.id },
        "Talk request unavailable",
      );
    reply
      .code(safe.status)
      .send({ code: safe.code, message: safe.message, requestId: request.id });
  });
  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/health/ready", async () => {
    await options.pool.query("SELECT checksum FROM schema_migrations LIMIT 1");
    return { status: "ok" };
  });
  app.get<{ Querystring: { limit: number; after?: string } }>(
    TALK_PATHS.origins,
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 100, default: 100 },
            after: { type: "string", maxLength: 2048 },
          },
        },
      },
    },
    (request) => settings.listOrigins(request.query.limit, request.query.after),
  );
  app.post<{ Body: { origin: string } }>(
    TALK_PATHS.origins,
    { schema: { body: ORIGIN, querystring: EMPTY } },
    async (request, reply) =>
      reply.code(201).send(await settings.addOrigin(request.body.origin)),
  );
  app.delete<{ Body: { origin: string } }>(
    TALK_PATHS.origins,
    { schema: { body: ORIGIN, querystring: EMPTY } },
    async (request, reply) => {
      await settings.removeOrigin(request.body.origin);
      return reply.code(204).send();
    },
  );
  app.get(TALK_PATHS.widgetKey, { schema: { querystring: EMPTY } }, () =>
    settings.keyStatus(),
  );
  app.post(
    TALK_PATHS.widgetKey,
    { schema: { body: EMPTY, querystring: EMPTY } },
    () => settings.issueKey(),
  );
  app.get(
    TALK_PATHS.visitorPreflight,
    { schema: { querystring: EMPTY } },
    () => ({ allowed: true }),
  );
  app.options(TALK_PATHS.visitorPreflight, async (request, reply) => {
    if (
      request.headers["access-control-request-method"] !== "GET" ||
      (request.headers["access-control-request-headers"] &&
        request.headers["access-control-request-headers"] !== "authorization")
    )
      throw new ApiError(403, "forbidden", "Unsupported preflight.");
    return reply
      .header("Access-Control-Allow-Methods", "GET")
      .header("Access-Control-Allow-Headers", "Authorization")
      .code(204)
      .send();
  });
  return app;
}
