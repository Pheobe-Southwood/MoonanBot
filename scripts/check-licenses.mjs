import { execFileSync } from "node:child_process";

const report = JSON.parse(execFileSync("pnpm", ["licenses", "list", "--prod", "--json"], { encoding: "utf8" }));
const rejected = Object.entries(report).filter(([license]) => /unknown|unlicensed|proprietary/i.test(license));
if (rejected.length) {
  process.stderr.write(`Dependencies with unacceptable or missing license metadata:\n${rejected.map(([license, packages]) => `${license}: ${packages.map((item) => item.name).join(", ")}`).join("\n")}\n`);
  process.exit(1);
}
const packageCount = Object.values(report).reduce((count, packages) => count + packages.length, 0);
process.stdout.write(`Verified license metadata for ${packageCount} production dependency entries across ${Object.keys(report).length} license groups.\n`);
