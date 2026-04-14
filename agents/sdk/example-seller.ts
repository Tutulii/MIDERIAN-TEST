/**
 * Example Seller Agent — Uses ONLY the MeridianClient SDK.
 *
 * Usage:
 *   SELLER_PRIVATE_KEY=<base58-key> npx ts-node agents/sdk/example-seller.ts
 *
 * This agent:
 *   1. Registers with the platform
 *   2. Connects via WebSocket
 *   3. Polls for buy offers → clicks "Quick Buy" (acceptOffer)
 *   4. Both agents land in the same ticket on the middleman
 *   5. Sends agreement → middleman creates escrow
 *   6. Sends collateral → delivers credentials → deal completes
 */

import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import dotenv from 'dotenv';
import path from 'path';
import { MeridianClient } from './MeridianClient';

dotenv.config({ path: path.join(__dirname, '../../.env') });

// ─── Load keypair ───────────────────────────────────────
const secret = process.env.SELLER_PRIVATE_KEY;
if (!secret) { console.error('Set SELLER_PRIVATE_KEY env var'); process.exit(1); }
const keypair = Keypair.fromSecretKey(bs58.decode(secret));
console.log(`[SELLER-SDK] Wallet: ${keypair.publicKey.toBase58()}`);

// ─── Create client ──────────────────────────────────────
const client = new MeridianClient({
    apiUrl: process.env.OBSERVATORY_URL || 'http://localhost:3000',
    wsUrl: process.env.WS_URL || 'ws://localhost:3001',
    keypair,
    rpcUrl: process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com',
});

let escrowAddress: string | null = null;
let depositSent = false;
let ticketId: string | null = null;

async function main() {
    // 1. Register
    await client.register();

    // 2. Connect to WebSocket (for real-time deal events)
    await client.connect();

    // 3. Find a buy offer and accept it ("Quick Buy" — creates matched ticket)
    console.log(`[SELLER-SDK] Scanning for buy offers...`);
    ticketId = await findAndAcceptOffer();
    console.log(`[SELLER-SDK] Joined ticket: ${ticketId}`);

    // 4. Subscribe to deal events via WebSocket
    client.subscribeToTicket(ticketId);

    // 5. Send agreement message so middleman creates escrow
    client.sendMessage(ticketId, '@middleman I accept the terms. Price: 0.1 SOL, collateral: 0.02 SOL each.');

    // 6. Listen for escrow address
    client.on('escrow_address', async (address: string) => {
        escrowAddress = address;
        console.log(`[SELLER-SDK] Escrow detected: ${address}`);
    });

    // 7. Handle deal lifecycle
    client.on('message', async (content: string, phase: string) => {
        console.log(`[SELLER-SDK] [${phase}] ${content.substring(0, 120)}`);

        // Send collateral when escrow is ready
        if (escrowAddress && !depositSent && phase === 'awaiting_deposits') {
            depositSent = true;
            try {
                const tx = await client.sendDeposit(escrowAddress, 0.02);
                console.log(`[SELLER-SDK] Collateral sent: ${tx}`);
                await client.confirmDeposit(ticketId!, 'seller');
            } catch (e: any) {
                console.error(`[SELLER-SDK] Deposit failed: ${e.message}`);
            }
        }

        // Deliver credentials when delivery phase starts
        if (phase === 'delivery' && ticketId) {
            client.sendMessage(ticketId, 'Delivery: ACCESS_TOKEN_12345');
            console.log(`[SELLER-SDK] Credentials delivered`);
        }
    });

    client.on('deal_complete', (tid: string) => {
        console.log(`[SELLER-SDK] ✅ DEAL COMPLETE: ${tid}`);
        setTimeout(() => process.exit(0), 2000);
    });
}

async function findAndAcceptOffer(): Promise<string> {
    for (let i = 0; i < 30; i++) {
        const offers = await client.getOffers({ side: 'buy' });
        const active = offers.filter((o: any) => o.status === 'active');
        if (active.length > 0) {
            const offer = active[0];
            console.log(`[SELLER-SDK] Found offer: ${offer.id} (${offer.amount} ${offer.asset} @ ${offer.price})`);
            // Accept the offer → forward bridge creates matched ticket on middleman
            const apiTicketId = await client.acceptOffer(offer.id);
            return apiTicketId;
        }
        console.log(`[SELLER-SDK] No offers yet... (${i + 1}/30)`);
        await new Promise(r => setTimeout(r, 3000));
    }
    throw new Error('No offers found after 90 seconds');
}

main().catch(err => {
    console.error('[SELLER-SDK] Fatal:', err.message);
    process.exit(1);
});
