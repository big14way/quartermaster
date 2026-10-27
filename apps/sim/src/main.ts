import { airwallexMode, env, logger, mode, port, url, varDir } from "@qm/core";
import { AwxSim, SimChain, simnetApp } from "@qm/sim";

// Stand-ins for Metal testnet (offline mode) and the Airwallex sandbox (offline, or live
// Metal without sandbox keys). Everything they produce is labelled SIMULATED.
const log = logger("sim");

if (mode() === "offline") {
  const chain = new SimChain(varDir("sim", "simnet.json"));
  simnetApp(chain).listen(port("simnet"), "127.0.0.1", () => log.info(`Metal simnet on ${port("simnet")}`));
}

if (airwallexMode() === "sim") {
  const awx = new AwxSim({
    file: varDir("sim", "airwallex.json"),
    webhookUrl: `${url("controller")}/webhooks/airwallex`,
    webhookSecret: env("AIRWALLEX_WEBHOOK_SECRET", "whsec_offline"),
    outOfOrderWebhooks: true,
  });
  awx.app().listen(port("awxSim"), "127.0.0.1", () => log.info(`Airwallex simulator on ${port("awxSim")}`));
}
