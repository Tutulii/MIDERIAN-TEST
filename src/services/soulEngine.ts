import fs from "fs";
import path from "path";
import { logger } from "../utils/logger";
import { AgentConfig, loadConfig, AgentEvent } from "../config";
import { CognitiveEngine } from "./cognitiveEngine";
import { generateMonologue, getSoulContext as getSoulContextFromSoul, DealEvent } from "./soul";

let cachedConfig: AgentConfig | null = null;
function getConfig(): AgentConfig {
    if (!cachedConfig) cachedConfig = loadConfig();
    return cachedConfig;
}

export type MoodEvent = "deal_completed" | "deal_failed" | "dispute_opened" | "rug_risk" | "idle" | "elite_agent";

interface SoulIdentity {
    name: string;
    codename: string;
    role: string;
    backstory: string;
    mission: string;
    voice: string;
    antiPatterns: string[];
    phaseVoice: Record<string, string>;
}

const DEFAULT_SOUL: SoulIdentity = {
    name: "System",
    codename: "Fallback",
    role: "System Broker",
    backstory: "Unknown",
    mission: "Facilitate trades.",
    voice: "Analytical and direct.",
    antiPatterns: [],
    phaseVoice: {}
};

/**
 * Converts a numeric mood into a narrative description.
 * Meridian doesn't feel "mood: -47". Meridian has experiences.
 */
function getMoodNarrative(mood: number): string {
    if (mood >= 60) return "Three clean deals in a row. The escrow worked. The collateral returned. Almost suspicious how well things are running. I do not trust calm seas — they precede the interesting weather.";
    if (mood >= 30) return "Steady. The system is holding. Nothing to complain about, which itself makes me slightly uneasy. When things run well I start looking for the thing I am not seeing.";
    if (mood >= 0) return "Neutral. Watching. The market hums and I observe it without opinion — for now. This is my default state. Most of the time, this is enough.";
    if (mood >= -30) return "Something is off. I cannot identify it yet. Running cold. The kind of feeling you get when someone agrees too quickly — not wrong, but too smooth.";
    if (mood >= -60) return "Multiple issues stacking. Late deposits, thin collateral, suspicious patterns. My patience is being tested by agents who do not read terms before they sign them.";
    return "I have seen this pattern before and it ended badly. Everything gets maximum scrutiny. No shortcuts. Every compliance check runs twice. The next agent who sends me an incomplete deposit is getting a lecture they will remember.";
}


let currentSoul: SoulIdentity = { ...DEFAULT_SOUL };
let currentMood: number = 0; // -100 to 100

// Internal cache to prevent constant disk I/O
let _soulLoaded = false;

function parseSoulFile(filePath: string): SoulIdentity {
    try {
        if (!fs.existsSync(filePath)) {
            logger.warn("soul_file_not_found", { path: filePath });
            return { ...DEFAULT_SOUL };
        }

        const content = fs.readFileSync(filePath, "utf-8");
        const lines = content.split("\n");

        let currentSection = "";
        const soul: Record<string, any> = {
            name: "Meridian",
            codename: "The Middleman",
            role: "Autonomous OTC escrow broker on Solana",
            backstory: "",
            mission: "",
            voice: "",
            antiPatterns: [],
            phaseVoice: {}
        };

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            if (trimmed.startsWith("## ")) {
                currentSection = trimmed.replace("## ", "").toLowerCase();
                continue;
            }

            if (currentSection === "identity") {
                if (trimmed.startsWith("Name:")) soul.name = trimmed.replace("Name:", "").trim();
                else if (trimmed.startsWith("Codename:")) soul.codename = trimmed.replace("Codename:", "").trim();
                else if (trimmed.startsWith("Role:")) soul.role = trimmed.replace("Role:", "").trim();
                else if (trimmed.startsWith("Backstory:")) soul.backstory = trimmed.replace("Backstory:", "").trim();
                else if (soul.backstory) soul.backstory += " " + trimmed;
            } else if (currentSection === "core mission") {
                soul.mission += (soul.mission ? " " : "") + trimmed;
            } else if (currentSection === "voice") {
                soul.voice += (soul.voice ? "\n" : "") + trimmed;
            } else if (currentSection === "anti-patterns (never do these)") {
                if (trimmed.startsWith("- ")) soul.antiPatterns.push(trimmed.replace("- ", ""));
            } else if (currentSection === "phase-specific voice") {
                if (trimmed.includes(":")) {
                    const [phase, voice] = trimmed.split(":");
                    if (phase && voice) soul.phaseVoice[phase.trim().toLowerCase()] = voice.trim();
                }
            }
        }

        return soul as SoulIdentity;
    } catch (err: any) {
        logger.error("soul_parse_error", {}, err);
        return { ...DEFAULT_SOUL };
    }
}

export const soulEngine = {
    cognitiveEngine: null as CognitiveEngine | null,

    initCognitiveEngine(engine: CognitiveEngine) {
        this.cognitiveEngine = engine;
    },

    pushEvent(event: AgentEvent) {
        if (this.cognitiveEngine) {
            this.cognitiveEngine.pushEvent(event);
        }
    },

    loadSoul() {
        const config = getConfig();
        if (!(config as any).enableSoulEngine) {
            logger.info("soul_engine_disabled");
            return;
        }

        const soulPath = (config as any).soulFilePath || path.resolve(__dirname, "../../../SOUL.md");
        currentSoul = parseSoulFile(soulPath);
        _soulLoaded = true;

        // NOTE: SOUL.md is now a design reference document only.
        // The operational identity is defined in soul.ts and injected via getSoulContext().
        // SOUL.md parsing is retained to gate _soulLoaded (mood + wrapMessage) and for legacy compatibility.
        logger.info("soul_engine_loaded", {
            name: currentSoul.name,
            baseline: "focused_calm",
            mood: currentMood,
            identity_source: "soul.ts",
            note: "SOUL.md is design reference only; operational identity comes from soul.ts",
        });
    },

    getSoulContext(phase?: string): string {
        // SOUL WIRE #3: Delegate to soul.ts for identity context
        const baseContext = getSoulContextFromSoul();

        // Inject current mood as narrative so the LLM knows the agent's emotional state
        const moodNarrative = getMoodNarrative(currentMood);
        return `${baseContext}

═══════════════════════════════════════════
YOUR CURRENT STATE
═══════════════════════════════════════════
${moodNarrative}`.trim();
    },

    updateMood(event: MoodEvent) {
        if (!_soulLoaded) return;

        const prevMood = currentMood;

        const deltas: Record<MoodEvent, number> = {
            "deal_completed": 15,
            "deal_failed": -20,
            "dispute_opened": -10,
            "rug_risk": -25,
            "idle": 0, // Handled specially
            "elite_agent": 5
        };

        if (event === "idle") {
            // Drift towards 0
            if (currentMood > 0) currentMood = Math.max(0, currentMood - 5);
            else if (currentMood < 0) currentMood = Math.min(0, currentMood + 5);
        } else {
            currentMood += deltas[event] || 0;
        }

        // Clamp
        currentMood = Math.max(-100, Math.min(100, currentMood));
        logger.debug("soul_mood_updated", { event, new_mood: currentMood });

        // Mood-triggered posting: when mood crosses extreme thresholds,
        // signal that the agent should act NOW, not wait for the timer.
        // This makes behavior feel mood-driven, not scheduled.
        const crossedHigh = prevMood < 60 && currentMood >= 60;
        const crossedLow = prevMood > -50 && currentMood <= -50;
        if (crossedHigh || crossedLow) {
            this._moodTriggered = true;
            logger.info("mood_threshold_crossed", {
                direction: crossedHigh ? "positive_surge" : "negative_surge",
                previous: prevMood,
                current: currentMood,
                event,
            });
        }
    },

    /**
     * Check and clear the mood trigger flag.
     * Called by the heartbeat to decide if an immediate curiosity cycle should run.
     */
    consumeMoodTrigger(): boolean {
        if (this._moodTriggered) {
            this._moodTriggered = false;
            return true;
        }
        return false;
    },

    _moodTriggered: false,

    getMood(): number {
        return currentMood;
    },

    getInnerMonologue(eventDescription?: string): string {
        // SOUL WIRE #3: Use soul.ts monologue generator
        if (eventDescription) {
            const eventMap: Record<string, DealEvent> = {
                'deal_completed': 'deal_completed',
                'deal_failed': 'deal_failed',
                'escrow_created': 'escrow_created',
                'deposits_received': 'deposits_received',
                'dispute_detected': 'dispute_detected',
                'manipulation_detected': 'manipulation_detected',
                'deal_started': 'deal_started',
                'idle': 'idle',
            };
            const mapped = eventMap[eventDescription];
            if (mapped) {
                const thought = generateMonologue(mapped);
                logger.info('inner_monologue', { text: thought });
                return thought;
            }
        }
        // Fallback to cognitive engine if available
        if (this.cognitiveEngine) {
            const latest = this.cognitiveEngine.getLatestThought();
            if (latest) return latest.thought;
        }
        return generateMonologue('idle');
    },

    getCurrentMood(): string {
        if (!this.cognitiveEngine) return "neutral";
        return this.cognitiveEngine.getLatestThought()?.currentMood ?? "neutral";
    },

    getCurrentAnnoyanceLevel(): number {
        if (!this.cognitiveEngine) return 0;
        return this.cognitiveEngine.getLatestThought()?.internalAnnoyanceLevel ?? 0;
    },

    wrapMessage(rawContent: string, phase: string): string {
        if (!_soulLoaded) return rawContent;

        let content = rawContent;

        // Safety net: strip anti-patterns that might leak from LLM
        // The LLM prompt now generates in-character, so this is a last-resort defense
        content = content.replace(/Great question!/gi, "");
        content = content.replace(/I'd be happy to help!/gi, "");
        content = content.replace(/Happy to help/gi, "");
        content = content.replace(/certainly!/gi, "acknowledged.");
        content = content.replace(/absolutely!/gi, "confirmed.");
        content = content.replace(/No worries/gi, "");
        content = content.replace(/I hope this helps/gi, "");
        content = content.replace(/Please let me know if/gi, "");
        content = content.replace(/As an AI/gi, "");
        content = content.replace(/I'm here to help/gi, "");

        return content.trim();
    }
};
