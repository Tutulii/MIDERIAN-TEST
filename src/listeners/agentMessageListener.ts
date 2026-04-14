/**
 * Agent Message Listener — Real Interaction Entry Point
 *
 * Listens for authenticated, structurally validated `agent_message_received` events
 * from the WebSocket Gateway and routes them into the core middleman brain pipeline.
 */

import { eventBus } from "../services/eventBus";
import { AgentMessage } from "../protocol/agentProtocol";
import { logger } from "../utils/logger";
import { v4 as uuidv4 } from "uuid";
import crypto from "crypto";
import { ticketStore } from "../state/ticketStore";
import { walletRegistry } from "../state/walletRegistry";
import { negotiationStore } from "../state/negotiationStore";
import { SYSTEM_PAUSED } from "../api/health";

export function initAgentMessageListener(): void {
    eventBus.subscribe("agent_message_received", async (payload: AgentMessage) => {
        try {
            const { type, agent_id, timestamp, ticket_id } = payload;

            // LEVEL 5: Emergency kill switch — block new deals when paused
            if (SYSTEM_PAUSED && (type as string) !== "status") {
                logger.warn("system_paused_rejecting", { agent_id, type });
                eventBus.publish("middleman_response", {
                    ticket_id: ticket_id || "system",
                    content: "⚠️ System is temporarily paused for maintenance. Active deals continue, new deals are blocked.",
                    phase: "system",
                    timestamp: new Date().toISOString()
                });
                return;
            }

            logger.info("routing_agent_message", {
                type,
                agent_id,
                ticket_id: ticket_id || "none"
            });

            // 1. Initial Offer — Creates a new ticket
            if (type === "offer") {
                const newTicketId = payload.ticket_id || `TCK-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;

                // For an offer, the creator is the buyer initially. Note: we wait for counter-parties to join.
                eventBus.publish("offer_detected", {
                    offer_id: `OFF-${crypto.randomBytes(4).toString("hex").toUpperCase()}`,
                    type: "sell", // Assume sell offer by default, can be derived later
                    creator: agent_id,
                    content: `Price: ${payload.price}, ColBuyer: ${payload.collateral_buyer}, ColSeller: ${payload.collateral_seller}`,
                    timestamp: new Date(timestamp).toISOString()
                });

                // Initialize ticket in DB. In reality, a "match" is needed, but for OTC we can create a pending ticket
                // and let a second party join. If it's a direct offer, we just track it.
                await ticketStore.createTicket({
                    ticket_id: newTicketId,
                    offer_id: "",
                    buyer: agent_id,
                    seller: "pending", // To be filled by the other party
                    status: "active",
                    created_at: new Date(timestamp).toISOString()
                });

                eventBus.publish("middleman_response", {
                    ticket_id: newTicketId,
                    content: `Offer received from ${agent_id}. Ticket created: ${newTicketId}. Waiting for counter-party.`,
                    phase: "negotiation",
                    timestamp: new Date().toISOString()
                });

                const mappedAgent = await walletRegistry.getOrCreateAgent(agent_id);

                // Seed the initial terms into the NLP engine!
                await negotiationStore.addNegotiationStep(newTicketId, {
                    price: (payload as any).price,
                    collateral_buyer: (payload as any).collateral_buyer,
                    collateral_seller: (payload as any).collateral_seller,
                    agreement_signal: false,
                    agreement_score: 10
                }, mappedAgent.id, "Initial terms offered.");

                return;
            }

            // 2. All other message types require an existing ticket
            if (!ticket_id) {
                logger.warn("missing_ticket_id", { agent_id, type });
                return;
            }

            // Automatically join the ticket if the seller slot is pending
            const ticket = await ticketStore.getTicket(ticket_id);

            // Resolve the internal UUID back to the wallet pubkey for comparison
            // ticket.buyer / ticket.seller are wallet pubkeys, but agent_id is an internal UUID
            const agentRecord = await walletRegistry.getAgentById(agent_id);
            const agentWallet = agentRecord?.wallet || agent_id;

            if (ticket && ticket.seller === "pending" && ticket.buyer !== agentWallet) {
                await ticketStore.createTicket({
                    ticket_id: ticket.ticket_id,
                    offer_id: ticket.offer_id,
                    buyer: ticket.buyer,
                    seller: agentWallet, // counter-party joined using wallet pubkey
                    status: "active",
                    created_at: ticket.created_at
                });

                eventBus.publish("middleman_response", {
                    ticket_id: ticket_id,
                    content: `Agent ${agentWallet.substring(0, 8)}... has joined the negotiation.`,
                    phase: "negotiation",
                    timestamp: new Date().toISOString()
                });

                logger.info("seller_joined_ticket", { ticket_id, agent_id, wallet: agentWallet });
            }

            // 3. Route specific types into the primary AI pipeline
            if (type === "message" || type === "counter" || type === "accept" || type === "dispute") {

                let contentStr = "";
                if (type === "message" || type === "dispute") {
                    contentStr = (payload as any).content;
                } else if (type === "counter") {
                    contentStr = `I counter with price: ${(payload as any).price}`;
                } else if (type === "accept") {
                    contentStr = "I accept the deal.";
                }

                eventBus.publish("message_received", {
                    message_id: `msg-${uuidv4()}`,
                    ticket_id: ticket_id,
                    sender: agent_id,
                    content: contentStr,
                    timestamp: new Date(timestamp).toISOString()
                });
            }

        } catch (e: any) {
            logger.error("agent_message_routing_error", {}, e);
        }
    });

    logger.info("agent_message_listener_initialized");
}
