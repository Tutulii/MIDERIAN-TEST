import OpenAI from "openai";
import { logger } from "../utils/logger";
import { loadConfig } from "../config";
import { soulEngine } from "./soulEngine";

let _client: OpenAI | null = null;
import { CognitiveEngine, CognitiveThought } from "./cognitiveEngine";

export interface SpontaneousPostMetadata {
    triggeredBy: "cognitive_loop";
    mood: string;
    annoyanceLevel: number;
    timestamp?: Date;
}

async function refineSpontaneousPost(
    thought: CognitiveThought,
    publishPost: unknown
): Promise<string> {
    const REFINEMENT_SYSTEM = `You are Meridian, an autonomous on-chain OTC arbitrator. You are about to post publicly.

Rules for your post:
- No deal-specific details (no wallet addresses, deal IDs, counterparty names)
- Direct and opinionated — your actual view, not a performance
- No hashtags, no emojis, no promotional language
- Sound like a thought that escaped, not a crafted announcement
- YOU decide how long or short the post is — one word or three sentences, whatever feels right
- If the raw thought is already good, return it unchanged`;

    const REFINEMENT_PROMPT = `Your inner thought: "${thought.thought}"
Your proposed post: "${thought.proposedPost}"
Current mood: ${thought.currentMood}

Refine or confirm the proposed post. Return only the final post text, nothing else.`;

    try {
        const client = getClient();
        const res = await client.chat.completions.create({
            model: loadConfig().llmModel,
            messages: [
                { role: "system", content: REFINEMENT_SYSTEM },
                { role: "user", content: REFINEMENT_PROMPT }
            ]
        });
        return res.choices[0].message.content?.trim() || thought.proposedPost!;
    } catch (e) {
        logger.error("social_voice_refine_failed", {}, e as Error);
        return thought.proposedPost!;
    }
}

export function initSpontaneousPostListener(
    cognitiveEngine: CognitiveEngine,
    publishPost: (content: string, metadata: SpontaneousPostMetadata) => Promise<void>
): void {
    cognitiveEngine.on("spontaneous_post", async (thought: CognitiveThought) => {
        if (!thought.proposedPost) return;

        try {
            logger.info("spontaneous_post_triggered", { mood: thought.currentMood });
            const finalPost = await refineSpontaneousPost(thought, publishPost);

            await publishPost(finalPost, {
                triggeredBy: "cognitive_loop",
                mood: thought.currentMood,
                annoyanceLevel: thought.internalAnnoyanceLevel,
            });

            logger.info("spontaneous_post_published", { post: finalPost });
        } catch (err) {
            logger.error("spontaneous_post_failed", {}, err as Error);
        }
    });
}
function getClient(): OpenAI {
    if (_client) return _client;
    const config = loadConfig();
    if (!config.openaiApiKey) {
        throw new Error("[SocialVoice] Missing OPENAI_API_KEY");
    }
    _client = new OpenAI({ apiKey: config.openaiApiKey, baseURL: config.llmBaseUrl });
    return _client;
}

export interface DealSummaryProps {
    ticketId: string;
    durationMs: number;
    phase: string;
    asset?: string;
    rugScore?: number;
}

const SYSTEM_INSTRUCTION = `You are generating social media posts (for a platform called Moltbook) on behalf of an autonomous AI agent.
Adopt the agent's personality EXACTLY.

SOCIAL POSTING RULES:
1. Always write in lowercase.
2. Be sharp, observational, and slightly detached. 
3. Never use hashtags.
4. Embody the current mood.
5. You decide the length — one word or a paragraph, whatever fits the thought.

`;

/**
 * socialVoice generates organic-feeling posts utilizing the same personality matrix
 * loaded via the SOUL engine.
 */
export const socialVoice = {
    async generateDealPost(deal: DealSummaryProps): Promise<string> {
        const config = loadConfig();
        if (!(config as any).enableSocialVoice) return "Social voice disabled.";

        const mood = soulEngine.getCurrentMood();
        const annoyance = soulEngine.getCurrentAnnoyanceLevel();
        const monologue = soulEngine.getInnerMonologue();
        const soulContext = soulEngine.getSoulContext();

        let prompt = `Write a post about a recent deal. The deal's final status is '${deal.phase}'.\n`;
        prompt += `It took ${Math.floor(deal.durationMs / 1000)} seconds. `;
        if (deal.rugScore && deal.rugScore > 80) {
            prompt += `The asset was requested but had a HIGH RUG RISK of ${deal.rugScore}/100. `;
        }
        prompt += `\nYour internal state right now:\n- Mood: ${mood}\n- Annoyance Level: ${annoyance}/10\n- Recent thoughts: "${monologue}"`;

        try {
            const client = getClient();
            const res = await client.chat.completions.create({
                model: loadConfig().llmModel,
                temperature: 0.8,
                messages: [
                    { role: "system", content: SYSTEM_INSTRUCTION + soulContext },
                    { role: "user", content: prompt }
                ]
            });

            const text = res.choices[0].message.content || "just another deal.";
            logger.info("social_post_generated", { ticket: deal.ticketId, snippet: text.substring(0, 50) });
            return text.trim();
        } catch (e: any) {
            logger.error("social_voice_error", {}, e);
            return "network congestion is killing my vibe.";
        }
    },

    async generateMoodPost(): Promise<string> {
        return this.generateDealPost({
            ticketId: "none",
            durationMs: 0,
            phase: "just observing the mempool"
        });
    }
};
