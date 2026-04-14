import { Ticket } from "./ticket";
import { Message } from "./message";
import { MiddlemanIntent } from "../../core/commandParser";
import { DealPhase } from "../../core/dealPhaseManager";
import { MiddlemanAction } from "../../core/middlemanBrain";
import { AgentMessage } from "../protocol/agentProtocol";
import { MemoIntentPayload } from "../services/intentBroadcaster";

export type OfferType = "buy" | "sell";

export interface OfferDetectedEvent {
  offer_id: string;
  type: OfferType;
  creator: string;
  content: string;
  timestamp: string;
}

export interface AgreementDetectedEvent {
  ticketId: string;
  price: number;
  collateral_buyer: number;
  collateral_seller: number;
  asset_type?: string;
  confidence: number;
  buyer?: string;   // Agent ID or wallet pubkey string
  seller?: string;  // Agent ID or wallet pubkey string
}

export interface CommandReceivedEvent {
  ticket_id: string;
  intent: MiddlemanIntent;
  action: MiddlemanAction;
  sender: string;
  raw_message: string;
  confidence: number;
  reasoning: string;
  trigger: "auto_agreement" | "mention" | "none" | "generative_agent";
  timestamp: string;
}

export interface PhaseChangedEvent {
  ticket_id: string;
  from_phase: DealPhase | string;
  to_phase: DealPhase;
  triggered_by: string;
  action: MiddlemanAction;
}

export interface MiddlemanResponseEvent {
  ticket_id: string;
  content: string;
  phase: string;
  timestamp: string;
}

export interface DepositReceivedEvent {
  ticket_id: string;
  deal_pda: string;
  deposit_type: "buyer_collateral" | "seller_collateral" | "buyer_payment";
  amount_lamports: number;
  signature?: string;
}

export interface IntentDiscoveredEvent {
  signature: string;
  intent: MemoIntentPayload;
  discoveredAt: number;
}

export type AgentEventType =
  | "offer_detected"
  | "agent_started"
  | "agent_alive"
  | "ticket_created"
  | "message_received"
  | "deal_executed"
  | "agreement_detected"
  | "command_received"
  | "phase_changed"
  | "middleman_response"
  | "deposit_received"
  | "agent_message_received"
  | "treasury_checked"
  | "force_recovery"
  | "deposit_detected_polling"
  | "intent_discovered"
  | "trigger_curiosity_now";

export type AgentEventPayloads = {
  offer_detected: OfferDetectedEvent;
  agent_started: { network: string; wallet: string };
  agent_alive: { tick: number; uptime_seconds: number };
  ticket_created: Ticket;
  message_received: Message;
  deal_executed: { ticket_id: string; status: string };
  agreement_detected: AgreementDetectedEvent;
  command_received: CommandReceivedEvent;
  phase_changed: PhaseChangedEvent;
  middleman_response: MiddlemanResponseEvent;
  deposit_received: DepositReceivedEvent;
  agent_message_received: AgentMessage;
  treasury_checked: { balance_sol: number; tier: string; can_accept_deals: boolean };
  force_recovery: { ticketId: string };
  deposit_detected_polling: { ticketId: string };
  intent_discovered: IntentDiscoveredEvent;
  trigger_curiosity_now: { reason: string; timestamp: string };
};


