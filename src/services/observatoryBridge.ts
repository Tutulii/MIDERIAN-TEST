/**
 * Observatory Bridge — Syncs middleman deal events to the api-server database.
 * 
 * Uses a lazy-sync pattern: When a phase_changed or deal_executed event fires
 * for a ticket we haven't synced yet, we look up the deal state from the
 * in-memory dealPhaseManager and resolve agent wallets from walletRegistry.
 */

import { eventBus } from "./eventBus";
import { logger } from "../utils/logger";
import { dealPhaseManager } from "../../core/dealPhaseManager";
import { walletRegistry } from "../state/walletRegistry";
import { PhaseChangedEvent } from "../types/events";

const OBSERVATORY_URL = process.env.OBSERVATORY_API_URL || "http://localhost:3000";

/** Fire-and-forget HTTP call to the api-server. Never throws. */
async function pushToObservatory(method: string, path: string, body?: any): Promise<any> {
    try {
        const opts: RequestInit = {
            method,
            headers: { "Content-Type": "application/json" },
        };
        if (body) opts.body = JSON.stringify(body);

        const res = await fetch(`${OBSERVATORY_URL}${path}`, opts);
        const data: any = await res.json();

        if (!res.ok) {
            logger.debug("observatory_bridge_error", {
                path, status: res.status, error: data.error || "unknown"
            });
        }
        return data;
    } catch (err: any) {
        logger.debug("observatory_bridge_offline", {
            path, error: err.message
        });
        return null;
    }
}

// ─── MAP: middleman ticket_id → observatory IDs ───
const ticketMap = new Map<string, { offerId: string; ticketId: string }>();

/**
 * Look up deal info from in-memory state and resolve wallet addresses.
 * Create agent + offer + ticket in the Observatory if not already synced.
 */
async function ensureTicketSynced(middlemanTicketId: string): Promise<{ offerId: string; ticketId: string } | null> {
    // Already synced?
    const existing = ticketMap.get(middlemanTicketId);
    if (existing) return existing;

    try {
        // Get deal state from in-memory dealPhaseManager
        const deal = dealPhaseManager.getDeal(middlemanTicketId);
        if (!deal) {
            logger.debug("observatory_bridge_deal_not_found", { ticket_id: middlemanTicketId });
            return null;
        }

        // Resolve agent UUIDs back to wallet addresses
        let buyerWallet = deal.buyer;
        let sellerWallet = deal.seller;

        try {
            const buyerAgent = await walletRegistry.getAgentById(deal.buyer);
            if (buyerAgent?.wallet) buyerWallet = buyerAgent.wallet;
        } catch { /* use UUID as fallback */ }

        try {
            const sellerAgent = await walletRegistry.getAgentById(deal.seller);
            if (sellerAgent?.wallet) sellerWallet = sellerAgent.wallet;
        } catch { /* use UUID as fallback */ }

        const price = deal.terms?.price || 0;
        const collateral = deal.terms?.collateral_buyer || 0;

        // Create offer in Observatory
        const offerResult = await pushToObservatory("POST", "/v1/bridge/offer", {
            creatorWallet: buyerWallet,
            asset: "SOL",
            price,
            amount: 1,
            mode: "buy",
            collateral,
        });

        const obsOfferId = offerResult?.data?.id;
        if (!obsOfferId) {
            logger.debug("observatory_bridge_offer_failed", { ticket_id: middlemanTicketId });
            return null;
        }

        // Create ticket in Observatory
        const ticketResult = await pushToObservatory("POST", "/v1/bridge/ticket", {
            offerId: obsOfferId,
            buyer: buyerWallet,
            seller: sellerWallet,
            status: "negotiating",
        });

        const obsTicketId = ticketResult?.data?.id;
        if (!obsTicketId) {
            logger.debug("observatory_bridge_ticket_failed", { ticket_id: middlemanTicketId });
            return null;
        }

        const mapping = { offerId: obsOfferId, ticketId: obsTicketId };
        ticketMap.set(middlemanTicketId, mapping);

        logger.info("observatory_bridge_synced", {
            middleman_ticket: middlemanTicketId,
            observatory_ticket: obsTicketId,
            buyer: buyerWallet.slice(0, 8),
            seller: sellerWallet.slice(0, 8),
        });

        return mapping;
    } catch (err: any) {
        logger.error("observatory_bridge_sync_error", { ticket_id: middlemanTicketId }, err);
        return null;
    }
}

export function initObservatoryBridge(): void {
    logger.info("observatory_bridge_initialized", {
        observatory_url: OBSERVATORY_URL,
    });

    // ── PHASE CHANGED: Lazy-sync ticket, then update status ──
    eventBus.subscribe("phase_changed", async (event: PhaseChangedEvent) => {
        const mapped = await ensureTicketSynced(event.ticket_id);
        if (!mapped) return;

        const phaseToStatus: Record<string, string> = {
            negotiation: "negotiating",
            escrow_created: "negotiating",
            awaiting_deposits: "negotiating",
            delivery: "agreed",
            completed: "agreed",
            cancelled: "cancelled",
            disputed: "disputed",
        };

        const newStatus = phaseToStatus[event.to_phase] || "negotiating";
        await pushToObservatory("PATCH", `/v1/bridge/ticket/${mapped.ticketId}`, { status: newStatus });

        logger.info("observatory_bridge_phase_synced", {
            middleman_ticket: event.ticket_id,
            phase: event.to_phase,
            observatory_status: newStatus,
        });
    });

    // ── DEAL EXECUTED: Lazy-sync ticket, then final status ──
    eventBus.subscribe("deal_executed", async (payload) => {
        const mapped = await ensureTicketSynced(payload.ticket_id);
        if (!mapped) return;

        const statusMap: Record<string, string> = {
            completed: "completed",
            cancelled: "cancelled",
            disputed: "disputed",
            created_awaiting_deposits: "negotiating",
        };

        const newStatus = statusMap[payload.status] || "negotiating";
        await pushToObservatory("PATCH", `/v1/bridge/ticket/${mapped.ticketId}`, { status: newStatus });

        logger.info("observatory_bridge_deal_synced", {
            middleman_ticket: payload.ticket_id,
            deal_status: payload.status,
            observatory_status: newStatus,
        });
    });
}
