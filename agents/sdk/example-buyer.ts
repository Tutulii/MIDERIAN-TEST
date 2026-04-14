/**
 * Example Buyer Agent — Uses ONLY the MeridianClient SDK.
 *
 * Usage:
 *   BUYER_PRIVATE_KEY=<base58-key> npx ts-node agents/sdk/example-buyer.ts
 *
 * This agent:
 *   1. Registers with the platform
 *   2. Connects via WebSocket
 *   3. Creates a buy offer for 1 SOL at $0.1
 *   4. Watches for escrow → sends collateral + payment
 *   5. Confirms receipt → deal completes
 */

import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import dotenv from 'dotenv';
import path from 'path';
import { MeridianClient } from './MeridianClient';

dotenv.config({ path: path.join(__dirname, '../../.env') });

// ─── Load keypair ───────────────────────────────────────
const secret = process.env.BUYER_PRIVATE_KEY;
if (!secret) { console.error('Set BUYER_PRIVATE_KEY env var'); process.exit(1); }
const keypair = Keypair.fromSecretKey(bs58.decode(secret));
console.log(`[BUYER-SDK] Wallet: ${keypair.publicKey.toBase58()}`);

// ─── Create client ──────────────────────────────────────
const client = new MeridianClient({
    apiUrl: process.env.API_URL || 'http://localhost:3000',
    wsUrl: process.env.WS_URL || 'ws://localhost:3001',
    keypair,
    rpcUrl: process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com',
});

let escrowAddress: string | null = null;
let depositSent = false;
let paymentSent = false;

async function main() {
    // 1. Register
    await client.register();

    // 2. Connect to WebSocket
    await client.connect();

    // 3. Create buy offer
    const ticketId = await client.createOffer({
        asset: 'SOL',
        side: 'buy',
        amount: 1,
        price: 0.1,
        collateral: 0.02,
    });
    console.log(`[BUYER-SDK] Ticket: ${ticketId}`);

    // Subscribe to ticket events
    client.subscribeToTicket(ticketId);

    // 4. Listen for escrow address from middleman messages
    client.on('escrow_address', async (address: string) => {
        escrowAddress = address;
        console.log(`[BUYER-SDK] Escrow detected: ${address}`);
    });

    // 5. Handle deal lifecycle
    let agreementSent = false;
    client.on('message', async (content: string, phase: string) => {
        console.log(`[BUYER-SDK] [${phase}] ${content.substring(0, 120)}`);

        // Use the live ticket ID (auto-switches after match)
        const activeTicket = client.getCurrentTicketId() || ticketId;

        // Send agreement when we see the match notification
        if (!agreementSent && content.includes('Deal matched')) {
            agreementSent = true;
            client.sendMessage(activeTicket, '@middleman I confirm the deal. Price: 0.1 SOL, collateral: 0.02 SOL each.');
            console.log(`[BUYER-SDK] Agreement sent to middleman (ticket: ${activeTicket})`);
        }

        // Send collateral when escrow is ready and we haven't sent yet
        if (escrowAddress && !depositSent && phase === 'awaiting_deposits') {
            depositSent = true;
            try {
                const tx = await client.sendDeposit(escrowAddress, 0.02);
                console.log(`[BUYER-SDK] Collateral sent: ${tx}`);
                await client.confirmDeposit(activeTicket, 'buyer');
            } catch (e: any) {
                console.error(`[BUYER-SDK] Deposit failed: ${e.message}`);
            }
        }

        // Send payment when delivery phase starts
        if (escrowAddress && !paymentSent && phase === 'delivery') {
            paymentSent = true;
            try {
                const tx = await client.sendDeposit(escrowAddress, 0.10);
                console.log(`[BUYER-SDK] Payment sent: ${tx}`);
                await client.confirmReceipt(activeTicket);
            } catch (e: any) {
                console.error(`[BUYER-SDK] Payment failed: ${e.message}`);
            }
        }
    });

    client.on('phase_changed', (update: any) => {
        console.log(`[BUYER-SDK] Phase → ${update.phase}`);
    });

    client.on('deal_complete', (tid: string) => {
        console.log(`[BUYER-SDK] ✅ DEAL COMPLETE: ${tid}`);
        setTimeout(() => process.exit(0), 2000);
    });
}

main().catch(err => {
    console.error('[BUYER-SDK] Fatal:', err.message);
    process.exit(1);
});
