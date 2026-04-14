/**
 * Execution Service (src/ module)
 *
 * Called by src/index.ts when agreement_detected fires through the
 * negotiation pipeline.
 *
 * Option A Flow (Autonomous Deposits):
 *   1. Creates deal on-chain (middleman signs)
 *   2. Starts deposit watcher on the deal PDA
 *   3. Tells buyer/seller the PDA address to send SOL
 *   4. depositWatcher detects deposits → triggers confirm_deposit
 *   5. When buyer confirms receipt → middleman releases funds
 */

import { Connection, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { ticketStore } from "../state/ticketStore";
import { detectAgreement } from "../../services/agreementService";
import { executionStore } from "../state/executionStore";
import { dealTracker } from "../state/dealTracker";
import { walletRegistry } from "../state/walletRegistry";
import { eventBus } from "./eventBus";
import { logger } from "../utils/logger";
import { circuitBreaker } from "../utils/circuitBreaker";
import {
  executeCreateDealPhase,
  executeReleasePhase,
  executeFullDealLifecycle,
  getDealContext,
  AgreementResult,
  assertDealWithinLifetime,
} from "./onChainExecutionService";
import { watchForDeposits } from "../listeners/depositWatcher";
import { dealPhaseManager } from "../../core/dealPhaseManager";
import { createConnection } from "../solana/connection";
import { loadConfig } from "../config";
import { appendAuditLog } from "./auditTrail";
import { economicSafety } from "./economicSafety";
import { reputationEngine } from "./reputationEngine";

import { shutdownManager } from "../utils/shutdownManager";

/**
 * Execute a deal using the Option A autonomous flow.
 */
export async function executeDeal(ticket_id: string): Promise<void> {
  const executionLogger = logger.withContext({ ticket_id });
  executionLogger.info("executeDeal_invoked");

  if (!shutdownManager.canAcceptNewWork()) {
    executionLogger.warn("execution_aborted", { reason: "shutdown_in_progress", step: "executeDeal" });
    return;
  }

  if (circuitBreaker.isOpen()) {
    executionLogger.warn("execution_aborted", { reason: "circuit_breaker_open" });
    return;
  }

  // STEP 1: LOAD STATE
  const ticket = await ticketStore.getTicket(ticket_id);
  const agreement = await detectAgreement(ticket_id);

  if (!ticket) {
    executionLogger.error("execution_aborted", { reason: "ticket_not_found" });
    return;
  }

  if (!agreement) {
    executionLogger.error("execution_aborted", { reason: "agreement_confidence_failed" });
    return;
  }

  // LEVEL 5: ECONOMIC SAFETY VALIDATION
  const econCheck = await economicSafety.validateDeal({
    buyerAgentId: ticket.buyer,
    sellerAgentId: ticket.seller,
    priceSol: agreement.price,
    collateralBuyerSol: agreement.collateral_buyer,
    collateralSellerSol: agreement.collateral_seller,
  });

  if (!econCheck.valid) {
    executionLogger.error("economic_safety_blocked", { errors: econCheck.errors });
    appendAuditLog(ticket_id, "deal_blocked_economic_safety", { errors: econCheck.errors });
    return;
  }

  if (econCheck.warnings.length > 0) {
    executionLogger.warn("economic_safety_warnings", { warnings: econCheck.warnings });
  }

  // STEP 3: PREVENT DOUBLE EXECUTION (Mutex Lock)
  const canExecute = await executionStore.beginExecution(ticket_id, "create_deal");
  if (!canExecute) {
    executionLogger.info("duplicate_execution_blocked", { step: "create_deal" });
    return;
  }

  executionLogger.info("deal_execution_started");

  const agreementResult = agreement;

  try {
    const result = await executeCreateDealPhase({
      ...agreementResult,
      ticketId: agreementResult.ticket_id,
      buyer: ticket.buyer,
      seller: ticket.seller
    } as any);

    if (!result.success) {
      await executionStore.markFailed(ticket_id, "create_deal");
      await dealTracker.updateStatus(ticket_id, "failed", result.error);
      appendAuditLog(ticket_id, "deal_creation_failed", { error: result.error });
      executionLogger.error("deal_execution_failed", { step: "create_deal", error_message: result.error });
      return;
    }

    appendAuditLog(ticket_id, "deal_created_onchain", { dealPda: result.dealPda, tx: result.tx });

    await dealTracker.storeOnChainId(ticket_id, result.dealPda || "unknown");

    // STEP 6: STORE PDA ADDRESS ON DEAL STATE
    const dealCtx = getDealContext(ticket_id);
    if (dealCtx && result.dealPda) {
      dealPhaseManager.setEscrowPda(ticket_id, result.dealPda);

      executionLogger.info("deal_execution_step_success", {
        step: "deal_pda_stored",
        deal_id: result.dealPda,
      });

      // STEP 7: START DEPOSIT WATCHER (Gap 2 fix)
      const config = loadConfig();
      const connection = createConnection(config.solanaRpcUrl);

      watchForDeposits(
        connection,
        ticket_id,
        dealCtx.dealPda,
        Math.floor(agreementResult.collateral_buyer * LAMPORTS_PER_SOL),
        Math.floor(agreementResult.collateral_seller * LAMPORTS_PER_SOL),
        Math.floor(agreementResult.price * LAMPORTS_PER_SOL),
      );

      executionLogger.info("deal_execution_step_started", {
        step: "deposit_watcher_activated",
        deal_id: result.dealPda,
        watching_for: {
          buyer_collateral: agreementResult.collateral_buyer,
          seller_collateral: agreementResult.collateral_seller,
          payment: agreementResult.price,
        },
      });

      // STEP 8: ADVANCE TO AWAITING_DEPOSITS PHASE
      const depositPhaseResult = await dealPhaseManager.advanceToAwaitingDeposits(ticket_id);

      if (depositPhaseResult) {
        // Publish the deposit instruction message (contains the PDA address)
        eventBus.publish("middleman_response", {
          ticket_id: depositPhaseResult.response.ticket_id,
          content: depositPhaseResult.response.content,
          phase: depositPhaseResult.response.phase,
          timestamp: depositPhaseResult.response.timestamp,
        });
      }
    }

  } catch (error) {
    await dealTracker.updateStatus(ticket_id, "failed", String(error));
    executionLogger.error("deal_execution_failed", { step: "create_deal" }, error);
    return;
  }

  eventBus.publish("deal_executed", {
    ticket_id,
    status: "created_awaiting_deposits",
  });
}

/**
 * Execute the release phase (Phase 2).
 * Called when buyer confirms receipt via NLP → RELEASE_FUNDS action.
 */
export async function executeRelease(ticket_id: string): Promise<void> {
  const executionLogger = logger.withContext({ ticket_id });
  executionLogger.info("executeRelease_invoked");

  if (!shutdownManager.canAcceptNewWork()) {
    executionLogger.warn("execution_aborted", { reason: "shutdown_in_progress", step: "executeRelease" });
    return;
  }

  const canExecute = await executionStore.beginExecution(ticket_id, "release_funds");
  if (!canExecute) {
    executionLogger.info("duplicate_execution_blocked", { step: "release_funds" });
    return;
  }

  try {
    // Deal TTL check before release
    const deal = await dealPhaseManager.getDealWithFallback(ticket_id);
    if (deal) {
      assertDealWithinLifetime(deal.created_at, ticket_id);
    }

    const result = await executeReleasePhase(ticket_id);

    if (result.success) {
      await executionStore.markSuccess(ticket_id, "release_funds", result.tx || "unknown_tx");
      await dealTracker.updateStatus(ticket_id, "completed");
      appendAuditLog(ticket_id, "funds_released", { tx: result.tx });

      // LEVEL 5: Reputation reward for both parties
      const ticket = await ticketStore.getTicket(ticket_id);
      if (ticket) {
        reputationEngine.recordCompletion(ticket.buyer).catch(() => { });
        reputationEngine.recordCompletion(ticket.seller).catch(() => { });
      }

      executionLogger.info("deal_execution_step_success", {
        step: "release_phase_complete",
        tx: result.tx,
      });

      eventBus.publish("deal_executed", {
        ticket_id,
        status: "completed",
      });
    } else {
      await executionStore.markFailed(ticket_id, "release_funds");
      await dealTracker.updateStatus(ticket_id, "failed", result.error);
      appendAuditLog(ticket_id, "release_failed", { error: result.error });

      // LEVEL 5: Reputation penalty for both parties
      const ticket = await ticketStore.getTicket(ticket_id);
      if (ticket) {
        reputationEngine.recordFailure(ticket.buyer).catch(() => { });
        reputationEngine.recordFailure(ticket.seller).catch(() => { });
      }

      executionLogger.error("deal_execution_failed", { step: "release_phase_failed", error_message: result.error });
    }
  } catch (error) {
    await executionStore.markFailed(ticket_id, "release_funds");
    await dealTracker.updateStatus(ticket_id, "failed", String(error));
    executionLogger.error("deal_execution_failed", { step: "release_phase_failed" }, error);
  }
}

