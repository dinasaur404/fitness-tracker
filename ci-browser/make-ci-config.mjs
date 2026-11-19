import { readFileSync, writeFileSync } from "node:fs";

const source = readFileSync("../wrangler.jsonc", "utf8")
  .split("\n")
  .map((line) => line.replace(/^\s*\/\/.*$/, ""))
  .join("\n")
  .replace(/,(\s*[}\]])/g, "$1");
const config = JSON.parse(source);
delete config.ai;
delete config.vectorize;
delete config.triggers;
delete config.placement;
delete config.$schema;
writeFileSync("../wrangler.ci.json", JSON.stringify(config, null, 2));
console.log("wrote wrangler.ci.json without ai/vectorize/triggers/placement");
