import type { FastifyInstance, FastifyRequest } from "fastify";
import type { VerifiedIdentity } from "@j-auth/token-verifier";
import websocket from "@fastify/websocket";
import type { WebSocket } from "ws";
import {
  TALK_VISITOR_PATHS,
  TALK_VISITOR_POLICY,
  TALK_MEMBER_SCHEMAS,
} from "@j-talk/contracts";
import type { TalkVisitors, VisitorIdentity } from "./visitors.js";
import type { TalkSettings } from "./settings.js";
import type { TalkStream } from "./stream.js";
import { ApiError } from "./errors.js";

const syncQuery = {
  type: "object",
  additionalProperties: false,
  properties: { cursor: { type: "string", minLength: 1, maxLength: 2048 } },
};
export function registerTalkTransport(
  app: FastifyInstance,
  visitors: TalkVisitors,
  settings: TalkSettings,
  stream: TalkStream,
  actor: (request: FastifyRequest) => VerifiedIdentity,
) {
  app.post<{ Body: { guest?: unknown } }>(
    TALK_VISITOR_PATHS.tokens,
    {
      schema: {
        querystring: TALK_MEMBER_SCHEMAS.empty,
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            guest: {
              type: "object",
              additionalProperties: false,
              required: ["guestId", "exp", "sig"],
              properties: {
                guestId: { type: "string", maxLength: 128 },
                exp: { type: "integer" },
                sig: { type: "string", maxLength: 128 },
              },
            },
          },
        },
      },
    },
    async (request, reply) =>
      reply
        .code(201)
        .send(await visitors.issue(request.ip, request.body.guest)),
  );
  const authenticate = (request: FastifyRequest) =>
    visitors.authenticate(request.headers.authorization);
  app.post(
    TALK_VISITOR_PATHS.tokens + "/rotate",
    {
      schema: {
        querystring: TALK_MEMBER_SCHEMAS.empty,
        body: TALK_MEMBER_SCHEMAS.empty,
      },
    },
    async (request) => visitors.rotate(await authenticate(request)),
  );
  app.get(
    TALK_VISITOR_PATHS.session,
    { schema: { querystring: TALK_MEMBER_SCHEMAS.empty } },
    async (request) => visitors.session(await authenticate(request)),
  );
  app.post<{ Body: { requestId: string; text: string } }>(
    TALK_VISITOR_PATHS.messages,
    {
      schema: {
        querystring: TALK_MEMBER_SCHEMAS.empty,
        body: TALK_MEMBER_SCHEMAS.reply,
      },
    },
    async (request) =>
      visitors.send(
        await authenticate(request),
        request.body.requestId,
        request.body.text,
      ),
  );
  app.get<{ Querystring: { cursor?: string } }>(
    TALK_VISITOR_PATHS.sync,
    { schema: { querystring: syncQuery } },
    async (request) => {
      const identity = await authenticate(request);
      return stream.sync(
        "visitor:" + identity.id,
        identity.id,
        request.query.cursor,
      );
    },
  );
  app.post<{ Params: { id: string } }>(
    "/talk/visitors/:id/revoke",
    {
      schema: {
        params: TALK_MEMBER_SCHEMAS.roomParams,
        querystring: TALK_MEMBER_SCHEMAS.empty,
        body: TALK_MEMBER_SCHEMAS.empty,
      },
    },
    (request) => visitors.revoke(request.params.id),
  );
  app.get<{ Querystring: { cursor?: string } }>(
    "/talk/sync",
    { schema: { querystring: syncQuery } },
    (request) => {
      const identity = actor(request);
      return stream.sync(
        "member:" + identity.subject + ":" + String(identity.claims.sid),
        null,
        request.query.cursor,
      );
    },
  );
  const sockets = new Map<WebSocket, string>();
  app.register(websocket, {
    options: { maxPayload: 8192, perMessageDeflate: false },
  });
  app.register(async (scope) => {
    const connect = (
      socket: WebSocket,
      request: FastifyRequest,
      member?: VerifiedIdentity,
    ) => {
      let identity: VisitorIdentity | undefined;
      let cursor: string | undefined;
      let busy = false,
        closed = false,
        initial = true;
      const close = (code = 1008) => {
        if (closed) return;
        closed = true;
        clearInterval(poll);
        clearTimeout(deadline);
        sockets.delete(socket);
        socket.close(code, "Connection ended.");
        const terminate = setTimeout(() => socket.terminate(), 250);
        terminate.unref();
        socket.once("close", () => clearTimeout(terminate));
      };
      const deadline = setTimeout(() => {
        if (!member && !identity) close();
      }, TALK_VISITOR_POLICY.authenticationSeconds * 1000);
      deadline.unref();
      const update = async () => {
        if (closed || busy || (!member && !identity)) return;
        busy = true;
        try {
          if (member) {
            if (
              typeof member.claims.exp !== "number" ||
              member.claims.exp <= Date.now() / 1000
            )
              throw new Error();
          } else {
            await settings.requireOrigin(request.headers.origin);
            identity = await visitors.authenticate("Bearer " + credential);
          }
          const result = await stream.sync(
            member
              ? "member:" + member.subject + ":" + String(member.claims.sid)
              : "visitor:" + identity!.id,
            member ? null : identity!.id,
            cursor,
          );
          if (closed) return;
          if (socket.bufferedAmount > 65536) {
            close(1013);
            return;
          }
          if (initial || result.items.length)
            socket.send(JSON.stringify({ type: "events", ...result }));
          initial = false;
          cursor = result.cursor;
        } catch {
          close(1008);
        } finally {
          busy = false;
        }
      };
      let credential = "";
      const poll = setInterval(() => {
        void update();
      }, TALK_VISITOR_POLICY.pollMilliseconds);
      poll.unref();
      socket.on("close", () => close(1000));
      socket.on("error", () => close(1011));
      socket.on("message", (data, binary) => {
        if (closed || binary || busy) {
          close();
          return;
        }
        if (identity || member) {
          close();
          return;
        }
        busy = true;
        void (async () => {
          const message: unknown = JSON.parse(data.toString());
          if (!message || typeof message !== "object" || Array.isArray(message))
            throw new Error();
          const value = message as Record<string, unknown>;
          if (
            Object.keys(value).some(
              (k) => !["type", "token", "cursor"].includes(k),
            ) ||
            value.type !== "authenticate" ||
            typeof value.token !== "string" ||
            (value.cursor !== undefined && typeof value.cursor !== "string")
          )
            throw new Error();
          credential = value.token;
          identity = await visitors.authenticate("Bearer " + credential);
          const owner = "visitor:" + identity.id;
          if (
            sockets.size >= 1000 ||
            [...sockets.values()].filter((x) => x === owner).length >= 4
          )
            throw new Error();
          sockets.set(socket, owner);
          cursor = value.cursor as string | undefined;
          clearTimeout(deadline);
          busy = false;
          await update();
        })().catch(() => close());
      });
      if (member) {
        if (sockets.size >= 1000) {
          close(1013);
          return;
        }
        sockets.set(socket, "member:" + member.subject);
        clearTimeout(deadline);
        void update();
      }
    };
    scope.get(
      TALK_VISITOR_PATHS.websocket,
      { websocket: true, schema: { querystring: TALK_MEMBER_SCHEMAS.empty } },
      (socket, request) => connect(socket, request),
    );
    scope.get(
      "/talk/ws",
      { websocket: true, schema: { querystring: TALK_MEMBER_SCHEMAS.empty } },
      (socket, request) => connect(socket, request, actor(request)),
    );
  });
  app.addHook("preClose", async () => {
    for (const socket of sockets.keys()) socket.terminate();
    sockets.clear();
  });
  for (const path of Object.values(TALK_VISITOR_PATHS).filter(
    (p) => p !== TALK_VISITOR_PATHS.websocket,
  )) {
    const method =
      path === TALK_VISITOR_PATHS.tokens || path === TALK_VISITOR_PATHS.messages
        ? "POST"
        : "GET";
    app.options(path, async (request, reply) => {
      const headers = request.headers["access-control-request-headers"];
      if (
        request.headers["access-control-request-method"] !== method ||
        (typeof headers === "string" &&
          headers
            .split(",")
            .some(
              (x) =>
                !["authorization", "content-type"].includes(
                  x.trim().toLowerCase(),
                ),
            ))
      )
        throw new ApiError(403, "forbidden", "Unsupported preflight.");
      return reply
        .header("Access-Control-Allow-Methods", method)
        .header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        .code(204)
        .send();
    });
  }
  app.options(TALK_VISITOR_PATHS.tokens + "/rotate", async (request, reply) => {
    if (request.headers["access-control-request-method"] !== "POST")
      throw new ApiError(403, "forbidden", "Unsupported preflight.");
    return reply
      .header("Access-Control-Allow-Methods", "POST")
      .header("Access-Control-Allow-Headers", "Authorization, Content-Type")
      .code(204)
      .send();
  });
}
