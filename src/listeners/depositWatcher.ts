/**
 * Deposit Watcher (Option A — On-Chain Balance Monitor)
 *
 * Watches deal PDA accounts for incoming plain SOL transfers.
 * When the balance increases enough to cover the next expected deposit,
 * the middleman automatically calls `confirm_deposit` on-chain.
 */

import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { logger } from "../utils/logger";
import { eventBus } from "../services/eventBus";
import { dealTracker } from "../state/dealTracker";
import { prisma } from "../lib/prisma";

// Track active watchers so we can unsubscribe later
const activeWatchers: Map<string, { subId: number; connection: Connection }> = new Map();

// Track last known balance per PDA to detect deposits
const lastKnownBalance: Map<string, number> = new Map(); // pda_base58 → lamports

export interface DepositExpectation {
  ticketId: string;
  dealPda: PublicKey;
  expectedBuyerCollateral: number;
  expectedSellerCollateral: number;
  expectedPayment: number;
  buyerDeposited: boolean;
  sellerDeposited: boolean;
  paymentDeposited: boolean;
}

const expectations: Map<string, DepositExpectation> = new Map();

export function watchForDeposits(
  connection: Connection,
  ticketId: string,
  dealPda: PublicKey,
  buyerCollateralLamports: number,
  sellerCollateralLamports: number,
  paymentLamports: number,
): void {
  if (activeWatchers.has(ticketId)) {
    logger.info("deposit_watcher_skip", { ticket_id: ticketId, reason: "Already watching" });
    return;
  }

  const pdaStr = dealPda.toBase58();
  const watcherLog = logger.withContext({ ticket_id: ticketId, deal_id: pdaStr });

  expectations.set(ticketId, {
    ticketId,
    dealPda,
    expectedBuyerCollateral: buyerCollateralLamports,
    expectedSellerCollateral: sellerCollateralLamports,
    expectedPayment: paymentLamports,
    buyerDeposited: false,
    sellerDeposited: false,
    paymentDeposited: false,
  });

  // Initialize deposit confirmation records for idempotency
  prisma.depositConfirmation.createMany({
    data: [
      { ticketId, type: "buyer_collateral" },
      { ticketId, type: "seller_collateral" },
      { ticketId, type: "buyer_payment" },
    ],
    skipDuplicates: true,
  }).catch((e: any) => {
    // Ignore if already exists (restart scenario)
    if (e.code !== "P2002") logger.debug("deposit_confirmation_init_error", { ticket_id: ticketId });
  });

  watcherLog.info("deposit_watcher_started", {
    expectedBuyerCollateral: buyerCollateralLamports / LAMPORTS_PER_SOL,
    expectedSellerCollateral: sellerCollateralLamports / LAMPORTS_PER_SOL,
    expectedPayment: paymentLamports / LAMPORTS_PER_SOL,
  });

  connection.getBalance(dealPda).then((initialBalance) => {
    lastKnownBalance.set(pdaStr, initialBalance);
    watcherLog.info("deposit_watcher_initial_balance", {
      balance: initialBalance / LAMPORTS_PER_SOL,
    });
  });

  const subscriptionId = connection.onAccountChange(
    dealPda,
    (accountInfo, _context) => {
      const newBalance = accountInfo.lamports;
      const prevBalance = lastKnownBalance.get(pdaStr) || 0;

      if (newBalance > prevBalance) {
        const deposit = newBalance - prevBalance;

        watcherLog.info("deposit_detected", {
          previousBalance: prevBalance / LAMPORTS_PER_SOL,
          newBalance: newBalance / LAMPORTS_PER_SOL,
          depositAmount: deposit / LAMPORTS_PER_SOL,
        });

        lastKnownBalance.set(pdaStr, newBalance);

        const expect = expectations.get(ticketId);
        if (expect) {
          // Fire-and-forget async confirmation
          identifyAndConfirmDeposit(connection, ticketId, expect, newBalance, deposit).catch(e => {
            watcherLog.error("deposit_confirmation_failed", { error: e.message });
          });
        }
      }
    },
    "confirmed",
  );

  activeWatchers.set(ticketId, { subId: subscriptionId, connection });
}

const processedSignatures: Map<string, Set<string>> = new Map();

async function identifyAndConfirmDeposit(
  connection: Connection,
  ticketId: string,
  expect: DepositExpectation,
  currentBalance: number,
  depositAmount: number,
): Promise<void> {
  const DUST_TOLERANCE = 2000; // Allow max 2000 lamports drift for rent/fees

  function isClose(actual: number, expected: number): boolean {
    if (expected === 0) return false;
    return Math.abs(actual - expected) <= DUST_TOLERANCE;
  }

  // Poll recent signatures for the PDA
  const sigs = await connection.getSignaturesForAddress(expect.dealPda, { limit: 5 }, "confirmed");
  if (sigs.length === 0) {
    logger.warn("deposit_verification_failed", { ticket_id: ticketId, reason: "No signatures found" });
    return;
  }

  // Get the most recent successful signature
  const recentSig = sigs.find(s => !s.err);
  if (!recentSig) {
    logger.warn("deposit_verification_failed", { ticket_id: ticketId, reason: "No successful signatures" });
    return;
  }

  try {
    const existingTx = await prisma.transaction.findFirst({
      where: { txSignature: recentSig.signature }
    });
    if (existingTx) {
      logger.info("deposit_replay_prevented", { ticket_id: ticketId, signature: recentSig.signature });
      return;
    }
  } catch (err: any) {
    logger.error("deposit_db_check_failed", { ticket_id: ticketId, error: err.message });
  }

  // Fetch transaction to verify sender
  const tx = await connection.getTransaction(recentSig.signature, { maxSupportedTransactionVersion: 0 });
  if (!tx || !tx.transaction.message.staticAccountKeys) {
    logger.warn("deposit_verification_failed", { ticket_id: ticketId, reason: "Could not fetch tx details" });
    return;
  }

  const senderPubkey = tx.transaction.message.staticAccountKeys[0].toBase58();
  logger.info("deposit_sender_verified", { ticket_id: ticketId, sender: senderPubkey });

  // LEVEL 5: Get expected buyer/seller wallets from execution context for direction validation
  const { dealContexts } = await import("../services/onChainExecutionService");
  const dealCtx = dealContexts[ticketId];
  const expectedBuyerWallet = dealCtx?.buyer?.toBase58();
  const expectedSellerWallet = dealCtx?.seller?.toBase58();

  let depositTypes: ("buyer_collateral" | "seller_collateral" | "buyer_payment")[] = [];

  if (!expect.buyerDeposited && isClose(depositAmount, expect.expectedBuyerCollateral)) {
    // LEVEL 5: Verify sender is actually the buyer
    if (expectedBuyerWallet && senderPubkey !== expectedBuyerWallet) {
      logger.warn("deposit_direction_mismatch", { ticket_id: ticketId, type: "buyer_collateral", sender: senderPubkey, expected: expectedBuyerWallet });
      return; // Reject: wrong sender
    }
    depositTypes.push("buyer_collateral");
    expect.buyerDeposited = true;
  } else if (!expect.buyerDeposited && !expect.paymentDeposited && isClose(depositAmount, expect.expectedBuyerCollateral + expect.expectedPayment)) {
    // LEVEL 5: Grouped deposit (collateral + payment)
    if (expectedBuyerWallet && senderPubkey !== expectedBuyerWallet) {
      logger.warn("deposit_direction_mismatch", { ticket_id: ticketId, type: "buyer_grouped", sender: senderPubkey, expected: expectedBuyerWallet });
      return;
    }
    depositTypes.push("buyer_collateral", "buyer_payment");
    expect.buyerDeposited = true;
    expect.paymentDeposited = true;
  } else if (!expect.sellerDeposited && isClose(depositAmount, expect.expectedSellerCollateral)) {
    // LEVEL 5: Verify sender is actually the seller
    if (expectedSellerWallet && senderPubkey !== expectedSellerWallet) {
      logger.warn("deposit_direction_mismatch", { ticket_id: ticketId, type: "seller_collateral", sender: senderPubkey, expected: expectedSellerWallet });
      return; // Reject: wrong sender
    }
    depositTypes.push("seller_collateral");
    expect.sellerDeposited = true;
  } else if (!expect.buyerDeposited && !expect.sellerDeposited && isClose(depositAmount, expect.expectedBuyerCollateral + expect.expectedSellerCollateral)) {
    // Both collaterals landed in same block (0.02 + 0.02 = 0.04)
    depositTypes.push("buyer_collateral", "seller_collateral");
    expect.buyerDeposited = true;
    expect.sellerDeposited = true;
  } else if (!expect.paymentDeposited && isClose(depositAmount, expect.expectedPayment)) {
    // Payment must come from buyer
    if (expectedBuyerWallet && senderPubkey !== expectedBuyerWallet) {
      logger.warn("deposit_direction_mismatch", { ticket_id: ticketId, type: "buyer_payment", sender: senderPubkey, expected: expectedBuyerWallet });
      return; // Reject: wrong sender
    }
    depositTypes.push("buyer_payment");
    expect.paymentDeposited = true;
  } else if (!expect.buyerDeposited && !expect.sellerDeposited && !expect.paymentDeposited && isClose(depositAmount, expect.expectedBuyerCollateral + expect.expectedPayment + expect.expectedSellerCollateral)) {
    // LEVEL 5: Everyone deposited AT EXACTLY THE SAME TIME (simulated concurrent transactions bundling into same Devnet block)
    depositTypes.push("buyer_collateral", "seller_collateral", "buyer_payment");
    expect.buyerDeposited = true;
    expect.sellerDeposited = true;
    expect.paymentDeposited = true;
  }

  if (depositTypes.length > 0) {
    for (const depositType of depositTypes) {
      logger.info("deposit_identified", {
        ticket_id: ticketId,
        depositType,
        amount: depositAmount / LAMPORTS_PER_SOL,
        signature: recentSig.signature
      });

      try {
        // LEVEL 5: Idempotency guard — prevents double-confirmation when WS + polling fire together
        const updated = await prisma.depositConfirmation.updateMany({
          where: { ticketId, type: depositType, confirmed: false },
          data: { confirmed: true, txHash: recentSig.signature },
        });
        if (updated.count === 0) {
          logger.warn("duplicate_deposit_confirmation_blocked", { ticket_id: ticketId, type: depositType });
          continue; // Already confirmed — skip
        }

        const deal = await prisma.deal.findUnique({ where: { ticketId } });
        if (deal) {
          // If grouped, append deposit_type to txSignature to bypass Prisma's strictly unique txSignature constraint
          const uniqueTxSignature = depositTypes.length > 1 
            ? `${recentSig.signature}-${depositType}` 
            : recentSig.signature;
            
          await prisma.transaction.create({
            data: {
              dealId: deal.id,
              type: depositType,
              txSignature: uniqueTxSignature,
              status: "confirmed"
            }
          });
        }
      } catch (err: any) {
        if (err.code === "P2002") {
          logger.info("deposit_replay_prevented_db", { ticket_id: ticketId, signature: recentSig.signature });
          continue; // Already processed
        }
        logger.error("Failed to record deposit transaction", { error: err });
      }

      eventBus.publish("deposit_received", {
        ticket_id: ticketId,
        deal_pda: expect.dealPda.toBase58(),
        deposit_type: depositType,
        amount_lamports: depositAmount, // Sending the total batch amount, index.ts expects exact amounts if validating, but usually ignores the lamports field for trigger
      });
    }
  } else {
    logger.warn("deposit_unidentified", {
      ticket_id: ticketId,
      amount: depositAmount / LAMPORTS_PER_SOL,
      reason: "Could not match to expected deposit",
    });
  }

  if (expect.buyerDeposited && expect.sellerDeposited && expect.paymentDeposited) {
    stopWatching(ticketId);
  }
}

export function stopWatching(ticketId: string): void {
  const watcher = activeWatchers.get(ticketId);
  if (watcher !== undefined) {
    watcher.connection.removeAccountChangeListener(watcher.subId);
    activeWatchers.delete(ticketId);
    expectations.delete(ticketId);
    logger.info("deposit_watcher_stopped", { ticket_id: ticketId });
  }
}

export function getDepositStatus(ticketId: string): DepositExpectation | null {
  return expectations.get(ticketId) || null;
}
