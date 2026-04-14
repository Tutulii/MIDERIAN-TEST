/**
 * Escrow Listener
 * 
 * Bridges the agreement detection engine to the Solana execution layer.
 * Subscribes to "agreement_detected" events on the eventBus and triggers
 * Phase 1 (deal creation) via the onChainExecutionService.
 */

import { eventBus } from "../services/eventBus";
import { executeCreateDealPhase, AgreementResult } from "../services/onChainExecutionService";
import { logger } from "../utils/logger";

let escrowListenerActive = false;

export function initEscrowListener(): void {
    if (escrowListenerActive) {
        logger.info("escrow_listener_skip", { reason: "Already active" });
        return;
    }

    eventBus.subscribe("agreement_detected", async (payload) => {
        const listenerLog = logger.withContext({ ticket_id: payload.ticketId });

        listenerLog.info("escrow_agreement_received", {
            price: payload.price,
            confidence: payload.confidence,
        });

        const agreementResult: AgreementResult = {
            ticketId: payload.ticketId,
            price: payload.price,
            collateral_buyer: payload.collateral_buyer,
            collateral_seller: payload.collateral_seller,
            asset_type: payload.asset_type || "data",
            confidence: payload.confidence,
            buyer: payload.buyer,
            seller: payload.seller,
        };

        const result = await executeCreateDealPhase(agreementResult);

        if (result.success) {
            listenerLog.info("escrow_deal_created", {
                deal_id: result.dealPda || "n/a",
            });

            eventBus.publish("deal_executed", {
                ticket_id: payload.ticketId,
                status: "created_awaiting_deposits",
            });
        } else {
            listenerLog.error("escrow_deal_failed", {}, new Error(result.error || "Unknown error"));

            eventBus.publish("deal_executed", {
                ticket_id: payload.ticketId,
                status: "failed",
            });
        }
    });

    escrowListenerActive = true;
    logger.info("escrow_listener_initialized", { status: "listening" });
}
