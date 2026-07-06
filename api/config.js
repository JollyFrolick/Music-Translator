import { handleConfig } from "../lib/api-handlers.js";

export default function handler(request, response) {
  return handleConfig(request, response);
}
