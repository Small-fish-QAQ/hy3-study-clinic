import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync } from "node:child_process";
import { makeLearner } from './learner.mjs';

export const CAMPAIGN = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const PRODUCT = path.resolve(
  process.env.CLINIC_PRODUCT_ROOT ||
    process.env.STUDY_CLINIC_ROOT ||
    path.join(CAMPAIGN, "../.."),
);
export const productImport = (file) =>
  import(pathToFileURL(path.join(PRODUCT, "apps/server/dist", file)));
export const sha = (value) =>
  crypto
    .createHash("sha256")
    .update(
      typeof value === "string" || Buffer.isBuffer(value)
        ? value
        : JSON.stringify(value),
    )
    .digest("hex");
export function write(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}
export function read(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
export function append(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(
    file,
    JSON.stringify({ at: new Date().toISOString(), ...data }) + "\n",
  );
}
const require = createRequire(path.join(PRODUCT, "package.json"));
export function configFromEnvironment() {
  const envPath = path.join(PRODUCT, ".env");
  const env = {
    ...(fs.existsSync(envPath)
      ? require("dotenv").parse(fs.readFileSync(envPath))
      : {}),
    ...process.env,
  };
  const savedPath = path.resolve(
    PRODUCT,
    env.PROVIDER_CONFIG_PATH || "data/provider-config.json",
  );
  const saved = fs.existsSync(savedPath) ? read(savedPath) : {};
  const config =
    env.HY3_API_KEY && env.HY3_BASE_URL && env.HY3_MODEL
      ? {
          baseUrl: env.HY3_BASE_URL,
          apiKey: env.HY3_API_KEY,
          model: env.HY3_MODEL,
        }
      : { baseUrl: saved.baseUrl, apiKey: saved.apiKey, model: saved.model };
  if (!config.apiKey || !config.baseUrl || !config.model)
    throw Error("Hy3 configuration unavailable");
  const url = new URL(config.baseUrl);
  if (url.username || url.password || url.search || url.hash)
    throw Error("Credential-free endpoint URL required");
  const frozenPath=path.join(CAMPAIGN,'FREEZE.json');
  if(fs.existsSync(frozenPath)) {
    const frozen=read(frozenPath).provider;
    if(config.model!==frozen.model||sha(config.baseUrl)!==frozen.endpointIdentityHash)
      throw Error('Provider differs from frozen campaign configuration');
  }
  return { ...config, timeoutMs: 240000 };
}

export async function openRuntime({
  runRoot,
  caseId,
  providerName = "hy3",
  fresh = true,
  databasePath,
}) {
  if (!/^[a-zA-Z0-9_-]+$/.test(caseId)) throw Error("Invalid case identifier");
  runRoot = path.resolve(runRoot);
  const caseRoot = path.join(runRoot, "cases", caseId);
  const dbPath = databasePath || path.join(runRoot, "data", caseId + ".sqlite");
  if (fresh && fs.existsSync(dbPath))
    throw Error("Fresh database already exists: " + caseId);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const [
    { openDatabase },
    { migrate },
    { createRepositories },
    { createServices },
    { Hy3Provider },
    { FakeProvider },
    { createTelemetryProvider },
    { systemClock },
  ] = await Promise.all([
    productImport("db/database.js"),
    productImport("db/migrate.js"),
    productImport("repositories/index.js"),
    productImport("services/index.js"),
    productImport("llm/hy3Provider.js"),
    productImport("llm/fakeProvider.js"),
    productImport("services/providerTelemetry.js"),
    productImport("util/ids.js"),
  ]);
  const config =
    providerName === "hy3"
      ? configFromEnvironment()
      : { model: "fake", baseUrl: "http://local.invalid", apiKey: "" };
  const redact = (value) => {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return config.apiKey ? text.replaceAll(config.apiKey, "[redacted]") : text;
  };
  const safeError = (e) => ({
    name: e.name,
    code: e.code,
    message: redact(e.message || ""),
    details: e.details ? JSON.parse(redact(e.details)) : undefined,
  });
  const assertNoSecret = (value) => {
    if (config.apiKey && String(value).includes(config.apiKey))
      throw Error("Credential echo detected; artifact capture blocked.");
  };
  const privateWrite = (file, data) => {
    assertNoSecret(JSON.stringify(data));
    write(file, data);
  };
  const privateAppend = (file, data) => {
    assertNoSecret(JSON.stringify(data));
    append(file, data);
  };
  const identity = {
    provider: providerName,
    model: config.model,
    endpoint: new URL(config.baseUrl).hostname,
    productCommit: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: PRODUCT,
      encoding: "utf8",
    }).trim(),
    visualProvider: "disabled",
    caseId,
    ownerDatabaseOpened: false,
  };
  write(path.join(caseRoot, "identity.json"), identity);
  const db = openDatabase(dbPath);
  migrate(db);
  const repos = createRepositories(db);
  const als = new AsyncLocalStorage();
  let physicalCount = 0,
    logicalCount = 0;
  const fetchImpl = async (url, options) => {
    if(providerName==='hy3')configFromEnvironment();
    const physicalId = crypto.randomUUID();
    const ctx = { caseId, physicalId, ...als.getStore() };
    physicalCount++;
    const requestText = String(options.body);
    assertNoSecret(requestText);
    fs.mkdirSync(path.join(runRoot, "raw"), { recursive: true });
    // Preserve the actual UTF-8 request body: this hash must address the bytes
    // sent, not a pretty-printed reserialization of the same JSON object.
    fs.writeFileSync(
      path.join(runRoot, "raw", physicalId + ".request.json"),
      requestText,
    );
    append(path.join(runRoot, "physical.jsonl"), {
      ...ctx,
      event: "started",
      requestSha256: sha(requestText),
    });
    const start = Date.now();
    try {
      const response = await fetch(url, options);
      const body = await response.text();
      assertNoSecret(body);
      fs.writeFileSync(
        path.join(runRoot, "raw", physicalId + ".response.txt"),
        body,
      );
      let envelope;
      try {
        envelope = JSON.parse(body);
      } catch {
        /* Keep the captured non-JSON response for audit. */
      }
      append(path.join(runRoot, "physical.jsonl"), {
        ...ctx,
        event: "completed",
        status: response.status,
        elapsedMs: Date.now() - start,
        responseSha256: sha(body),
        returnedModel: envelope?.model ?? null,
        usage: envelope?.usage ?? null,
        finishReason: envelope?.choices?.[0]?.finish_reason ?? null,
      });
      return new Response(body, {
        status: response.status,
        headers: response.headers,
      });
    } catch (e) {
      append(path.join(runRoot, "physical.jsonl"), {
        ...ctx,
        event: "failed",
        elapsedMs: Date.now() - start,
        error: safeError(e),
      });
      throw e;
    }
  };
  const base =
    providerName === "hy3"
      ? new Hy3Provider({ ...config, fetchImpl })
      : new FakeProvider();
  const wrapped = new Proxy(base, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (typeof value !== "function") return value;
      return (...args) => {
        const logicalId = crypto.randomUUID();
        const operation = String(key);
        logicalCount++;
        privateWrite(
          path.join(runRoot, "logical", logicalId + ".input.json"),
          args[0] ?? null,
        );
        return als.run({ logicalId, operation }, async () => {
          append(path.join(runRoot, "logical.jsonl"), {
            caseId,
            logicalId,
            operation,
            event: "started",
          });
          try {
            const result = await value.apply(target, args);
            privateWrite(
              path.join(runRoot, "logical", logicalId + ".output.json"),
              result ?? null,
            );
            append(path.join(runRoot, "logical.jsonl"), {
              caseId,
              logicalId,
              operation,
              event: "completed",
            });
            return result;
          } catch (e) {
            append(path.join(runRoot, "logical.jsonl"), {
              caseId,
              logicalId,
              operation,
              event: "failed",
              error: safeError(e),
            });
            throw e;
          }
        });
      };
    },
  });
  const provider = createTelemetryProvider({
    repos,
    clock: systemClock,
    provider: wrapped,
    providerGeneration: () => 1,
  });
  const services = createServices({
    repos,
    provider,
    clock: systemClock,
    providerModel: config.model,
  });
  function snapshot(workspaceId, label) {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((r) => r.name);
    const rows = Object.fromEntries(
      tables.map((table) => [
        table,
        db.prepare('SELECT * FROM "' + table + '"').all(),
      ]),
    );
    const receipt = {
      capturedAt: new Date().toISOString(),
      identity,
      overview: workspaceId ? services.courseOverview.get(workspaceId) : null,
      rows,
      integrity: db.pragma("integrity_check"),
      foreignKeys: db.pragma("foreign_key_check"),
    };
    privateWrite(path.join(caseRoot, label + ".snapshot.json"), receipt);
    return receipt;
  }
  return {
    db,
    repos,
    services,
    provider,
    answerLearner: makeLearner({config, fetchImpl, als, runRoot, caseId, write:privateWrite, append:privateAppend, safeError, onLogical:()=>logicalCount++}),
    identity,
    runRoot,
    caseRoot,
    dbPath,
    safeError,
    write: (name, data) => privateWrite(path.join(caseRoot, name), data),
    append: (name, data) => privateAppend(path.join(caseRoot, name), data),
    snapshot,
    counts: () => ({ physical: physicalCount, logical: logicalCount }),
    async close() {
      db.pragma("wal_checkpoint(TRUNCATE)");
      db.close();
    },
  };
}
