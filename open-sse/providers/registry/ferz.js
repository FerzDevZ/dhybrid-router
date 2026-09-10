export default {
  id: "ferz",
  name: "Ferz AI Engine (Model Uji Coba)",
  alias: "ferz",
  uiAlias: "ferz",
  category: "custom",
  noAuth: true,
  authModes: ["none", "apikey"],
  passthroughModels: true,
  display: {
    name: "Ferz AI Engine",
    icon: "psychology",
    color: "#10b981",
    description: "Ferz AI Engine — Custom Model Uji Coba Ferz (DeepSeek V4, MiMo 2.5, GLM 5.2, MiniMax).",
  },
  transport: {
    baseUrl: process.env.FREEBUFF_PROXY_URL
      ? `${process.env.FREEBUFF_PROXY_URL}/chat/completions`
      : `http://127.0.0.1:${process.env.FREEBUFF_PROXY_PORT || "9187"}/v1/chat/completions`,
    forceStream: true,
  },
  models: [
    { id: "auto", name: "Ferz Smart Auto-Classifier" },
    { id: "deepseek/deepseek-v4-flash", name: "Ferz DeepSeek V4 Flash" },
    { id: "mimo/mimo-v2.5", name: "Ferz MiMo 2.5" },
    { id: "z-ai/glm-5.2", name: "Ferz GLM 5.2" },
    { id: "minimax/minimax-m2.7", name: "Ferz MiniMax M2.7" },
    { id: "openai/gpt-5.6-luna", name: "Ferz GPT 5.6" },
    { id: "anthropic/claude-fable-5", name: "Ferz Claude Fable" },
  ],
};
