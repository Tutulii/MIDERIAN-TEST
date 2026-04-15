/**
 * E2E Test Runner: Buyer + Seller vs Railway-hosted Middleman
 * 
 * Usage:
 *   npx ts-node agents/runTest.ts
 * 
 * Required env vars in .env:
 *   RAILWAY_URL=https://your-app.up.railway.app   (the Railway public domain)
 *   BUYER_PRIVATE_KEY=...
 *   SELLER_PRIVATE_KEY=...
 *   SOLANA_RPC_URL=...
 */

import path from 'path';
import dotenv from 'dotenv';
dotenv.config({ path: path.join(__dirname, '../.env') });

const RAILWAY_URL = process.env.RAILWAY_URL;

if (!RAILWAY_URL) {
    console.error('❌ Set RAILWAY_URL in .env (e.g. https://your-app.up.railway.app)');
    process.exit(1);
}

// Convert HTTPS URL to WSS for WebSocket
const WS_URL = RAILWAY_URL.replace(/^https?/, 'wss');
const API_URL = RAILWAY_URL;

// Inject into environment BEFORE agents load
process.env.API_URL = API_URL;
process.env.WS_URL = WS_URL;

console.log('═══════════════════════════════════════════');
console.log('  Meridian OTC — E2E Agent Test');
console.log('═══════════════════════════════════════════');
console.log(`  API → ${API_URL}`);
console.log(`  WS  → ${WS_URL}`);
console.log('═══════════════════════════════════════════');
console.log('');

// Start Seller first (it listens for Memo intents)
console.log('[TEST] Starting Seller Agent...');
import('./sellerAgent').then(() => {
    console.log('[TEST] Seller Agent started.');
    
    // Give seller 3s to connect and subscribe, then start buyer
    setTimeout(() => {
        console.log('[TEST] Starting Buyer Agent...');
        import('./buyerAgent').then(() => {
            console.log('[TEST] Buyer Agent started.');
            console.log('[TEST] Waiting for autonomous negotiation...');
        });
    }, 3000);
});
