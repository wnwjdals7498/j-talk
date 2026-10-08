import { describe, it, expect } from "vitest";
import {
  loadDatabaseConfig,
  externalFile,
  port,
} from "../../apps/server/src/config.js";
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
});
