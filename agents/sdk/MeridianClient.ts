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

    /** Disconnect cleanly. */
    disconnect(): void {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }
}
