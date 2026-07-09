import { handleStripeWebhook } from "../lib/api-handlers.js";

export default function handler(request, response) {
  return handleStripeWebhook(request, response);
}
