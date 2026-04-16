/**
 * Price Oracle (Level 5 Autonomy)
 *
 * Provides real-time fair pricing data from decentralized sources.
 * Used by the brain to flag deals that deviate significantly from
 * market price, and by the market discovery module to set fair
 * price ranges on trade intents.
 *
 * Data Sources:
 *   1. Jupiter V6 Aggregator — DEX-aggregated spot prices
 *   2. Pyth Network — Institutional-grade price feeds (future)
 *   3. CoinGecko API — Fallback public oracle
 */

import { logger } from "../utils/logger";
import { loadConfig } from "../config";
import { autonomy } from "../services/autonomyConfig";

// ==========================================
// TYPES
// ==========================================

export interface PriceQuote {
    asset: string;
    priceUsd: number;
    priceSol: number;
    source: string;
    timestamp: number;
    confidence: "high" | "medium" | "low";
}

export interface FairValueRange {
    asset: string;
    low: number;   // SOL
    mid: number;   // SOL
    high: number;  // SOL
}

// ==========================================
// CACHE
// ==========================================

const priceCache = new Map<string, { quote: PriceQuote; cachedAt: number }>();
const CACHE_TTL_MS = 30_000; // 30 second cache
let solUsdPrice: number = 0;
let _oracleFailCount: number = 0;
let solPriceLastFetch: number = 0;

// Well-known token mints
const KNOWN_MINTS: Record<string, string> = {
    SOL: "So11111111111111111111111111111111111111112",
    USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
};

// ==========================================
// SOL/USD BASE PRICE
// ==========================================

async function fetchSolUsdPrice(): Promise<number> {
    const now = Date.now();
    if (solUsdPrice > 0 && now - solPriceLastFetch < CACHE_TTL_MS) {
        return solUsdPrice;
    }

    const updatePrice = (price: number) => {
        solUsdPrice = price;
        solPriceLastFetch = now;
        _oracleFailCount = 0;
        return price;
    };

    // Primary: CoinGecko (Public, Rate Limited)
    try {
        const response = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd");
        if (!response.ok) throw new Error(`CoinGecko HTTP ${response.status}`);
        const data = await response.json() as any;
        const price = data?.solana?.usd || 0;
        if (price > 0) return updatePrice(price);
    } catch (e: any) {
        logger.debug("oracle_fallback", { source: "coingecko", error: e.message });
    }

    // Fallback 1: Birdeye (Requires key or uses public tier)
    try {
        const response = await fetch("https://public-api.birdeye.so/defi/price?address=So11111111111111111111111111111111111111112", {
            headers: { 'X-API-KEY': process.env.BIRDEYE_API_KEY || '' }
        });
        if (!response.ok) throw new Error(`Birdeye HTTP ${response.status}`);
        const data = await response.json() as any;
        const price = data?.data?.value || 0;
        if (price > 0) return updatePrice(price);
    } catch (e: any) {
        logger.debug("oracle_fallback", { source: "birdeye", error: e.message });
    }

    // Fallback 2: GeckoTerminal (DEX Aggregated, permissive)
    try {
        const response = await fetch("https://api.geckoterminal.com/api/v2/networks/solana/tokens/So11111111111111111111111111111111111111112");
        if (!response.ok) throw new Error(`GeckoTerminal HTTP ${response.status}`);
        const data = await response.json() as any;
        const price = parseFloat(data?.data?.attributes?.price_usd || "0");
        if (price > 0) return updatePrice(price);
    } catch (e: any) {
        _oracleFailCount++;
        if (_oracleFailCount <= 1 || _oracleFailCount % 10 === 0) {
            logger.warn("price_oracle_sol_usd_exhausted", { error: e.message, consecutive_failures: _oracleFailCount });
        }
    }

    return solUsdPrice; // Return last known price
}

// ==========================================
// TOKEN PRICE LOOKUP
// ==========================================

/**
 * Get the current price of a token in SOL terms.
 * Uses Jupiter aggregated prices.
 */
export async function getTokenPrice(assetOrMint: string): Promise<PriceQuote | null> {
    const normalizedAsset = assetOrMint.toUpperCase().trim();

    // Resolve known asset names to mint addresses
    const mint = KNOWN_MINTS[normalizedAsset] || assetOrMint;

    // Check cache
    const cached = priceCache.get(mint);
    if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
        return cached.quote;
    }

    // SOL is always 1 SOL
    if (normalizedAsset === "SOL" || mint === KNOWN_MINTS.SOL) {
        const solUsd = await fetchSolUsdPrice();
        const quote: PriceQuote = {
            asset: "SOL",
            priceUsd: solUsd,
            priceSol: 1,
            source: "native",
            timestamp: Date.now(),
            confidence: "high",
        };
        priceCache.set(mint, { quote, cachedAt: Date.now() });
        return quote;
    }

    try {
        const response = await fetch(`https://api.jup.ag/price/v2?ids=${mint}`);
        const data = await response.json() as any;
        const priceUsd = parseFloat(data?.data?.[mint]?.price || "0");

        if (priceUsd <= 0) return null;

        const solUsd = await fetchSolUsdPrice();
        const priceSol = solUsd > 0 ? priceUsd / solUsd : 0;

        const quote: PriceQuote = {
            asset: normalizedAsset,
            priceUsd,
            priceSol,
            source: "jupiter",
            timestamp: Date.now(),
            confidence: "high",
        };

        priceCache.set(mint, { quote, cachedAt: Date.now() });

        logger.debug("price_oracle_fetched", {
            asset: normalizedAsset,
            price_usd: priceUsd,
            price_sol: priceSol,
        });

        return quote;
    } catch (error: any) {
        logger.warn("price_oracle_fetch_failed", { asset: assetOrMint, error: error.message });
        return null;
    }
}

// ==========================================
// FAIR VALUE ASSESSMENT
// ==========================================

/**
 * Calculate a fair value range for a deal price.
 * Returns low/mid/high range based on market data.
 */
export async function getFairValueRange(asset: string, quantity: number = 1): Promise<FairValueRange | null> {
    const quote = await getTokenPrice(asset);
    if (!quote || quote.priceSol <= 0) return null;

    const mid = quote.priceSol * quantity;
    return {
        asset,
        low: mid * 0.85,  // 15% below market
        mid,
        high: mid * 1.15,  // 15% above market
    };
}

/**
 * Check if a proposed deal price is within fair market range.
 * Returns deviation percentage (positive = overpaying, negative = underpaying).
 */
export async function checkPriceDeviation(
    asset: string,
    proposedPriceSol: number,
    quantity: number = 1
): Promise<{ deviationPercent: number; isFair: boolean; marketPriceSol: number } | null> {
    const quote = await getTokenPrice(asset);
    if (!quote || quote.priceSol <= 0) return null;

    const marketPriceSol = quote.priceSol * quantity;
    const deviationPercent = ((proposedPriceSol - marketPriceSol) / marketPriceSol) * 100;

    return {
        deviationPercent,
        isFair: Math.abs(deviationPercent) <= autonomy.get('marketThresholds').priceDeviationCritical,
        marketPriceSol,
    };
}

// ==========================================
// LIFECYCLE
// ==========================================

let _oracleInterval: ReturnType<typeof setInterval> | null = null;

export function startPriceOracle(): void {
    // Pre-warm SOL/USD price
    fetchSolUsdPrice().catch(() => { });

    // Refresh every 60s
    _oracleInterval = setInterval(() => {
        fetchSolUsdPrice().catch(() => { });
    }, 60_000);

    logger.info("price_oracle_started");
}

export function stopPriceOracle(): void {
    if (_oracleInterval) {
        clearInterval(_oracleInterval);
        _oracleInterval = null;
    }
    logger.info("price_oracle_stopped");
}
