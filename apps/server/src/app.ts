import Fastify, { LogController } from "fastify";
import type {
  FastifyServerOptions,
  FastifyError,
  FastifyRequest,
} from "fastify";
import type { ServerOptions as HttpsOptions } from "node:https";
import type { Pool } from "pg";
import type { TokenVerifier } from "@j-auth/token-verifier";
import { assertCustomerTenantId } from "@j-auth/contracts";
import {
  TALK_PATHS,
  TALK_MEMBER_SCHEMAS,
  TALK_ROOM_STATUSES,
} from "@j-talk/contracts";
import { ApiError, unavailable } from "./errors.js";
import { memberGate } from "./auth.js";
import { TalkSettings } from "./settings.js";
import { TalkRooms } from "./rooms.js";
import { widgetArtifact } from "./widget.js";
const {
  page: PAGE,
  roomParams: ROOM_PARAMS,
  empty: EMPTY,
} = TALK_MEMBER_SCHEMAS;
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
  "GET /ext/talk/v1/widget.min.js",
  "GET /talk/rooms",
  "GET /talk/rooms/:id",
  "GET /talk/rooms/:id/messages",
  "POST /talk/rooms/:id/assign-self",
  "POST /talk/rooms/:id/messages",
  "POST /talk/rooms/:id/close",
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
    settings = new TalkSettings(options.pool, options.tenant),
    rooms = new TalkRooms(options.pool, options.tenant),
    actors = new WeakMap<FastifyRequest, string>();
  app.addHook("onRoute", (route) => {
    if (!ROUTES.has(`${route.method} ${route.url}`))
      throw new Error("Route access must be declared.");
    if (route.url.startsWith("/talk/"))
      route.onRequest = async (request) => {
        const identity = await member(
          request,
          route.method === "GET" && route.url.startsWith(TALK_PATHS.rooms)
            ? "talk:read"
            : "talk:write",
        );
        actors.set(request, identity.subject);
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
    () => ({ allowed: true, available: false }),
  );
  app.get(
    TALK_PATHS.widget,
    { schema: { querystring: EMPTY } },
    async (request, reply) => {
      const artifact = await widgetArtifact();
      reply
        .header("Content-Type", "application/javascript; charset=utf-8")
        .header("Cache-Control", "max-age=300")
        .header("ETag", artifact.etag);
      if (
        typeof request.headers["if-none-match"] === "string" &&
        request.headers["if-none-match"]
          .split(",")
          .some(
            (v) =>
              v.trim() === "*" ||
              v.trim().replace(/^W\//, "") === artifact.etag,
          )
      )
        return reply.code(304).send();
      return reply.send(artifact.bytes);
    },
  );
  app.get<{ Querystring: { limit: number; after?: string; status?: string } }>(
    TALK_PATHS.rooms,
    {
      schema: {
        querystring: {
          ...PAGE,
          properties: {
            ...PAGE.properties,
            status: {
              type: "string",
              enum: TALK_ROOM_STATUSES,
            },
          },
        },
      },
    },
    (request) =>
      rooms.list(
        request.query.status,
        request.query.limit,
        request.query.after,
      ),
  );
  app.get<{ Params: { id: string } }>(
    TALK_PATHS.rooms + "/:id",
    { schema: { params: ROOM_PARAMS, querystring: EMPTY } },
    (request) => rooms.room(request.params.id),
  );
  app.get<{
    Params: { id: string };
    Querystring: { limit: number; after?: string };
  }>(
    TALK_PATHS.rooms + "/:id/messages",
    { schema: { params: ROOM_PARAMS, querystring: PAGE } },
    (request) =>
      rooms.messages(
        request.params.id,
        request.query.limit,
        request.query.after,
      ),
  );
  app.post<{ Params: { id: string } }>(
    TALK_PATHS.rooms + "/:id/assign-self",
    { schema: { params: ROOM_PARAMS, querystring: EMPTY, body: EMPTY } },
    (request) => rooms.assignSelf(request.params.id, actors.get(request)!),
  );
  app.post<{
    Params: { id: string };
    Body: { requestId: string; text: string };
  }>(
    TALK_PATHS.rooms + "/:id/messages",
    {
      schema: {
        params: ROOM_PARAMS,
        querystring: EMPTY,
        body: TALK_MEMBER_SCHEMAS.reply,
      },
    },
    (request) =>
      rooms.reply(
        request.params.id,
        actors.get(request)!,
        request.body.requestId,
        request.body.text,
      ),
  );
  app.post<{ Params: { id: string } }>(
    TALK_PATHS.rooms + "/:id/close",
    { schema: { params: ROOM_PARAMS, querystring: EMPTY, body: EMPTY } },
    (request) => rooms.close(request.params.id),
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
