import { env, logger, port, url, varDir } from "@qm/core";
import { AwxSim, SimChain, simnetApp } from "@qm/sim";

// Offline stand-ins for Metal testnet and the Airwallex sandbox. Everything they produce
// is labelled SIMULATED in the dashboard.
const log = logger("sim");

const chain = new SimChain(varDir("sim", "simnet.json"));
simnetApp(chain).listen(port("simnet"), "127.0.0.1", () => log.info(`Metal simnet on ${port("simnet")}`));

const awx = new AwxSim({
  file: varDir("sim", "airwallex.json"),
  webhookUrl: `${url("controller")}/webhooks/airwallex`,
  webhookSecret: env("AIRWALLEX_WEBHOOK_SECRET", "whsec_offline"),
  outOfOrderWebhooks: true,
});
awx.app().listen(port("awxSim"), "127.0.0.1", () => log.info(`Airwallex simulator on ${port("awxSim")}`));
