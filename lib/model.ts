// Token Radar's model, radar-2: one snapshot of the protocol universe in, one ranked board out.
//
// The board covers every slug in the snapshot's watchlist (the floor, never a ceiling) and adds every
// other pre-token protocol the snapshot's own exclusion rule allows: the early rows the radar exists
// to find. A protocol is pre-token when its index entry records no token (no market cap, no CoinGecko
// id, no symbol); live-token protocols are kept apart as the market's own values, never mixed into
// the ranked board. Wrapped, staked and bridged products of a token that already trades are excluded
// from ranking by the same rule the snapshot's watchlist uses.
//
// Implied value follows only from the snapshot's own figures, through comps the snapshot itself
// supplies:
//
//   compMultiple(category) = shrink(median FDV/TVL of traded protocols in that category, n)
//                            toward the global median, k = 4, clamped to [0.05, 2.0]
//                            (each traded ratio winsorised at 3x; CEX excluded; no comps -> global)
//   growth     = clamp(change_7d, -50, 100) per cent
//   growthMult = 1 + (growth / 100) x 0.6
//   maturity   = 0.65 + 0.35 x min(age_days, 1460) / 1460   (age unknown: 365)
//   chains     = 1 + 0.02 x min(chains - 1, 8)
//   implied    = max(1, round(tvl_usd x compMultiple x growthMult x maturity x chains))
//
// Each row also carries its value_breakdown: the same product step by step (TVL x multiple, then
// x growth, x maturity, x chains), so the detail view can show the number being built and a reader
// can check it from the snapshot figures alone.
//
// No protocol name is ever special-cased: the same function scores every row, and the comps table
// the model computes is shown on the dashboard, so a reader can check the multiple each row got.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants, as the dashboard states them and the reader can check them. */
export interface ModelConstants {
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
  chain_step: number;
  chain_cap: number;
  shrink_k: number;
  multiple_floor: number;
  multiple_cap: number;
  winsorize_ratio: number;
}

export const MODEL: ModelConstants = {
  growth_weight: 0.6,
  growth_floor: -50,
  growth_cap: 100,
  maturity_floor: 0.65,
  maturity_range: 0.35,
  maturity_days: 1460,
  unknown_age_days: 365,
  chain_step: 0.02,
  chain_cap: 8,
  shrink_k: 4,
  multiple_floor: 0.05,
  multiple_cap: 2.0,
  winsorize_ratio: 3,
};

/** The model's version label: the dashboard names it and the rules quote it. */
export const MODEL_VERSION = 'radar-2';

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 24;

/** One category's comps: how many traded protocols, their median FDV/TVL, the shrunk multiple. */
export interface CategoryComp {
  category: string;
  n: number;
  median_raw: number;
  multiple: number;
}

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    multiple: number;
    comp_category: string;
    comp_n: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    chain_multiplier: number;
    age_days: number | null;
    value_breakdown: ValueBreakdown;
  };
  farm_steps: string[];
}

/** The dashboard's compact view of one row, with farm plans generated in the page. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  multiple: number;
  comp_category: string;
  comp_n: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  chain_multiplier: number;
  growth_pct: number;
  age_used_days: number;
  chain_count: number;
  base_value_usd: number;
  after_growth_usd: number;
  after_maturity_usd: number;
}

/** A live-token protocol: it already trades, so the board shows the market's own value, not a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** Everything the dashboard needs: the board, the live set, the comps and the model it runs. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  comps: CategoryComp[];
  global_multiple: number;
  rows: RadarRow[];
  live: LiveRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** The median of a sorted array, or `fallback` when empty. */
function medianOf(sorted: number[], fallback: number): number {
  if (sorted.length === 0) return fallback;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** The snapshot's watchlist exclusion rule, applied to every candidate row. */
const EXCLUDED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

/** Whether a protocol is one the board may rank: pre-token, not an exchange product, not a versioned pool, not a wrapped or staked product of a traded token. */
export function isRankable(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return false;
  if (VERSIONED.test(p.name)) return false;
  if (WRAPPED_WORD.test(p.name)) return false;
  if (EXCHANGE_PREFIXES.some((x) => p.name.startsWith(x))) return false;
  return true;
}

/**
 * The comps table: for every category with traded protocols, the median FDV/TVL (each ratio
 * winsorised at `winsorize_ratio`), shrunk toward the global median with `shrink_k` pseudo-counts
 * so a category with one traded protocol does not set its own multiple alone. Categories with no
 * traded comps take the global median. Every multiple is clamped to [multiple_floor, multiple_cap].
 */
export function categoryComps(snapshot: Snapshot, model: ModelConstants = MODEL): { comps: CategoryComp[]; global: number } {
  const byCat = new Map<string, number[]>();
  const all: number[] = [];
  for (const p of snapshot.protocols) {
    if (p.mcap_usd === null || p.tvl_usd <= 0 || p.category === 'CEX') continue;
    const ratio = Math.min(p.mcap_usd / p.tvl_usd, model.winsorize_ratio);
    all.push(ratio);
    const list = byCat.get(p.category!) ?? [];
    list.push(ratio);
    byCat.set(p.category!, list);
  }
  all.sort((a, b) => a - b);
  const global = medianOf(all, 0.2);
  const comps: CategoryComp[] = [];
  for (const [category, ratios] of [...byCat.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    ratios.sort((a, b) => a - b);
    const med = medianOf(ratios, global);
    const n = ratios.length;
    const multiple = Math.min(model.multiple_cap, Math.max(model.multiple_floor, (n * med + model.shrink_k * global) / (n + model.shrink_k)));
    comps.push({ category, n, median_raw: round4(med), multiple: round4(multiple) });
  }
  return { comps, global: round4(global) };
}

/** The multiple one category gets: its comps row, or the global median when it has none. */
function multipleFor(category: string | null, comps: CategoryComp[], global: number): { multiple: number; n: number; label: string } {
  if (category === null) return { multiple: global, n: 0, label: 'global' };
  const row = comps.find((c) => c.category === category);
  if (row === undefined) return { multiple: global, n: 0, label: 'global' };
  return { multiple: row.multiple, n: row.n, label: category };
}

/** The multipliers and the implied value one protocol gets under `model` and `comps`. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  comps: CategoryComp[],
  global: number,
  model: ModelConstants,
): { implied: number; multiple: number; compN: number; compLabel: string; growthPct: number; growthMult: number; maturityMult: number; chainMult: number; age: number | null } {
  const age = ageDays(asOf, protocol.listed_at);
  const { multiple, n, label } = multipleFor(protocol.category, comps, global);
  const rawGrowth = finite(protocol.change_7d, 0);
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, rawGrowth));
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const ageForModel = age ?? model.unknown_age_days;
  const maturityMult = model.maturity_floor + (Math.min(Math.max(ageForModel, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
  const chainCount = Math.max(0, protocol.chains.length - 1);
  const chainMult = 1 + model.chain_step * Math.min(chainCount, model.chain_cap);
  const implied = Math.max(1, Math.round(protocol.tvl_usd * multiple * growthMult * maturityMult * chainMult));
  return { implied, multiple, compN: n, compLabel: label, growthPct, growthMult, maturityMult, chainMult, age };
}

/** The step-by-step chain behind one row's implied value: every intermediate product, in order. */
export interface ValueBreakdown {
  tvl_usd: number;
  multiple: number;
  base_value_usd: number;
  growth_pct: number;
  growth_multiplier: number;
  after_growth_usd: number;
  age_used_days: number;
  maturity_multiplier: number;
  after_maturity_usd: number;
  chain_count: number;
  chain_multiplier: number;
  implied_value_usd: number;
}

/**
 * The chain behind an implied value, from the same factors `impliedValue` returns and in the same
 * multiplication order, so the last step is the row's implied value exactly: the intermediates are
 * carried unrounded and only the final step rounds, exactly as the model does it. The dashboard
 * shows the intermediates rounded to whole dollars, so a reader checking the chain by hand may see
 * a dollar or two of rounding at the last step; the factors themselves are the model's own.
 */
export function breakdownChain(
  protocol: SnapshotProtocol,
  v: { multiple: number; growthPct: number; growthMult: number; maturityMult: number; chainMult: number; age: number | null },
  model: ModelConstants = MODEL,
): ValueBreakdown {
  const base = protocol.tvl_usd * v.multiple;
  const afterGrowth = base * v.growthMult;
  const afterMaturity = afterGrowth * v.maturityMult;
  const implied = Math.max(1, Math.round(afterMaturity * v.chainMult));
  return {
    tvl_usd: protocol.tvl_usd,
    multiple: round4(v.multiple),
    base_value_usd: Math.round(base),
    growth_pct: round4(v.growthPct),
    growth_multiplier: round4(v.growthMult),
    after_growth_usd: Math.round(afterGrowth),
    age_used_days: v.age ?? model.unknown_age_days,
    maturity_multiplier: round4(v.maturityMult),
    after_maturity_usd: Math.round(afterMaturity),
    chain_count: Math.min(Math.max(protocol.chains.length - 1, 0), model.chain_cap),
    chain_multiplier: round4(v.chainMult),
    implied_value_usd: implied,
  };
}

/** The snapshot's protocol by slug. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; comps: CategoryComp[]; global: number } {
  const { comps, global } = categoryComps(snapshot, model);
  const index = bySlug(snapshot.protocols);
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug, even one the snapshot no longer carries (it cannot, but
  // the board's coverage is the gate's row and is never gambled on a missing record).
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: every other rankable pre-token protocol, below the watchlist floor or not.
  // Never a replacement for a watchlist row: a chosen protocol stays chosen.
  for (const p of snapshot.protocols) {
    if (chosen.has(p.slug)) continue;
    if (!isRankable(p)) continue;
    chosen.set(p.slug, p);
  }

  const scored = [...chosen.values()].map((p) => {
    const v = impliedValue(p, snapshot.as_of, comps, global, model);
    return { p, ...v };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  const board = scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token' as const,
    age_days: s.age,
    implied_value_usd: s.implied,
    model: {
      multiple: s.multiple,
      comp_category: s.compLabel,
      comp_n: s.compN,
      growth_pct: round4(s.growthPct),
      growth_multiplier: round4(s.growthMult),
      maturity_multiplier: round4(s.maturityMult),
      chain_multiplier: round4(s.chainMult),
      age_days: s.age,
      value_breakdown: breakdownChain(s.p, s),
    },
    farm_steps: farmSteps(s.p, s.age).map(stepText),
  }));
  return { board, comps, global };
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** A typical gas cost for one transaction on a chain, in dollars, for the farm plan's text. */
function gasOn(chain: string): string {
  const c = chain.toLowerCase();
  if (c.includes('solana')) return '$0.05';
  if (c.includes('ethereum')) return '$6';
  if (c.includes('base') || c.includes('arbitrum') || c.includes('optimism') || c.includes('unichain') || c.includes('ink') || c.includes('mode') || c.includes('blast')) return '$0.40';
  if (c.includes('binance') || c.includes('bnb')) return '$0.30';
  if (c.includes('tron')) return '$1';
  if (c.includes('polygon') || c.includes('avalanche') || c.includes('sonic') || c.includes('berachain') || c.includes('sui') || c.includes('aptos')) return '$0.50';
  return '$2';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The category's main action, in the words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open.`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt.`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Deposit $${capital} of USDC as margin on ${name} and open one small hedge.`;
  if (c.includes('prediction')) return `Fund $${capital} and place one market position on ${name}.`;
  if (c.includes('curator') || c.includes('allocator') || c.includes('risk')) return `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`;
  if (c.includes('rwa')) return `Mint $${capital} of the protocol's yield asset on ${chain} and hold it.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy.`;
  if (c.includes('payment')) return `Pay $${capital} through ${name} on ${chain} for a real invoice or subscription and keep the receipt.`;
  if (c.includes('governance')) return `Lock $${capital} in ${name}'s governance vault on ${chain} and vote once.`;
  if (c.includes('chain')) return `Bridge $${capital} of USDC to ${chain} and deposit it in the chain's largest lending market.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/** The category's weekly qualifying action. */
function weeklyFor(p: SnapshotProtocol): string {
  const c = (p.category ?? '').toLowerCase();
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) return 'Swap $10 or add and remove $10 of liquidity once a week so the wallet stays active.';
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return 'Top up or adjust the supply by $10 once a week so the wallet stays active.';
  if (c.includes('perpetual') || c.includes('derivative')) return 'Open and close one small hedge once a week so the wallet stays active.';
  if (c.includes('staking') || c.includes('restak')) return 'Claim or restake the staking rewards once a week so the wallet stays active.';
  if (c.includes('bridge')) return 'Bridge $10 to the chain once a week so the wallet stays active.';
  if (c.includes('prediction')) return 'Place one small market position once a week so the wallet stays active.';
  if (c.includes('curator') || c.includes('allocator') || c.includes('risk')) return 'Add $10 to the vault or move between its vaults once a week so the wallet stays active.';
  if (c.includes('rwa')) return 'Mint or redeem $10 of the yield asset once a week so the wallet stays active.';
  return 'Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.';
}

/** The category's main risk, in one plain sentence. */
function riskFor(p: SnapshotProtocol): string {
  const c = (p.category ?? '').toLowerCase();
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) return 'Liquidity positions lose value when the two sides of the pool move apart, so never farm more than you can lose.';
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return 'A supplied position can be liquidated if its collateral falls, so keep the health factor well above the minimum.';
  if (c.includes('perpetual') || c.includes('derivative')) return 'Leveraged positions pay funding and can be liquidated fast, so keep the hedge small and the margin well covered.';
  if (c.includes('bridge')) return 'Bridged funds depend on the bridge contract and finality, so test with a small amount first.';
  if (c.includes('rwa')) return 'The yield asset depends on its issuer and its reserves, so read who holds the underlying before minting.';
  if (c.includes('staking') || c.includes('restak')) return 'Staked assets can be slashed and take days to unbond, so check the unbonding time before staking.';
  if (c.includes('insurance')) return 'Cover pays only for the events its policy names, so read the policy wording before buying.';
  return 'Every farm position carries smart-contract risk, so never farm more than you can lose.';
}

/** What to look for on the protocol's points page, by category. */
function pointsFor(p: SnapshotProtocol): string {
  const c = (p.category ?? '').toLowerCase();
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) return 'Look for the trading-rewards page and note which pairs earn points.';
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return 'Look for the supply-rewards page and note which markets pay incentives.';
  if (c.includes('curator') || c.includes('allocator') || c.includes('risk')) return 'Look for the vault-points page and note which vaults earn points.';
  if (c.includes('rwa')) return 'Look for the rewards page and note which tokenised assets earn points.';
  if (c.includes('staking') || c.includes('restak')) return 'Look for the staking-rewards page and note which pools earn points.';
  if (c.includes('prediction')) return 'Look for the market-rewards page and note which markets earn points.';
  if (c.includes('bridge')) return 'Look for the bridge-rewards page and note which routes earn points.';
  return 'Look for the points page and note what earns points.';
}

/** What the farm log should record, by category. */
function logFor(p: SnapshotProtocol): string {
  const c = (p.category ?? '').toLowerCase();
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) return 'Log every swap and liquidity change, and the pool it touched.';
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return 'Log every supply and borrow, and the health factor after each one.';
  if (c.includes('curator') || c.includes('allocator') || c.includes('risk')) return 'Log every vault deposit and move, and the vault it went into.';
  if (c.includes('rwa')) return 'Log every mint and redemption, and the asset it bought.';
  if (c.includes('staking') || c.includes('restak')) return 'Log every stake and reward claim, and the unbonding date.';
  if (c.includes('prediction')) return 'Log every market position, and whether it won or lost.';
  if (c.includes('bridge')) return 'Log every bridge transfer, and the route it took.';
  return 'Log every deposit and withdrawal, and the date it happened.';
}

/**
 * A protocol's farm plan: seven steps, each an action with a cost and a time. The plan is derived
 * from the protocol's own record (category, chains, TVL, age), never from a hand-written list of names.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const gas = gasOn(chain);
  return [
    {
      text: `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`,
      cost: `about ${gas} of gas for the first transaction on ${chain}`,
      time: '5 minutes',
    },
    {
      text: actionFor(p, capital, chain),
      cost: `$${capital} of capital and about ${gas} of gas on ${chain}`,
      time: '15 minutes to set up',
    },
    {
      text: weeklyFor(p),
      cost: `about ${gas} of gas a week on ${chain}`,
      time: '10 minutes a week',
    },
    {
      text: `Open the protocol's own points, quests or rewards page and follow only the links it publishes, never a link from a chat or a search ad. ${pointsFor(p)}`,
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: riskFor(p),
      cost: 'nothing to read, and it caps what you should risk',
      time: '5 minutes',
    },
    {
      text: `Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it. ${logFor(p)}`,
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  ];
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** A board row's compact form for data.js, with the farm plan generated in the page. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    multiple: row.model.multiple,
    comp_category: row.model.comp_category,
    comp_n: row.model.comp_n,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    chain_multiplier: row.model.chain_multiplier,
    growth_pct: row.model.value_breakdown.growth_pct,
    age_used_days: row.model.value_breakdown.age_used_days,
    chain_count: row.model.value_breakdown.chain_count,
    base_value_usd: row.model.value_breakdown.base_value_usd,
    after_growth_usd: row.model.value_breakdown.after_growth_usd,
    after_maturity_usd: row.model.value_breakdown.after_maturity_usd,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const { board, comps, global } = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    comps,
    global_multiple: global,
    rows: board.map(radarRow),
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** The board's headline figures for the run log: top value, median, bottom, and how many categories it spans. */
export function boardStats(board: BoardRow[]): { top: number; median: number; bottom: number; categories: number } {
  if (board.length === 0) return { top: 0, median: 0, bottom: 0, categories: 0 };
  const values = board.map((r) => r.implied_value_usd).sort((a, b) => a - b);
  const mid = Math.floor(values.length / 2);
  const median = values.length % 2 === 1 ? values[mid]! : Math.round((values[mid - 1]! + values[mid]!) / 2);
  return {
    top: values[values.length - 1]!,
    median,
    bottom: values[0]!,
    categories: new Set(board.map((r) => r.category ?? 'Other')).size,
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
    if (r.model.value_breakdown.implied_value_usd !== r.implied_value_usd) {
      return `${r.slug} has a value breakdown ending at $${r.model.value_breakdown.implied_value_usd} but an implied value of $${r.implied_value_usd}`;
    }
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
