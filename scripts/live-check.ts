import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { env, fromCents } from "@qm/core";
import { LiveMetal, probeOffer } from "@qm/metal";

// Smoke test for live mode, run once Metal testnet access is set up (.env with
// METAL_RPC_URL). It exercises the CLI commands Quartermaster parses and prints the raw
// output next to what the parser read, against a throwaway account in var/live-check.
//
//   pnpm live:check

const root = resolve(import.meta.dirname, "..");
const home = join(root, "var", "live-check");
mkdirSync(home, { recursive: true });
const owner = join(home, "owner-key.json");
const cli = new LiveMetal({
  rpcUrl: env("METAL_RPC_URL"),
  facilitatorUrl: env("METAL_FACILITATOR_URL", "https://x402-testnet.metalntwx.com/x402/facilitator"),
  ownerKeyFile: owner,
  home,
});

function show(title: string, value: unknown) {
  console.log(`\n== ${title}\n${typeof value === "string" ? value : JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? `${v}n` : v), 2)}`);
}

const demo = await probeOffer("https://x402-demo-testnet.metalntwx.com/quote");
show("Metal demo seller offer", { status: demo.status, price: demo.offer && fromCents(demo.offer.price), payTo: demo.offer?.payTo });

const acct = await cli.createAccount();
show("account create", acct);
show("balance", fromCents(await cli.balanceOf(acct.account)));
if ((await cli.balanceOf(acct.account)) === 0n) show("fund", await cli.fund(acct.account));

const credPath = join(home, "probe.json");
if (!existsSync(credPath)) {
  const cred = await cli.createCredential({ principal: acct.account, terms: { cap: 2n, budget: 5n, payees: null, description: "live-check probe" }, out: credPath });
  show("credential create", cred);
  show("bind", await cli.bind(cred.credentialPath));
}
show("status (parsed)", await cli.status(credPath));
show("status (raw)", (await cli.run(["mandate", "status", "--credential", credPath, "--network", "testnet", "--rpc-url", env("METAL_RPC_URL")])).stdout);

const key = join(home, "probe.key.json");
const paid = await cli.payer(credPath, existsSync(key) ? key : credPath.replace(/\.json$/, ".key.json")).pay("https://x402-demo-testnet.metalntwx.com/quote");
show("pay --mandate (parsed)", paid);
if (paid.paid) show("verify (parsed)", await cli.verify({ credentialPath: credPath, issuerPublicPaths: [owner.replace(/\.json$/, ".issuer.public.json")], tx: paid.paid.tx }));
console.log("\nIf any parsed value above is missing or wrong, compare it with the raw output and adjust packages/metal/src/cli.ts.");
