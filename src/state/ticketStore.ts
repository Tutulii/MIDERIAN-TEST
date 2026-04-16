import { prisma } from "../lib/prisma";
import { walletRegistry } from "./walletRegistry";
import { Ticket as TicketInterface, TicketStatus } from "../types/ticket";
import { logger } from "../utils/logger";

class TicketStore {
  public async createTicket(ticket: TicketInterface): Promise<void> {
    logger.debug("ticket_store_creating", { ticket_id: ticket.ticket_id });

    // Upsert Buyer
    const buyerAgent = await prisma.agent.upsert({
      where: { wallet: ticket.buyer },
      update: {},
      create: { wallet: ticket.buyer }
    });

    // Upsert Seller
    const sellerAgent = await prisma.agent.upsert({
      where: { wallet: ticket.seller },
      update: {},
      create: { wallet: ticket.seller }
    });

    // Create Ticket row
    await prisma.ticket.upsert({
      where: { id: ticket.ticket_id },
      update: {
        status: ticket.status,
        sellerId: sellerAgent.id,  // Update seller when counter-party joins
      },
      create: {
        id: ticket.ticket_id,
        buyerId: buyerAgent.id,
        sellerId: sellerAgent.id,
        tokenMint: ticket.tokenMint,
        decimals: ticket.decimals,
        status: ticket.status
      }
    });
  }

  public async getTicket(ticket_id: string): Promise<TicketInterface | undefined> {
    const dbTicket = await prisma.ticket.findUnique({
      where: { id: ticket_id },
      include: {
        buyer: true,
        seller: true
      }
    });

    if (!dbTicket) return undefined;

    return {
      ticket_id: dbTicket.id,
      offer_id: "", // Not persisted in new schema
      buyer: dbTicket.buyer.wallet,
      seller: dbTicket.seller.wallet,
      status: dbTicket.status as TicketStatus,
      tokenMint: dbTicket.tokenMint ?? undefined,
      decimals: dbTicket.decimals ?? undefined,
      created_at: dbTicket.createdAt.toISOString()
    };
  }

  public async listTickets(): Promise<TicketInterface[]> {
    const dbTickets = await prisma.ticket.findMany({
      include: {
        buyer: true,
        seller: true
      }
    });

    return dbTickets.map(t => ({
      ticket_id: t.id,
      offer_id: "",
      buyer: t.buyer.wallet,
      seller: t.seller.wallet,
      status: t.status as TicketStatus,
      created_at: t.createdAt.toISOString()
    }));
  }
}

export const ticketStore = new TicketStore();
