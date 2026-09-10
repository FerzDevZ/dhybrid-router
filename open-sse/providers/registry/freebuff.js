export default {
  id: "freebuff",
  name: "Freebuff / Codebuff",
  alias: "freebuff",
  uiAlias: "freebuff",
  category: "freeTier",
  noAuth: true,
  authModes: ["none", "apikey", "oauth"],
  passthroughModels: true,
  display: {
    name: "Freebuff / Codebuff",
    icon: "code",
    color: "#6366f1",
    description: "Akses model DeepSeek V4 Flash, MiMo 2.5, GLM 5.2, MiniMax, Claude 3.7, dan GPT-4o gratis via Embedded Engine.",
  },
  transport: {
    baseUrl: process.env.FREEBUFF_PROXY_URL
      ? `${process.env.FREEBUFF_PROXY_URL}/chat/completions`
      : `http://127.0.0.1:${process.env.FREEBUFF_PROXY_PORT || "9187"}/v1/chat/completions`,
    forceStream: true,
  },
  models: [
    { id: "auto", name: "Freebuff Auto-Classifier" },
    { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash" },
    { id: "mimo/mimo-v2.5", name: "MiMo 2.5 (Balanced & Images)" },
    { id: "z-ai/glm-5.2", name: "GLM 5.2" },
    { id: "minimax/minimax-m2.7", name: "MiniMax M2.7" },
    { id: "openai/gpt-5.6-luna", name: "GPT 5.6 Luna" },
    { id: "anthropic/claude-fable-5", name: "Claude Fable 5" },
    // Custom Ferz Branding Model Aliases
    { id: "ferz/auto", name: "Ferz Auto-Classifier" },
    { id: "ferz/deepseek/deepseek-v4-flash", name: "Ferz DeepSeek V4 Flash" },
    { id: "ferz/mimo-2.5", name: "Ferz MiMo 2.5" },
    { id: "ferz/z-ai/glm-5.2", name: "Ferz GLM 5.2" },
    { id: "ferz/minimax-abab7", name: "Ferz MiniMax Abab 7" },
  ],
};
