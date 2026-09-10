import { handleChatWithInit, handleOptions } from "../_lib/handler.js";

/**
 * POST /v1/messages - Claude format (auto convert via handleChat)
 */
export async function OPTIONS() {
  return handleOptions();
}

export async function POST(request) {
  return handleChatWithInit(request);
}

