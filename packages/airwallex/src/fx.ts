import { Decimal } from "decimal.js";
import { fromCents, toCents, type Cents } from "@qm/core";

/**
 * Airwallex rates follow the currency pair's market convention: EURUSD 1.0850 means one
 * EUR costs 1.0850 USD whichever side you sell. Never use `client_rate` as "sell per buy";
 * derive the effective rate from the amounts the quote actually commits to.
 */
export function sellPerBuy(q: { sell_amount: string; buy_amount: string }): Decimal {
  const buy = new Decimal(q.buy_amount);
  if (buy.isZero()) throw new Error("quote has zero buy amount");
  return new Decimal(q.sell_amount).div(buy);
}

/**
 * Orient a market-convention rate to "units of sell currency per one unit of buy currency".
 * For pair EURUSD selling USD to buy EUR, that is the rate itself; selling EUR for USD it
 * is the inverse.
 */
export function orientRate(rate: { rate: string; currency_pair: string; sell_currency: string; buy_currency: string }): Decimal {
  const pair = rate.currency_pair.toUpperCase();
  const base = pair.slice(0, 3);
  const quote = pair.slice(3, 6);
  const r = new Decimal(rate.rate);
  if (base === rate.buy_currency && quote === rate.sell_currency) return r;
  if (base === rate.sell_currency && quote === rate.buy_currency) return new Decimal(1).div(r);
  throw new Error(`rate pair ${pair} does not match ${rate.sell_currency}->${rate.buy_currency}`);
}

/** Cents of sell currency needed to buy `buyCents`, rounded up to a whole cent. */
export function sellNeeded(buyCents: Cents, sellPerBuyRate: Decimal): Cents {
  const sell = new Decimal(fromCents(buyCents)).mul(sellPerBuyRate);
  return toCents(sell.toFixed(2, Decimal.ROUND_UP));
}

export function decimalToCents(amount: string, rounding: "exact" | "up" | "down" | "half-up" = "exact"): Cents {
  return toCents(new Decimal(amount).toFixed(), rounding);
}
