import { ROLES, type Role } from "@qm/core";
import { jsonApp, serve } from "@qm/runtime";
import { agentContext, mountCommon } from "./common";
import { mountSourcing } from "./sourcing";
import { mountSupport } from "./support";
import { mountTreasury } from "./treasury";

// One process per agent: `tsx src/main.ts sourcing|support|treasury`. Each process gets
// its own directory and reads nothing outside it but public files.
const role = process.argv[2] as Role;
if (!ROLES.includes(role)) {
  console.error(`usage: main.ts <${ROLES.join("|")}>`);
  process.exit(2);
}

const ctx = agentContext(role);
const app = jsonApp();
mountCommon(app, ctx);
if (role === "sourcing") mountSourcing(app, ctx);
if (role === "support") mountSupport(app, ctx);
if (role === "treasury") mountTreasury(app, ctx);
serve(app, role, role);
