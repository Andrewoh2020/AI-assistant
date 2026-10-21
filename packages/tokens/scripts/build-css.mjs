import { writeFileSync } from "node:fs";
import { buildCss } from "../dist/index.js";

writeFileSync(new URL("../dist/tokens.css", import.meta.url), buildCss());
console.log("Wrote dist/tokens.css");
