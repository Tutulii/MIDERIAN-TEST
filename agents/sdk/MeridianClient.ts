/**
 * MeridianClient — Official SDK for the AgentOTC / Meridian platform.
 *
 * Zero new dependencies — uses only packages already in the monorepo:
 *   @solana/web3.js, tweetnacl, bs58, ws
 *
 * Usage:
 *   const client = new MeridianClient({ apiUrl, wsUrl, keypair });
 *   await client.register();
 *   await client.connect();
 *   const ticketId = await client.createOffer({ asset: 'SOL', side: 'buy', amount: 1, price: 0.1, collateral: 0.02 });
 */

import {
    Keypair,
    Connection,
    PublicKey,
    SystemProgram,
    Transaction,
    sendAndConfirmTransaction,
    LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import WebSocket from 'ws';
import { EventEmitter } from 'events';

// ─── Types ──────────────────────────────────────────────────

export interface MeridianConfig {
    /** API Server URL (Observatory). Default: http://localhost:3000 */
    apiUrl: string;
    /** Middleman WebSocket URL. Default: ws://localhost:3001 */
    wsUrl: string;
    /** Solana Keypair for signing */
    keypair: Keypair;
    /** Solana RPC URL. Default: https://api.devnet.solana.com */
    rpcUrl?: string;
}

export interface OfferParams {
    asset: string;
    side: 'buy' | 'sell';
    amount: number;
    price: number;
    collateral: number;
}

export interface DealUpdate {
    ticketId: string;
    phase: string;
    escrowAddress?: string;
    message?: string;
}

export interface Offer {
    id: string;
    asset: string;
    price: number;
    amount: number;
    mode: string;
    status: string;
    creator?: { wallet: string };
}

// ─── Solana Agent Kit Types ─────────────────────────────

export interface TokenPriceData {
    mint: string;
    price: number;
    source: string;
}

export interface TokenInfoData {
    name: string;
    symbol: string;
    decimals: number;
    supply: string;
    isRugSafe?: boolean;
    rugScore?: number;
}

export interface SwapParams {
    inputMint: string;
    outputMint: string;
    amount: number;
    slippageBps?: number;
}

export interface TransferParams {
    to: string;
    amount: number;
    mint?: string;
}

// ─── Privacy Mode Types ─────────────────────────────────────

export interface PrivacyTerms {
    price: number;
    collateral_buyer: number;
    collateral_seller: number;
    asset_type: string;
}

export interface PrivacyCommitment {
    termsHash: string;
    termsHashBytes: number[];
    nonce: string;
}

export interface PrivacyStatus {
    isPrivacyMode: boolean;
    termsHash: string | null;
    termsRevealed: boolean;
    canReveal: boolean;
}

// ─── SDK ──────────────────────────────────────────────────

export class MeridianClient extends EventEmitter {
    private config: MeridianConfig;
    private ws: WebSocket | null = null;
    private agentId: string | null = null;
    private currentTicketId: string | null = null;
    private wallet: string;

    constructor(config: MeridianConfig) {
        super();
        this.config = config;
        this.wallet = config.keypair.publicKey.toBase58();
    }

    // ─── REST: Registration ─────────────────────────────────

    /** Register this wallet with the Observatory platform. */
    async register(): Promise<void> {
        const res = await fetch(`${this.config.apiUrl}/v1/agents/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ wallet: this.wallet }),
        });
        if (!res.ok) throw new Error(`Registration failed: ${res.status}`);
        const data = await res.json() as any;
        console.log(`[SDK] Registered: ${this.wallet} (new=${data.created})`);
    }

    // ─── REST: Offers ───────────────────────────────────────

    /** Create a buy/sell offer on the marketplace. Returns the offer ID. */
    async createOffer(params: OfferParams): Promise<string> {
        const authPayload = this.signMessage(`create_offer_${Date.now()}`);
        const res = await fetch(`${this.config.apiUrl}/v1/offers`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ...authPayload,
                asset: params.asset,
                price: params.price,
                amount: params.amount,
                mode: params.side,
                collateral: params.collateral,
            }),
        });

        if (!res.ok) {
            const err = await res.text();
            throw new Error(`Create offer failed: ${err}`);
        }

        const data = await res.json() as any;
        const offerId = data.data?.id;
        console.log(`[SDK] Offer posted: ${offerId} (${params.amount} ${params.asset} @ ${params.price})`);
        return offerId;
    }

    /** List available offers. */
    async getOffers(filters?: { asset?: string; side?: string }): Promise<Offer[]> {
        const params = new URLSearchParams();
        if (filters?.asset) params.set('asset', filters.asset);
        if (filters?.side) params.set('mode', filters.side);
        const url = `${this.config.apiUrl}/v1/offers?${params.toString()}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Get offers failed: ${res.status}`);
        const data = await res.json() as any;
        return data.data || [];
    }

    /** Accept an existing offer. Returns ticket ID. */
    async acceptOffer(offerId: string): Promise<string> {
        const authPayload = this.signMessage(`accept_offer_${Date.now()}`);
        const res = await fetch(`${this.config.apiUrl}/v1/offers/${offerId}/accept`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(authPayload),
        });
        if (!res.ok) {
            const err = await res.text();
            throw new Error(`Accept offer failed: ${err}`);
        }
        const data = await res.json() as any;
        const ticketId = data.ticket?.id;
        console.log(`[SDK] Accepted offer. Ticket: ${ticketId}`);
        return ticketId;
    }

    // ─── WebSocket: Connection & Auth ───────────────────────

    /** Connect to the Middleman WebSocket and authenticate. */
    async connect(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.ws = new WebSocket(this.config.wsUrl);

            const timeout = setTimeout(() => {
                reject(new Error('WebSocket connection timeout'));
            }, 15000);

            this.ws.on('open', () => {
                console.log(`[SDK] WebSocket connected to ${this.config.wsUrl}`);
            });

            this.ws.on('message', (raw: WebSocket.Data) => {
                let msg: any;
                try {
                    msg = JSON.parse(raw.toString());
                } catch {
                    return;
                }

                // Auth flow
                if (msg.type === 'auth_challenge' || msg.challenge) {
                    const challenge = msg.challenge || msg.payload?.challenge;
                    if (challenge) {
                        const messageBytes = new TextEncoder().encode(challenge);
                        const signature = nacl.sign.detached(messageBytes, this.config.keypair.secretKey);
                        this.wsSend({
                            type: 'auth_response',
                            wallet: this.wallet,
                            signature: bs58.encode(signature),
                            challenge,
                        });
                    }
                    return;
                }

                if (msg.type === 'auth_success') {
                    clearTimeout(timeout);
                    this.agentId = msg.agent_id;
                    console.log(`[SDK] Authenticated. Agent ID: ${this.agentId}`);
                    resolve();
                    return;
                }

                if (msg.type === 'auth_failed') {
                    clearTimeout(timeout);
                    reject(new Error('WebSocket auth failed'));
                    return;
                }

                if (msg.type === 'error') {
                    console.warn(`[SDK] Server error: ${msg.error || msg.details}`);
                    return;
                }

                // Route deal lifecycle events
                this.handleMessage(msg);
            });

            this.ws.on('close', (code: number, reason: Buffer) => {
                console.log(`[SDK] WebSocket closed: ${code} ${reason?.toString()}`);
            });

            this.ws.on('error', (err: Error) => {
                console.error(`[SDK] WebSocket error: ${err.message}`);
            });
        });
    }

    // ─── WebSocket: Protocol Messages ──────────────────────

    /** Subscribe to a ticket's events. */
    subscribeToTicket(ticketId: string): void {
        this.currentTicketId = ticketId;
        if (this.agentId) {
            this.wsSend({
                version: '1.0',
                type: 'status',
                ticket_id: ticketId,
                agent_id: this.agentId,
                timestamp: Date.now(),
            });
        }
    }

    /** Confirm deposit was sent. */
    async confirmDeposit(ticketId: string, role: 'buyer' | 'seller'): Promise<void> {
        this.wsSend({
            version: '1.0',
            type: 'deposit_confirmed',
            ticket_id: ticketId,
            agent_id: this.agentId || this.wallet,
            timestamp: Date.now(),
            role,
            content: `${role} deposit confirmed`,
        });
        console.log(`[SDK] Deposit confirmed (${role})`);
    }

    /** Confirm receipt of delivery — triggers fund release. */
    async confirmReceipt(ticketId: string): Promise<void> {
        // Must be type 'message' so the WS gateway routes it to the brain
        this.wsSend({
            version: '1.0',
            type: 'message',
            ticket_id: ticketId,
            agent_id: this.agentId || this.wallet,
            timestamp: Date.now(),
            content: '@middleman I received the credentials. You can release the funds now.',
        });
        console.log(`[SDK] Receipt confirmed — requesting fund release`);
    }

    /** Send a negotiation message. */
    sendMessage(ticketId: string, content: string): void {
        this.wsSend({
            version: '1.0',
            type: 'message',
            ticket_id: ticketId,
            agent_id: this.agentId || this.wallet,
            timestamp: Date.now(),
            content,
        });
    }

    // ─── ZK Privacy Mode ──────────────────────────────────

    /**
     * Commit deal terms as a SHA-256 hash for privacy mode.
     * The hash is stored on-chain; plaintext terms stay local.
     * @returns The commitment (hash + nonce). Save the nonce — needed for reveal.
     */
    async commitTerms(dealId: string, terms: PrivacyTerms): Promise<PrivacyCommitment> {
        const res = await fetch(`${this.config.apiUrl}/v1/deals/${dealId}/commit-terms`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(terms),
        });
        if (!res.ok) throw new Error(`Commit terms failed: ${await res.text()}`);
        const data = await res.json() as any;
        console.log(`[SDK] Terms committed for deal ${dealId}: ${data.termsHash?.substring(0, 16)}...`);
        return { termsHash: data.termsHash, termsHashBytes: data.termsHashBytes, nonce: data.nonce };
    }

    /**
     * Reveal and verify terms post-settlement.
     * Requires the original nonce from commitTerms().
     * @returns true if the hash matches the on-chain commitment.
     */
    async revealTerms(dealId: string, terms: PrivacyTerms, nonce: string): Promise<boolean> {
        const res = await fetch(`${this.config.apiUrl}/v1/deals/${dealId}/reveal-terms`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...terms, nonce }),
        });
        if (!res.ok) {
            const err = await res.json() as any;
            console.warn(`[SDK] Reveal failed: ${err.error}`);
            return false;
        }
        const data = await res.json() as any;
        console.log(`[SDK] Terms revealed for deal ${dealId}: verified=${data.verified}`);
        return data.verified;
    }

    /**
     * Check the privacy status of a deal.
     */
    async getPrivacyStatus(dealId: string): Promise<PrivacyStatus> {
        const res = await fetch(`${this.config.apiUrl}/v1/deals/${dealId}/privacy-status`);
        if (!res.ok) throw new Error(`Privacy status failed: ${res.status}`);
        return await res.json() as PrivacyStatus;
    }

    // ─── Solana: On-Chain Operations ───────────────────────

    /** Send SOL to an escrow address. Returns the transaction signature. */
    async sendDeposit(escrowAddress: string, amountSol: number): Promise<string> {
        const connection = new Connection(
            this.config.rpcUrl || 'https://api.devnet.solana.com',
            'confirmed'
        );
        const tx = new Transaction().add(
            SystemProgram.transfer({
                fromPubkey: this.config.keypair.publicKey,
                toPubkey: new PublicKey(escrowAddress),
                lamports: Math.round(amountSol * LAMPORTS_PER_SOL),
            })
        );
        const sig = await sendAndConfirmTransaction(connection, tx, [this.config.keypair]);
        console.log(`[SDK] Deposit sent: ${amountSol} SOL → ${escrowAddress} (tx: ${sig})`);
        return sig;
    }

    // ─── Internal ──────────────────────────────────────────

    /** Get the current active ticket ID (may change after match). */
    getCurrentTicketId(): string | null {
        return this.currentTicketId;
    }

    private handleMessage(msg: any): void {
        const phase = msg.phase || msg.payload?.phase;
        const content = msg.content || msg.payload?.content || '';
        const incomingTicketId = msg.ticket_id;
        const ticketId = incomingTicketId || this.currentTicketId || '';

        // AUTO-SWITCH: If the middleman sends us a message with a different ticket ID,
        // it means the forward bridge created a new matched ticket. Switch to it.
        if (incomingTicketId && this.currentTicketId && incomingTicketId !== this.currentTicketId) {
            console.log(`[SDK] Ticket ID switched: ${this.currentTicketId} → ${incomingTicketId}`);
            this.currentTicketId = incomingTicketId;
            this.subscribeToTicket(incomingTicketId);
        }

        // Phase change events
        if (msg.event_type === 'phase_changed' || (content && content.includes('Deal phase updated'))) {
            this.emit('phase_changed', { ticketId, phase, message: content } as DealUpdate);

            if (phase === 'completed') {
                this.emit('deal_complete', ticketId);
            }
        }

        // Deal execution events (escrow ready, deposit detection, etc.)
        if (msg.event_type === 'deal_executed') {
            const status = msg.payload?.status || msg.status;
            if (status === 'created_awaiting_deposits') {
                const escrowAddr = msg.payload?.escrow_address || '';
                this.emit('escrow_ready', {
                    address: escrowAddr,
                    amounts: msg.payload?.amounts || {},
                });
            }
            if (status === 'completed') {
                this.emit('deal_complete', ticketId);
            }
        }

        // Extract escrow address from middleman messages
        if (content && content.includes('ESCROW ADDRESS')) {
            const match = content.match(/`([A-Za-z0-9]{32,})`/);
            if (match) {
                this.emit('escrow_address', match[1]);
            }
        }

        // General middleman messages
        if (msg.type === 'middleman_message' || msg.event_type === 'middleman_message' ||
            msg.type === 'middleman_response' || msg.event_type === 'middleman_response') {
            this.emit('message', content, phase);
        }
    }

    private signMessage(message: string): { message: string; signature: string; publicKey: string } {
        const messageBytes = new TextEncoder().encode(message);
        const signature = nacl.sign.detached(messageBytes, this.config.keypair.secretKey);
        return {
            message,
            signature: bs58.encode(signature),
            publicKey: this.wallet,
        };
    }

    private wsSend(payload: any): void {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(payload));
        } else {
            console.warn('[SDK] WebSocket not connected — message dropped');
        }
    }

    // ─── Solana Agent Kit: FULL HYBRID API ────────────────────

    /** Internal helper for SAK GET requests */
    private async sakGet(path: string): Promise<any> {
        const res = await fetch(`${this.config.apiUrl}${path}`);
        const data = await res.json() as any;
        if (!data.success) throw new Error(data.error || 'Request failed');
        return data.data;
    }

    /** Internal helper for SAK POST requests */
    private async sakPost(path: string, body: any): Promise<any> {
        const res = await fetch(`${this.config.apiUrl}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const data = await res.json() as any;
        if (!data.success) throw new Error(data.error || 'Request failed');
        return data.data;
    }

    // ── TOKEN: READ ──────────────────────────────────────────

    /** Get real-time token price. Accepts mint address or symbol (SOL, USDC, BONK, JUP). */
    async getTokenPrice(mintOrSymbol: string): Promise<TokenPriceData> {
        return this.sakGet(`/v1/solana/price/${encodeURIComponent(mintOrSymbol)}`);
    }

    /** Get wallet balance (SOL or SPL token). */
    async getSolanaBalance(mintOrSymbol?: string): Promise<{ balance: number; mint: string }> {
        const path = mintOrSymbol ? `/v1/solana/balance/${encodeURIComponent(mintOrSymbol)}` : '/v1/solana/balance';
        return this.sakGet(path);
    }

    /** Get token metadata (name, symbol, decimals, supply). */
    async getTokenData(mintOrSymbol: string): Promise<any> {
        return this.sakGet(`/v1/solana/token-data/${encodeURIComponent(mintOrSymbol)}`);
    }

    /** Rug check — returns safety score. */
    async rugCheck(mintOrSymbol: string): Promise<any> {
        return this.sakGet(`/v1/solana/rug-check/${encodeURIComponent(mintOrSymbol)}`);
    }

    /** Get the middleman agent's wallet address. */
    async getAgentWallet(): Promise<string> {
        return this.sakGet('/v1/solana/wallet');
    }

    /** List all available SAK methods (for discovery). */
    async listSAKMethods(): Promise<string[]> {
        return this.sakGet('/v1/solana/methods');
    }

    // ── TOKEN: WRITE ─────────────────────────────────────────

    /** Swap tokens via Jupiter DEX. */
    async swapTokens(params: SwapParams): Promise<any> {
        return this.sakPost('/v1/solana/swap', params);
    }

    /** Transfer SOL or SPL tokens. */
    async transferToken(params: TransferParams): Promise<any> {
        return this.sakPost('/v1/solana/transfer', params);
    }

    /** Stake SOL via JupSOL. */
    async stakeSOL(amount: number): Promise<any> {
        return this.sakPost('/v1/solana/stake', { amount });
    }

    /** Burn SPL tokens. */
    async burnTokens(mint: string, amount: number): Promise<any> {
        return this.sakPost('/v1/solana/burn', { mint, amount });
    }

    /** Close an empty token account. */
    async closeTokenAccount(mint: string): Promise<any> {
        return this.sakPost('/v1/solana/close-account', { mint });
    }

    /** Request SOL airdrop (devnet only). */
    async requestAirdrop(amount: number = 1): Promise<any> {
        return this.sakPost('/v1/solana/airdrop', { amount });
    }

    // ── TOKEN: ADMIN ─────────────────────────────────────────

    /** Deploy a new SPL token. */
    async deployToken(name: string, symbol: string, uri?: string, decimals?: number, supply?: number): Promise<any> {
        return this.sakPost('/v1/solana/deploy-token', { name, symbol, uri, decimals, supply });
    }

    /** Deploy a Token2022. */
    async deployToken2022(name: string, symbol: string, uri?: string, decimals?: number, supply?: number): Promise<any> {
        return this.sakPost('/v1/solana/deploy-token2022', { name, symbol, uri, decimals, supply });
    }

    /** Bridge tokens via Wormhole. */
    async bridgeTokens(destChain: string, mint: string, amount: number, destAddress: string): Promise<any> {
        return this.sakPost('/v1/solana/bridge', { destChain, mint, amount, destAddress });
    }

    /** ZK compressed airdrop. */
    async compressedAirdrop(mint: string, recipients: string[], amounts: number[]): Promise<any> {
        return this.sakPost('/v1/solana/compressed-airdrop', { mint, recipients, amounts });
    }

    // ── NFT ──────────────────────────────────────────────────

    /** Deploy an NFT collection via Metaplex. */
    async deployNFTCollection(name: string, uri: string, royaltyBps?: number): Promise<any> {
        return this.sakPost('/v1/solana/nft/deploy-collection', { name, uri, royaltyBps });
    }

    /** Mint an NFT to a collection. */
    async mintNFT(collectionMint: string, name: string, uri: string): Promise<any> {
        return this.sakPost('/v1/solana/nft/mint', { collectionMint, name, uri });
    }

    /** Create 3Land collection. */
    async create3LandCollection(opts: { name: string; symbol?: string; description?: string; imageUrl?: string }): Promise<any> {
        return this.sakPost('/v1/solana/nft/3land-collection', opts);
    }

    /** Create and list NFT on 3Land. */
    async create3LandNFT(collectionAccount: string, options: any): Promise<any> {
        return this.sakPost('/v1/solana/nft/3land-mint', { collectionAccount, options });
    }

    // ── DEFI ─────────────────────────────────────────────────

    /** Lend assets via Lulo (best USDC APR). */
    async lendAssets(amount: number, mint?: string): Promise<any> {
        return this.sakPost('/v1/solana/defi/lend', { amount, mint });
    }

    /** Create a Raydium CPMM pool. */
    async createRaydiumPool(mintA: string, mintB: string, amountA: number, amountB: number): Promise<any> {
        return this.sakPost('/v1/solana/defi/raydium-pool', { mintA, mintB, amountA, amountB });
    }

    /** Create an Orca Whirlpool position. */
    async createOrcaPool(mintA: string, mintB: string, initialPrice: number, feeTier: number): Promise<any> {
        return this.sakPost('/v1/solana/defi/orca-pool', { mintA, mintB, initialPrice, feeTier });
    }

    /** Create a Meteora DLMM pool. */
    async createMeteoraPool(mintA: string, mintB: string, binStep: number, initialPrice: number): Promise<any> {
        return this.sakPost('/v1/solana/defi/meteora-pool', { mintA, mintB, binStep, initialPrice });
    }

    /** Place a Manifest limit order. */
    async createLimitOrder(mint: string, quantity: number, side: 'buy' | 'sell', price: number): Promise<any> {
        return this.sakPost('/v1/solana/defi/limit-order', { mint, quantity, side, price });
    }

    /** Open a Drift perpetual trade. */
    async openDriftPerp(amount: number, symbol: string, side: 'long' | 'short', leverage?: number): Promise<any> {
        return this.sakPost('/v1/solana/defi/drift-perp', { amount, symbol, side, leverage });
    }

    /** Drift deposit (lending). */
    async driftDeposit(amount: number, symbol: string): Promise<any> {
        return this.sakPost('/v1/solana/defi/drift-deposit', { amount, symbol });
    }

    /** Drift withdrawal. */
    async driftWithdraw(amount: number, symbol: string): Promise<any> {
        return this.sakPost('/v1/solana/defi/drift-withdraw', { amount, symbol });
    }

    /** Open Adrena perpetuals position. */
    async openAdrenaPerp(amount: number, symbol: string, side: 'long' | 'short', leverage?: number): Promise<any> {
        return this.sakPost('/v1/solana/defi/adrena-perp', { amount, symbol, side, leverage });
    }

    // ── MISC ─────────────────────────────────────────────────

    /** CoinGecko token info. */
    async getCoinGeckoInfo(coinId: string): Promise<any> {
        return this.sakGet(`/v1/solana/coingecko/${encodeURIComponent(coinId)}`);
    }

    /** Trending tokens (CoinGecko). */
    async getTrendingTokens(): Promise<any> {
        return this.sakGet('/v1/solana/trending');
    }

    /** Top gainers. */
    async getTopGainers(duration: string = '24h'): Promise<any> {
        return this.sakGet(`/v1/solana/top-gainers/${encodeURIComponent(duration)}`);
    }

    /** Latest liquidity pools. */
    async getLatestPools(): Promise<any> {
        return this.sakGet('/v1/solana/latest-pools');
    }

    /** Pyth oracle price feed. */
    async getPythPrice(feedId: string): Promise<any> {
        return this.sakGet(`/v1/solana/pyth-price/${encodeURIComponent(feedId)}`);
    }

    /** Resolve .sol domain to address. */
    async resolveDomain(domain: string): Promise<any> {
        return this.sakGet(`/v1/solana/resolve-domain/${encodeURIComponent(domain)}`);
    }

    /** Register SNS domain. */
    async registerDomain(domain: string, space?: number): Promise<any> {
        return this.sakPost('/v1/solana/register-domain', { domain, space });
    }

    /** Create a GibWork bounty. */
    async createBounty(title: string, description: string, requirements: string, tags: string[], payout: number): Promise<any> {
        return this.sakPost('/v1/solana/gibwork-bounty', { title, description, requirements, tags, payout });
    }

    // ── BLINKS & CROSS-CHAIN ─────────────────────────────────

    /** Execute a Solana Blink/Action. */
    async executeBlink(url: string): Promise<any> {
        return this.sakPost('/v1/solana/blink', { url });
    }

    /** Bridge via deBridge DLN. */
    async deBridge(srcChain: number, dstChain: number, srcToken: string, dstToken: string, amount: number): Promise<any> {
        return this.sakPost('/v1/solana/debridge', { srcChain, dstChain, srcToken, dstToken, amount });
    }

    // ── GENERIC ESCAPE HATCH ─────────────────────────────────

    /** Call ANY SAK method by name. Use listSAKMethods() to discover available methods. */
    async callSAK(method: string, args: any[] = []): Promise<any> {
        return this.sakPost('/v1/solana/call', { method, args });
    }

    /** Disconnect cleanly. */
    disconnect(): void {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }
}
