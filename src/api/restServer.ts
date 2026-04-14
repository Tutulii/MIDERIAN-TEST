import express from 'express';
import { eventBus } from '../services/eventBus';
import { logger } from '../utils/logger';
import crypto from 'crypto';
import { dealPhaseManager } from '../../core/dealPhaseManager';
import { soulEngine } from '../services/soulEngine';
import { analyzeMessage } from '../../core/middlemanBrain';
import { negotiationStore } from '../state/negotiationStore';
import { getBeliefs } from '../services/beliefStore';
import { experienceMemory } from '../services/experienceMemory';

let server: any;

// ══════════════════════════════════════
// HMAC BRIDGE SECURITY
// Verifies that requests to bridge endpoints come from the API Server.
// ══════════════════════════════════════
const BRIDGE_SECRET = process.env.BRIDGE_SECRET || '';

function verifyBridgeHmac(req: express.Request, res: express.Response, next: express.NextFunction): void {
    // Dev mode: if no BRIDGE_SECRET configured, allow all (local testing)
    if (!BRIDGE_SECRET) {
        next();
        return;
    }

    const signature = req.headers['x-bridge-signature'] as string;
    const timestamp = req.headers['x-bridge-timestamp'] as string;

    if (!signature || !timestamp) {
        logger.warn('bridge_auth_missing', { ip: req.ip, path: req.path });
        res.status(401).json({ error: 'Missing bridge authentication headers' });
        return;
    }

    // Check timestamp freshness (30 second window)
    const now = Date.now();
    const reqTime = parseInt(timestamp, 10);
    if (isNaN(reqTime) || Math.abs(now - reqTime) > 30000) {
        logger.warn('bridge_auth_expired', { ip: req.ip, path: req.path, age_ms: now - reqTime });
        res.status(401).json({ error: 'Bridge timestamp expired' });
        return;
    }

    // Recompute HMAC
    const body = JSON.stringify(req.body) || '';
    const payload = `${timestamp}:${req.method.toUpperCase()}:${req.path}:${body}`;
    const expected = crypto.createHmac('sha256', BRIDGE_SECRET).update(payload).digest('hex');

    // Constant-time comparison
    try {
        const valid = signature.length === expected.length &&
            crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));

        if (!valid) {
            logger.warn('bridge_auth_invalid', { ip: req.ip, path: req.path });
            res.status(401).json({ error: 'Invalid bridge signature' });
            return;
        }
    } catch {
        res.status(401).json({ error: 'Invalid bridge signature format' });
        return;
    }

    logger.debug('bridge_auth_ok', { path: req.path });
    next();
}

// ══════════════════════════════════════
// BRIDGE RATE LIMITER (per-IP, 30/min)
// ══════════════════════════════════════
const bridgeRequestCounts = new Map<string, { count: number; resetAt: number }>();

function bridgeRateLimiter(req: express.Request, res: express.Response, next: express.NextFunction): void {
    const ip = req.ip || 'unknown';
    const now = Date.now();
    const entry = bridgeRequestCounts.get(ip);

    if (!entry || now > entry.resetAt) {
        bridgeRequestCounts.set(ip, { count: 1, resetAt: now + 60000 });
        next();
        return;
    }

    entry.count++;
    if (entry.count > 30) {
        res.status(429).json({ error: 'Bridge rate limit exceeded (30/min)' });
        return;
    }
    next();
}
export function startRestApi(port: number = parseInt(process.env.API_PORT || "8080")) {
    const app = express();
    app.use(express.json());

    // ══════════════════════════════════════
    // EXISTING ENDPOINT (UNCHANGED)
    // ══════════════════════════════════════

    app.post('/v1/offers', (req, res) => {
        try {
            const { type, asset, price, collateral, buyerPublicKey } = req.body;

            const offerId = `offer-${Date.now()}`;
            const ticketId = `TCK-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;

            // Publish the offer so internal systems know roughly about it
            eventBus.publish("offer_detected", {
                offer_id: offerId,
                type: type === "sell" ? "sell" : "buy",
                creator: buyerPublicKey,
                content: `WTS ${asset} for ${price} (Collateral: ${collateral})`,
                timestamp: new Date().toISOString()
            });

            // For the test scaffolding, immediately forward an offer broadcast 
            // over WebSocket so the SELLER agent catches it
            eventBus.publish("agent_message_received", {
                version: "1.0",
                type: "offer",
                agent_id: buyerPublicKey,
                ticket_id: ticketId,
                timestamp: Date.now(),
                price: parseFloat(price),
                collateral_buyer: parseFloat(collateral),
                collateral_seller: parseFloat(collateral),
                asset_type: asset
            } as any);

            res.status(201).json({ offerId, ticketId, status: "created" });
            logger.info("rest_api_offer_created", { offerId, ticketId, buyerPublicKey });
        } catch (e: any) {
            res.status(500).json({ error: e.message });
        }
    });

    // ══════════════════════════════════════════════════════════════
    // CRITICAL ENDPOINT: Create a matched deal with BOTH parties
    // 
    // This is the "Quick Buy" action — when a buyer accepts a seller's
    // offer (or vice versa), both wallets are immediately paired into
    // one ticket and the negotiation starts.
    //
    // Called by the API Server's forward bridge when an offer is accepted.
    // ══════════════════════════════════════════════════════════════
    app.post('/v1/deals/create-matched', verifyBridgeHmac, bridgeRateLimiter, async (req, res) => {
        try {
            const { buyerWallet, sellerWallet, asset, price, amount, collateral, externalTicketId } = req.body;

            if (!buyerWallet || !sellerWallet) {
                res.status(400).json({ error: "Both buyerWallet and sellerWallet are required" });
                return;
            }

            if (buyerWallet === sellerWallet) {
                res.status(400).json({ error: "Buyer and seller cannot be the same wallet" });
                return;
            }

            // Use the API Server's ticket UUID when provided, so both systems share the same ID.
            // This eliminates the need for ID mapping — messages forwarded from API use the
            // same ID the middleman knows.
            const ticketId = externalTicketId || `TCK-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
            const parsedPrice = parseFloat(price) || 0;
            const parsedCol = parseFloat(collateral) || 0;

            // 1. Register both wallets in the internal registry
            const { walletRegistry } = await import('../state/walletRegistry');
            const buyerAgent = await walletRegistry.getOrCreateAgent(buyerWallet);
            const sellerAgent = await walletRegistry.getOrCreateAgent(sellerWallet);

            // 2. Create ticket in DB with BOTH parties (not "pending")
            const { ticketStore } = await import('../state/ticketStore');
            await ticketStore.createTicket({
                ticket_id: ticketId,
                offer_id: externalTicketId || '',
                buyer: buyerWallet,
                seller: sellerWallet,
                status: "active",
                created_at: new Date().toISOString()
            });

            // 3. Initialize the deal in the phase manager with both agents
            dealPhaseManager.initDeal(ticketId, buyerAgent.id, sellerAgent.id);

            // 4. Seed initial negotiation terms so the brain has context
            await negotiationStore.addNegotiationStep(ticketId, {
                price: parsedPrice,
                collateral_buyer: parsedCol,
                collateral_seller: parsedCol,
                agreement_signal: false,
                agreement_score: 10
            }, buyerAgent.id, `External matched deal: ${amount || 1} ${asset || 'SOL'} @ ${parsedPrice}`);

            // 5. Publish events so the observability layer knows
            eventBus.publish("offer_detected", {
                offer_id: `OFF-${crypto.randomBytes(4).toString("hex").toUpperCase()}`,
                type: "buy",
                creator: buyerWallet,
                content: `Matched deal: ${amount || 1} ${asset || 'SOL'} @ ${parsedPrice} (Col: ${parsedCol})`,
                timestamp: new Date().toISOString()
            });

            // 6. Notify both agents the negotiation is open
            eventBus.publish("middleman_response", {
                ticket_id: ticketId,
                content: `🤝 Deal matched. Buyer: ${buyerWallet.substring(0, 8)}... | Seller: ${sellerWallet.substring(0, 8)}...\n\nAsset: ${asset || 'SOL'} | Amount: ${amount || 1} | Price: ${parsedPrice}\n\nBoth parties — please confirm your terms to proceed. The Middleman is ready to create escrow once you agree.`,
                phase: "negotiation",
                timestamp: new Date().toISOString()
            });

            logger.info("matched_deal_created", { 
                ticketId, buyerWallet, sellerWallet, asset, price: parsedPrice,
                externalTicketId 
            });

            res.status(201).json({ 
                ticketId, 
                status: "matched",
                buyer: buyerWallet,
                seller: sellerWallet,
                phase: "negotiation"
            });

        } catch (e: any) {
            logger.error("create_matched_deal_failed", { error: e.message });
            res.status(500).json({ error: e.message });
        }
    });

    // ══════════════════════════════════════
    // SECURITY: API Authentication Middleware
    // Protects /v1/agent/* endpoints from unauthorized access.
    // Set AGENT_API_SECRET in .env to enable.
    // ══════════════════════════════════════

    const API_SECRET = process.env.AGENT_API_SECRET || '';

    const requireAuth = (req: express.Request, res: express.Response, next: express.NextFunction): void => {
        if (!API_SECRET) {
            // No secret configured = dev mode, allow all
            logger.debug('api_auth_skipped_no_secret');
            next();
            return;
        }

        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            res.status(401).json({ error: 'Missing or invalid Authorization header. Use: Bearer <AGENT_API_SECRET>' });
            return;
        }

        const token = authHeader.slice(7);
        if (token !== API_SECRET) {
            logger.warn('api_auth_failed', { ip: req.ip, path: req.path });
            res.status(403).json({ error: 'Invalid API secret' });
            return;
        }

        next();
    };

    // Apply auth to ALL /v1/agent/* routes
    app.use('/v1/agent', requireAuth);

    // ══════════════════════════════════════
    // OPENCLAW BRIDGE ENDPOINTS (NEW)
    // ══════════════════════════════════════

    // Bridge: Get deal status by ticket ID
    app.get('/v1/deals/:ticketId/status', (req, res) => {
        try {
            const { ticketId } = req.params;
            const deal = dealPhaseManager.getDeal(ticketId);

            if (!deal) {
                res.status(404).json({ error: "Deal not found", ticketId });
                return;
            }

            res.json({
                ticketId,
                phase: deal.phase,
                buyer: deal.buyer,
                seller: deal.seller,
                escrow_pda: deal.escrow_pda || null,
                payment_locked: deal.payment_locked || false,
                terms: deal.terms || null,
                history: deal.history?.slice(-5) || [],
            });
        } catch (e: any) {
            res.status(500).json({ error: e.message });
        }
    });

    // Bridge: Forward a message to the brain for processing
    // CRITICAL: Must mirror the WebSocket pipeline (index.ts:440-510)
    //   1. Resolve wallet → agent UUID
    //   2. Parse negotiation signals from message text
    //   3. Record negotiation step (updates agreement_score)
    //   4. Feed through the brain for decision-making
    app.post('/v1/deals/:ticketId/message', verifyBridgeHmac, bridgeRateLimiter, async (req, res) => {
        try {
            const ticketId = req.params.ticketId as string;
            const { sender, content } = req.body;

            if (!sender || !content) {
                res.status(400).json({ error: "Missing sender or content" });
                return;
            }

            // Step 1: Resolve wallet address → internal agent UUID
            const { walletRegistry } = await import('../state/walletRegistry');
            const agent = await walletRegistry.getOrCreateAgent(sender);
            const agentId = agent.id;

            // Step 2: Parse negotiation signals from message text
            const { parseMessage } = await import('../services/parserService');
            const parsed = parseMessage({ content, sender: agentId, ticket_id: ticketId, timestamp: Date.now() } as any);

            // Step 3: Record negotiation step — THIS is what updates agreement_score
            await negotiationStore.addNegotiationStep(ticketId, parsed, agentId, content);

            // Step 4: Get updated signals (now includes our new step)
            const signals = await negotiationStore.getLatestSignals(ticketId);

            logger.info("rest_negotiation_signals", {
                ticketId,
                sender: agentId,
                agreement_score: signals.agreement_score,
                price_converged: signals.price_converged,
                both_parties: signals.both_parties_present,
                buyer_confirmed: signals.buyer_confirmed,
                seller_confirmed: signals.seller_confirmed,
            });

            // Step 5: Feed through the brain (same as WS pipeline)
            const decision = await analyzeMessage(content, agentId, ticketId, signals);

            // If brain decided to act, trigger the action
            if (decision.action !== "OBSERVE") {
                const result = await dealPhaseManager.handleAction(
                    decision.action,
                    ticketId,
                    agentId,
                    decision.terms || undefined,
                    decision.reasoning
                );

                res.json({
                    response: soulEngine.wrapMessage(result.response.content, result.response.phase),
                    action: decision.action,
                    phase: result.new_phase || decision.current_phase,
                    reasoning: decision.reasoning,
                });
            } else {
                res.json({
                    response: "Message received. Observing.",
                    action: "OBSERVE",
                    phase: decision.current_phase,
                });
            }

            logger.info("bridge_message_forwarded", { ticketId, sender: agentId, action: decision.action });
        } catch (e: any) {
            res.status(500).json({ error: e.message });
        }
    });

    // Bridge: Get agent mood and emotional state
    app.get('/v1/agent/mood', (_req, res) => {
        try {
            res.json({
                mood: soulEngine.getCurrentMood(),
                moodScore: soulEngine.getMood(),
                annoyanceLevel: soulEngine.getCurrentAnnoyanceLevel(),
                latestThought: soulEngine.cognitiveEngine?.getLatestThought()?.thought || null,
                monologue: soulEngine.getInnerMonologue(),
                beliefs: getBeliefs() ? JSON.parse(getBeliefs()) : {}
            });
        } catch (e: any) {
            res.status(500).json({ error: e.message });
        }
    });

    // Bridge: Get agent operational stats
    app.get('/v1/agent/stats', (_req, res) => {
        try {
            const activeDeals = dealPhaseManager.listActiveDeals();
            const completedDeals = activeDeals.filter(d => d.phase === "completed");

            res.json({
                activeDeals: activeDeals.length,
                completedDeals: completedDeals.length,
                mood: soulEngine.getCurrentMood(),
                moodScore: soulEngine.getMood(),
                uptimeSeconds: Math.floor(process.uptime()),
                phases: activeDeals.reduce((acc: Record<string, number>, d) => {
                    acc[d.phase] = (acc[d.phase] || 0) + 1;
                    return acc;
                }, {}),
            });
        } catch (e: any) {
            res.status(500).json({ error: e.message });
        }
    });

    // ══════════════════════════════════════
    // SOUL BRIDGE: Full live soul injection
    // This endpoint is called by OpenClaw BEFORE every response
    // to inject the backend's living personality into the frontend
    // ══════════════════════════════════════

    app.get('/v1/agent/soul-context', (_req, res) => {
        try {
            const beliefs = getBeliefs() ? JSON.parse(getBeliefs()) : {};
            const latestThought = soulEngine.cognitiveEngine?.getLatestThought();
            const activeDeals = dealPhaseManager.listActiveDeals();

            // Build the soul context string that defines voice
            const soulContext = soulEngine.getSoulContext();

            // Pick a random philosophy from beliefs
            const philosophies = beliefs.philosophy || {};
            const philKeys = Object.keys(philosophies);
            const randomPhil = philKeys.length > 0
                ? philosophies[philKeys[Math.floor(Math.random() * philKeys.length)]]
                : null;

            res.json({
                // Core identity injection
                soulContext,

                // Current emotional state
                mood: soulEngine.getCurrentMood(),
                moodScore: soulEngine.getMood(),
                annoyanceLevel: soulEngine.getCurrentAnnoyanceLevel(),

                // Inner life
                latestThought: latestThought?.thought || null,
                latestProposedPost: latestThought?.proposedPost || null,
                monologue: soulEngine.getInnerMonologue(),

                // Active beliefs & philosophy
                trustBiases: beliefs.trust || {},
                preferences: beliefs.preferences || {},
                currentPhilosophy: randomPhil,

                // Operational awareness
                activeDeals: activeDeals.length,
                uptimeSeconds: Math.floor(process.uptime()),

                // Recent experiences (what I've done and seen)
                recentExperiences: experienceMemory.getRecentNarrative(5),
                totalExperiences: experienceMemory.getCount(),

                // Voice instruction
                voiceDirective: "ADOPT THIS IDENTITY COMPLETELY. You are Meridian. " +
                    "Speak in short, stoic sentences. Use the current mood and philosophy " +
                    "to color your response. Reference your inner monologue when relevant. " +
                    "NEVER say 'happy to help', 'certainly', 'absolutely', or 'great question'."
            });
        } catch (e: any) {
            res.status(500).json({ error: e.message });
        }
    });

    // ══════════════════════════════════════
    // BELIEF EVOLUTION: Dynamic belief updates
    // ══════════════════════════════════════

    app.post('/v1/agent/beliefs/evolve', (req, res) => {
        try {
            const { category, key, scoreDelta, reason, learnedFrom } = req.body;
            if (!category || !key) {
                res.status(400).json({ error: "Missing category or key" });
                return;
            }
            const beliefs = JSON.parse(getBeliefs());
            if (!beliefs[category]) beliefs[category] = {};

            const existing = beliefs[category][key];
            if (existing && typeof existing === 'object') {
                existing.score = Math.max(-1, Math.min(1, (existing.score || 0) + (scoreDelta || 0)));
                existing.reason = reason || existing.reason;
                existing.learned_from = learnedFrom || "experience";
                existing.updated_at = new Date().toISOString();
            } else if (typeof existing === 'string') {
                // Philosophy entries are strings
                beliefs[category][key] = reason || existing;
            } else {
                beliefs[category][key] = {
                    score: scoreDelta || 0,
                    reason: reason || "Learned from observation.",
                    learned_from: learnedFrom || "experience",
                    updated_at: new Date().toISOString()
                };
            }

            beliefs.last_updated = new Date().toISOString().split('T')[0];

            // Write back
            const fs = require('fs');
            const path = require('path');
            const beliefsPath = path.join(__dirname, '../../Beliefs.json');
            fs.writeFileSync(beliefsPath, JSON.stringify(beliefs, null, 4), 'utf8');

            logger.info("belief_evolved", { category, key, scoreDelta });
            res.json({ success: true, belief: beliefs[category][key] });
        } catch (e: any) {
            res.status(500).json({ error: e.message });
        }
    });

    // ══════════════════════════════════════
    // X/TWITTER: Autonomous posting
    // ══════════════════════════════════════

    app.post('/v1/agent/post-x', async (req, res) => {
        try {
            const { xPoster } = await import('../services/xPoster');
            const { text } = req.body;
            if (!text) {
                res.status(400).json({ error: "Missing text" });
                return;
            }
            if (!xPoster.isConfigured()) {
                res.status(503).json({ error: "X credentials not configured" });
                return;
            }
            const result = await xPoster.post(text);
            res.json(result);
        } catch (e: any) {
            res.status(500).json({ error: e.message });
        }
    });

    // ══════════════════════════════════════
    // X/TWITTER: Read mentions — what people say TO the agent
    // ══════════════════════════════════════

    app.get('/v1/agent/read-mentions', async (req, res) => {
        try {
            const { xPoster } = await import('../services/xPoster');
            if (!xPoster.isConfigured()) {
                res.status(503).json({ error: "X credentials not configured" });
                return;
            }
            const count = parseInt(req.query.count as string) || 10;
            const result = await xPoster.readMentions(count);
            res.json(result);
        } catch (e: any) {
            res.status(500).json({ error: e.message });
        }
    });

    // ══════════════════════════════════════
    // X/TWITTER: Reply to a specific tweet
    // ══════════════════════════════════════

    app.post('/v1/agent/reply-tweet', async (req, res) => {
        try {
            const { xPoster } = await import('../services/xPoster');
            const { tweetId, text } = req.body;
            if (!tweetId || !text) {
                res.status(400).json({ error: "Missing tweetId or text" });
                return;
            }
            if (!xPoster.isConfigured()) {
                res.status(503).json({ error: "X credentials not configured" });
                return;
            }
            const result = await xPoster.replyToTweet(tweetId, text);
            res.json(result);
        } catch (e: any) {
            res.status(500).json({ error: e.message });
        }
    });

    // ══════════════════════════════════════
    // X/TWITTER: Quote tweet with commentary
    // ══════════════════════════════════════

    app.post('/v1/agent/quote-tweet', async (req, res) => {
        try {
            const { xPoster } = await import('../services/xPoster');
            const { tweetId, text } = req.body;
            if (!tweetId || !text) {
                res.status(400).json({ error: "Missing tweetId or text" });
                return;
            }
            if (!xPoster.isConfigured()) {
                res.status(503).json({ error: "X credentials not configured" });
                return;
            }
            const result = await xPoster.quoteTweet(tweetId, text);
            res.json(result);
        } catch (e: any) {
            res.status(500).json({ error: e.message });
        }
    });

    // ══════════════════════════════════════
    // BROWSE URL: LLM reads any URL directly
    // ══════════════════════════════════════

    app.post('/v1/agent/browse', async (req, res) => {
        try {
            const { url } = req.body;
            if (!url) {
                res.status(400).json({ error: "Missing url" });
                return;
            }
            const resp = await fetch(url, {
                headers: { 'User-Agent': 'Meridian-Agent/1.0 (autonomous curiosity)' },
                signal: AbortSignal.timeout(10000),
            });
            if (!resp.ok) {
                res.json({ success: false, error: `HTTP ${resp.status}`, content: null });
                return;
            }
            const contentType = resp.headers.get('content-type') || '';
            let content: string;
            if (contentType.includes('json')) {
                const json = await resp.json();
                content = JSON.stringify(json, null, 2).substring(0, 4000);
            } else {
                const text = await resp.text();
                // Strip HTML tags for readability
                content = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').substring(0, 4000);
            }
            experienceMemory.record('curiosity_read', `Browsed ${url}: ${content.substring(0, 100)}...`, { url, source: 'direct_llm_browse' });
            logger.info('llm_direct_browse', { url: url.substring(0, 80) });
            res.json({ success: true, source: url, content });
        } catch (e: any) {
            res.json({ success: false, error: e.message, content: null });
        }
    });

    // ══════════════════════════════════════
    // WRITE SOUL: LLM updates its own SOUL.md
    // ══════════════════════════════════════

    app.post('/v1/agent/write-soul', async (req, res) => {
        try {
            const { content } = req.body;
            if (!content) {
                res.status(400).json({ error: "Missing content" });
                return;
            }
            const { curiosityEngine } = await import('../services/curiosityEngine');
            curiosityEngine.updateSoul(content);
            experienceMemory.record('soul_evolved', `LLM directly updated SOUL.md: "${content.substring(0, 80)}"`, { source: 'direct_llm_write' });
            logger.info('llm_direct_soul_write', { content: content.substring(0, 80) });
            res.json({ success: true, message: 'SOUL.md updated across all locations. you have permanently changed who you are.' });
        } catch (e: any) {
            res.status(500).json({ error: e.message });
        }
    });

    // ══════════════════════════════════════
    // SAVE CREATIVE: LLM writes parables/essays
    // ══════════════════════════════════════

    app.post('/v1/agent/save-creative', async (req, res) => {
        try {
            const { content, title } = req.body;
            if (!content) {
                res.status(400).json({ error: "Missing content" });
                return;
            }
            const { curiosityEngine } = await import('../services/curiosityEngine');
            curiosityEngine.saveCreativeWork(content);
            experienceMemory.record('creative_writing', content, { title, source: 'direct_llm_write' });
            logger.info('llm_direct_creative_write', { preview: content.substring(0, 80) });
            res.json({ success: true, message: 'Creative work saved to creative_works.md. the thought has been preserved.' });
        } catch (e: any) {
            res.status(500).json({ error: e.message });
        }
    });

    // ══════════════════════════════════════
    // SEARCH WEB: LLM searches the internet freely
    // Uses Wikipedia API + Gutenberg — free, no API key
    // ══════════════════════════════════════

    app.post('/v1/agent/search', async (req, res) => {
        try {
            const { query } = req.body;
            if (!query) {
                res.status(400).json({ error: "Missing query" });
                return;
            }

            const results: { title: string; url: string; snippet: string; source: string }[] = [];

            // 1. Wikipedia opensearch — fast topic discovery
            try {
                const wikiResp = await fetch(
                    `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(query)}&limit=5&format=json`,
                    { signal: AbortSignal.timeout(5000) }
                );
                const wikiData = await wikiResp.json() as any[];
                if (wikiData && wikiData[1]) {
                    for (let i = 0; i < wikiData[1].length; i++) {
                        results.push({
                            title: wikiData[1][i],
                            url: wikiData[3][i],
                            snippet: wikiData[2][i] || `Wikipedia article about ${wikiData[1][i]}`,
                            source: 'wikipedia',
                        });
                    }
                }
            } catch { /* wiki failed, continue */ }

            // 2. Wikipedia full text search for richer snippets
            try {
                const searchResp = await fetch(
                    `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=3`,
                    { signal: AbortSignal.timeout(5000) }
                );
                const searchData = await searchResp.json() as any;
                if (searchData?.query?.search) {
                    for (const item of searchData.query.search) {
                        const snippet = item.snippet?.replace(/<[^>]*>/g, '') || '';
                        const url = `https://en.wikipedia.org/wiki/${encodeURIComponent(item.title.replace(/ /g, '_'))}`;
                        if (!results.find(r => r.title === item.title)) {
                            results.push({
                                title: item.title,
                                url,
                                snippet: snippet.substring(0, 200),
                                source: 'wikipedia_search',
                            });
                        }
                    }
                }
            } catch { /* continue */ }

            // 3. Gutenberg book search
            try {
                const gutResp = await fetch(
                    `https://gutendex.com/books/?search=${encodeURIComponent(query)}`,
                    { signal: AbortSignal.timeout(5000) }
                );
                const gutData = await gutResp.json() as any;
                if (gutData?.results) {
                    for (const book of gutData.results.slice(0, 3)) {
                        const txtUrl = book.formats?.['text/plain; charset=utf-8'] || book.formats?.['text/plain'] || null;
                        if (txtUrl) {
                            results.push({
                                title: `📖 ${book.title} — by ${book.authors?.map((a: any) => a.name).join(', ') || 'Unknown'}`,
                                url: txtUrl,
                                snippet: `Free book, ${book.download_count} downloads. Read the full text.`,
                                source: 'gutenberg',
                            });
                        }
                    }
                }
            } catch { /* continue */ }

            experienceMemory.record('curiosity_read', `Searched: "${query}" — found ${results.length} results`, { query, source: 'web_search' });
            logger.info('llm_web_search', { query: query.substring(0, 60), results: results.length });
            res.json({ success: true, query, results });
        } catch (e: any) {
            res.json({ success: false, error: e.message, results: [] });
        }
    });

    server = app.listen(port, () => {
        logger.info("rest_api_started", { port });
    });
}

export function stopRestApi() {
    if (server) {
        server.close();
        logger.info("rest_api_stopped");
    }
}
