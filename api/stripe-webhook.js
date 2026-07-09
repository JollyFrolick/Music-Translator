import { processStripeWebhookPayload } from "../lib/api-handlers.js";

export default {
  async fetch(request) {
    if (request.method !== "POST") {
      return Response.json({ error: "Method not allowed." }, { status: 405 });
    }

    try {
      const payload = await request.text();
      const signature = request.headers.get("stripe-signature");
      const result = await processStripeWebhookPayload(payload, signature);
      return Response.json(result.body, { status: result.status });
    } catch (error) {
      console.error(error);
      return Response.json(
        { error: error.message || "Could not process Stripe webhook." },
        { status: error.status || 500 }
      );
    }
  }
};
