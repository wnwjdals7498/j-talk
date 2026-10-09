import { describe, it, expect } from "vitest";
import {
  loadDatabaseConfig,
  externalFile,
  port,
  loadConfig,
} from "../../apps/server/src/config.js";
import { notificationEndpoint } from "../../apps/server/src/notification-sender.js";
describe("dedicated external configuration", () => {
  it("keeps the dedicated non-superuser identity and rejects secret paths/reserved ports", () => {
    expect(loadDatabaseConfig({ JT_DB_PASSWORD: "fixture" })).toMatchObject({
      database: "jgw_talk",
      user: "jgw_talk",
    });
    for (const env of [
      { JT_DB_PASSWORD: "__PLACEHOLDER_PASSWORD" },
      { JT_DB_PASSWORD: "fixture", JT_DB_USER: "postgres" },
      { JT_DB_PASSWORD: "fixture", JT_DB_NAME: "other" },
    ])
      expect(() => loadDatabaseConfig(env)).toThrow();
    for (const value of ["3001", "0", "01", "65536"])
      expect(() => port(value)).toThrow();
    expect(() => externalFile("/workspace/j-talk/secret.key")).toThrow();
  });
  it("requires a complete explicit loopback notification binding and does not enable a sender by default", () => {
    const env = {
      JT_TENANT: "fixture",
      KC_PUBLIC_URL: "https://auth.jgw.test",
      JT_DB_PASSWORD: "fixture",
      JT_TLS_CERTIFICATE: "/workspace/.suite-runtime/j-talk/server.crt",
      JT_TLS_KEY: "/workspace/.suite-runtime/j-talk/server.key",
    };
    expect(loadConfig(env)).not.toHaveProperty("notification");
    expect(loadConfig(env)).not.toHaveProperty("assignmentKey");
    expect(() =>
      loadConfig({ ...env, JT_ASSIGNMENT_KEY: "bad key" }),
    ).toThrow();
    expect(
      loadConfig({ ...env, JT_ASSIGNMENT_KEY: "x".repeat(43) }).assignmentKey,
    ).toBe("x".repeat(43));
    for (const value of [
      "https://external.jgw.test:443",
      "http://127.0.0.1:3001",
      "http://127.0.0.1",
      "http://127.0.0.1:54260/path",
      "http://user@127.0.0.1:54260",
    ])
      expect(() => notificationEndpoint(value)).toThrow();
    for (const fields of [
      { JT_NOTIFICATION_URL: "http://127.0.0.1:54260" },
      { JT_NOTIFICATION_KEY: "x".repeat(43) },
      {
        JT_NOTIFICATION_URL: "http://127.0.0.1:54260",
        JT_NOTIFICATION_KEY: "bad key",
      },
    ])
      expect(() => loadConfig({ ...env, ...fields })).toThrow();
    expect(
      loadConfig({
        ...env,
        JT_NOTIFICATION_URL: "http://127.0.0.1:54260",
        JT_NOTIFICATION_KEY: "x".repeat(43),
      }).notification,
    ).toEqual({ url: "http://127.0.0.1:54260", key: "x".repeat(43) });
  });
});
