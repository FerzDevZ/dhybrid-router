import { handleChatWithInit, handleOptions } from "../_lib/handler.js";

export async function OPTIONS() {
  return handleOptions();
}

export async function POST(request) {
  return handleChatWithInit(request);
}

