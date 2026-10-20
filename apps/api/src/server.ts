import { connect } from "@ai-assistant/db";
import { buildApp } from "./app.js";
import { BrowserUseHttp } from "./browseruse.js";
import { loadConfig } from "./config.js";
import { DeepSeekSearch } from "./search.js";
import { TravilaHttp } from "./travila.js";

const config = loadConfig();
const app = buildApp({
  config,
  sql: connect(config.databaseUrl),
  travila: new TravilaHttp(config.travilaBase, config.travilaKey),
  search: new DeepSeekSearch(config.deepseekBase, config.deepseekKey),
  browser: new BrowserUseHttp(config.browserUseBase, config.browserUseKey),
});
await app.listen({ port: Number(process.env.PORT ?? 4000), host: "0.0.0.0" });
