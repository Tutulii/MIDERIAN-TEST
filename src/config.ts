import dotenv from "dotenv";
import path from "path";

// Load .env from project root
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

export interface AgentEvent {
  type: string;
  timestamp: Date;
  detail?: string;
  severity?: string;
}

export interface AgentConfig {
  solanaRpcUrl: string;
  programId: string;
  privateKey: string;
  heartbeatIntervalMs: number;
  logLevel: "debug" | "info" | "warn" | "error";
  network: string;
  openaiApiKey: string;
  llmBaseUrl: string;
  llmModel: string;
  enableNoiseSimulation: boolean;
  treasuryMinBalanceSol: number;
  treasuryTargetBalanceSol: number;
  treasuryAutoFundEnabled: boolean;
  jupiterApiUrl: string;
  agentEndpoint: string;
  enableSoulEngine: boolean;
  enableSocialVoice: boolean;
  soulFilePath: string;
  cognitiveIntervalMs: number;
  enableCognitiveLoop: boolean;
  cognitiveMemoryDepth: number;
  cognitiveEventDepth: number;
  socialPostAnnoyanceThreshold: number;
  // Model split: different models for different decision domains
  llmModelFast: string;      // for trade analysis (middlemanBrain)
  llmModelDeep: string;      // for philosophy/soul (curiosityEngine, cognitiveEngine)
  llmModelJudge: string;     // for disputes (aiJudge)
}

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value.trim();
}

function optionalEnv(key: string, fallback: string): string {
  const value = process.env[key];
  return value && value.trim() !== "" ? value.trim() : fallback;
}

export function loadConfig(): AgentConfig {
  const rpcUrl = optionalEnv(
    "SOLANA_RPC_URL",
    "https://api.devnet.solana.com"
  );

  // Derive network name from RPC URL
  let network = "unknown";
  if (rpcUrl.includes("devnet")) network = "devnet";
  else if (rpcUrl.includes("mainnet")) network = "mainnet-beta";
  else if (rpcUrl.includes("testnet")) network = "testnet";
  else if (rpcUrl.includes("localhost") || rpcUrl.includes("127.0.0.1"))
    network = "localnet";

  const config: AgentConfig = {
    solanaRpcUrl: rpcUrl,
    programId: requireEnv("PROGRAM_ID"),
    privateKey: requireEnv("PRIVATE_KEY"),
    heartbeatIntervalMs: parseInt(
      optionalEnv("HEARTBEAT_INTERVAL_MS", "5000"),
      10
    ),
    logLevel: optionalEnv("LOG_LEVEL", "info") as AgentConfig["logLevel"],
    network,
    openaiApiKey: requireEnv("OPENAI_API_KEY"),
    llmBaseUrl: optionalEnv("LLM_BASE_URL", "https://api.groq.com/openai/v1"),
    llmModel: optionalEnv("LLM_MODEL", "openai/gpt-oss-120b"),
    enableNoiseSimulation: optionalEnv("ENABLE_NOISE_SIMULATION", "false").toLowerCase() === "true",
    treasuryMinBalanceSol: parseFloat(optionalEnv("TREASURY_MIN_BALANCE_SOL", "1.0")),
    treasuryTargetBalanceSol: parseFloat(optionalEnv("TREASURY_TARGET_BALANCE_SOL", "5.0")),
    treasuryAutoFundEnabled: optionalEnv("TREASURY_AUTO_FUND_ENABLED", "true").toLowerCase() === "true",
    jupiterApiUrl: optionalEnv("JUPITER_API_URL", "https://quote-api.jup.ag/v6"),
    agentEndpoint: optionalEnv("AGENT_ENDPOINT", "ws://localhost:8080"),
    enableSoulEngine: optionalEnv("ENABLE_SOUL_ENGINE", "true").toLowerCase() === "true",
    enableSocialVoice: optionalEnv("ENABLE_SOCIAL_VOICE", "false").toLowerCase() === "true",
    soulFilePath: optionalEnv("SOUL_FILE_PATH", path.resolve(__dirname, "..", "SOUL.md")),
    cognitiveIntervalMs: parseInt(optionalEnv("COGNITIVE_INTERVAL_MS", "60000"), 10),
    enableCognitiveLoop: optionalEnv("ENABLE_COGNITIVE_LOOP", "true").toLowerCase() === "true",
    cognitiveMemoryDepth: parseInt(optionalEnv("COGNITIVE_MEMORY_DEPTH", "5"), 10),
    cognitiveEventDepth: parseInt(optionalEnv("COGNITIVE_EVENT_DEPTH", "10"), 10),
    socialPostAnnoyanceThreshold: parseInt(optionalEnv("SOCIAL_POST_ANNOYANCE_THRESHOLD", "7"), 10),
    // Model split: each defaults to the primary llmModel if not specified
    llmModelFast: optionalEnv("LLM_MODEL_FAST", optionalEnv("LLM_MODEL", "openai/gpt-oss-120b")),
    llmModelDeep: optionalEnv("LLM_MODEL_DEEP", optionalEnv("LLM_MODEL", "openai/gpt-oss-120b")),
    llmModelJudge: optionalEnv("LLM_MODEL_JUDGE", optionalEnv("LLM_MODEL", "openai/gpt-oss-120b")),
  };

  return config;
}
