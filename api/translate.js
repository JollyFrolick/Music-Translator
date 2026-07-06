import { handleTranslate } from "../lib/api-handlers.js";

export default function handler(request, response) {
  return handleTranslate(request, response);
}
