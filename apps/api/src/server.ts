import { buildApp } from "./app.js";

const port = Number(process.env.PORT ?? 4000);
const app = buildApp();
await app.listen({ port, host: "0.0.0.0" });
