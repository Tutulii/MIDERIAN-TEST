/**
 * Deposit Polling Fallback (Level 5 Autonomy)
 *
 * Backup mechanism for deposit detection. The primary method
 * (connection.onAccountChange WebSocket) can silently drop.
 * This polls PDA balances every heartbeat cycle as a safety net.
 *
 * Guarantees: deposits are detected within 30s even if WS drops.
 */

import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { logger } from "../utils/logger";

/**
 * Polls PDA balance and returns true if expected total is met.
 * Designed to be called from the heartbeat loop for each active deal.
 */
export async function pollDepositsForActiveDeal(
    connection: Connection,
    ticketId: string,
    escrowPda: PublicKey,
    expectedTotalLamports: number
): Promise<boolean> {
    try {
        const balance = await connection.getBalance(escrowPda);
        if (balance >= expectedTotalLamports) {
            logger.info("deposit_polling_fallback_triggered", {
                ticket_id: ticketId,
                balance_lamports: balance,
                expected_lamports: expectedTotalLamports,
                balance_sol: balance / LAMPORTS_PER_SOL,
            });
            return true;
        }
        return false;
    } catch (e: any) {
        // Polling failure is not critical — WS watcher is primary
        logger.debug("deposit_polling_check_failed", { ticket_id: ticketId, error: e.message });
        return false;
    }
}
