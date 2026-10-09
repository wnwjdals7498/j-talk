import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PoolConfig } from "pg";
import { notificationEndpoint } from "./notification-sender.js";
import { assertCustomerTenantId } from "@j-auth/contracts";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
export function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value || value.startsWith("__PLACEHOLDER_"))
    throw new Error("Set external talk configuration.");
  return value;
}
export function port(value: string): number {
  const parsed = Number(value);
  if (!/^[1-9][0-9]*$/.test(value) || parsed > 65535 || parsed === 3001)
    throw new Error("Invalid or reserved port.");
  return parsed;
}
export function externalFile(value: string): string {
  if (
    !path.isAbsolute(value) ||
    !path.relative(repository, value).startsWith(".." + path.sep)
  )
    throw new Error("Require a file outside checkout.");
  return value;
}
export function loadDatabaseConfig(
  env: NodeJS.ProcessEnv = process.env,
): PoolConfig {
  if (
    (env.JT_DB_NAME && env.JT_DB_NAME !== "jgw_talk") ||
    (env.JT_DB_USER && env.JT_DB_USER !== "jgw_talk")
  )
    throw new Error("Require dedicated jgw_talk database and non-superuser.");
  return {
    host: env.JT_DB_HOST ?? "127.0.0.1",
    port: port(env.JT_DB_PORT ?? "55044"),
    database: "jgw_talk",
    user: "jgw_talk",
    password: required(env, "JT_DB_PASSWORD"),
    max: 10,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    statement_timeout: 5000,
    application_name: "j-talk",
  };
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const tenant = required(env, "JT_TENANT");
  assertCustomerTenantId(tenant);
  const issuer = new URL(required(env, "KC_PUBLIC_URL"));
  if (
    issuer.protocol !== "https:" ||
    !issuer.hostname.endsWith(".jgw.test") ||
    issuer.port === "3001" ||
    issuer.username ||
    issuer.password ||
    issuer.search ||
    issuer.hash ||
    issuer.pathname !== "/"
  )
    throw new Error("Require registered Keycloak HTTPS origin.");
  return {
    tenant,
    keycloakOrigin: issuer.origin,
    port: port(env.JT_PORT ?? "55045"),
    tlsCertificate: externalFile(required(env, "JT_TLS_CERTIFICATE")),
    tlsKey: externalFile(required(env, "JT_TLS_KEY")),
    database: loadDatabaseConfig(env),
    ...(env.JT_ASSIGNMENT_KEY !== undefined
      ? {
          assignmentKey: (() => {
            const value = required(env, "JT_ASSIGNMENT_KEY");
            if (!/^[A-Za-z0-9_-]{43}$/.test(value))
              throw new Error("Private assignment binding required.");
            return value;
          })(),
        }
      : {}),
    ...(env.JT_NOTIFICATION_URL || env.JT_NOTIFICATION_KEY
      ? {
          notification: {
            url: (() => {
              const value = required(env, "JT_NOTIFICATION_URL");
              notificationEndpoint(value);
              return value;
            })(),
            key: (() => {
              const value = required(env, "JT_NOTIFICATION_KEY");
              if (!/^[A-Za-z0-9_-]{20,128}$/.test(value))
                throw new Error("Private notification key required.");
              return value;
            })(),
          },
        }
      : {}),
  };
}
