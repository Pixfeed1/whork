// Abonnements Stripe (optionnel). Actif si STRIPE_SECRET_KEY et STRIPE_PRICE_ID sont définis.
// Sans Stripe, l'application fonctionne sans limite (usage interne d'une entreprise).
import { createHmac, timingSafeEqual } from "node:crypto";
import { one, run, usageTotal, usageThisMonth } from "./db";

export const billingEnabled = () => !!(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PRICE_ID);
export const TRIAL_STUDIES = Number(process.env.TRIAL_STUDIES ?? 5);
export const PRO_MONTHLY_STUDIES = Number(process.env.PRO_MONTHLY_STUDIES ?? 0); // 0 = illimité

export function quotaStatus(orgId: string) {
  const org = one<any>("SELECT plan, plan_status FROM organizations WHERE id = ?", orgId);
  if (!billingEnabled()) return { enforced: false, plan: org?.plan ?? "trial", allowed: true, used: 0, limit: 0 };
  // compte interne (administration, tests) : jamais limité
  if (org?.plan === "interne") return { enforced: false, plan: "interne", allowed: true, used: 0, limit: 0 };
  const isPro = org?.plan === "pro" && ["active", "trialing"].includes(org?.plan_status);
  if (isPro) {
    const used = usageThisMonth(orgId, "analysis");
    const limit = PRO_MONTHLY_STUDIES;
    return { enforced: true, plan: "pro", allowed: !limit || used < limit, used, limit, period: "mois" };
  }
  const used = usageTotal(orgId, "analysis");
  return { enforced: true, plan: "trial", allowed: used < TRIAL_STUDIES, used, limit: TRIAL_STUDIES, period: "essai" };
}

async function stripe(path: string, params: Record<string, string>) {
  const r = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(params),
  });
  const j = (await r.json()) as any;
  if (!r.ok) throw new Error(j?.error?.message ?? `Stripe HTTP ${r.status}`);
  return j;
}

export async function createCheckout(orgId: string, email: string, baseUrl: string): Promise<string> {
  const org = one<any>("SELECT * FROM organizations WHERE id = ?", orgId);
  let customer = org?.stripe_customer_id;
  if (!customer) {
    const c = await stripe("customers", { email, name: org?.name ?? "", "metadata[org_id]": orgId });
    customer = c.id;
    run("UPDATE organizations SET stripe_customer_id = ? WHERE id = ?", customer, orgId);
  }
  const s = await stripe("checkout/sessions", {
    mode: "subscription",
    customer,
    "line_items[0][price]": process.env.STRIPE_PRICE_ID!,
    "line_items[0][quantity]": "1",
    client_reference_id: orgId,
    success_url: `${baseUrl}/app/abonnement?ok=1`,
    cancel_url: `${baseUrl}/app/abonnement`,
    allow_promotion_codes: "true",
    "subscription_data[metadata][org_id]": orgId,
  });
  return s.url;
}

export async function createPortal(orgId: string, baseUrl: string): Promise<string> {
  const org = one<any>("SELECT stripe_customer_id FROM organizations WHERE id = ?", orgId);
  if (!org?.stripe_customer_id) throw new Error("Aucun abonnement");
  const s = await stripe("billing_portal/sessions", { customer: org.stripe_customer_id, return_url: `${baseUrl}/app/abonnement` });
  return s.url;
}

/** Vérifie la signature Stripe (en-tête Stripe-Signature). */
export function verifyWebhook(raw: Buffer, header: string | undefined): any | null {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !header) return null;
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=") as [string, string]));
  const t = parts.t;
  const sig = parts.v1;
  if (!t || !sig) return null;
  if (Math.abs(Date.now() / 1000 - Number(t)) > 600) return null;
  const expected = createHmac("sha256", secret).update(`${t}.${raw.toString("utf8")}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return JSON.parse(raw.toString("utf8"));
}

export function handleStripeEvent(evt: any) {
  const o = evt?.data?.object ?? {};
  switch (evt.type) {
    case "checkout.session.completed": {
      const orgId = o.client_reference_id;
      if (orgId)
        run(
          "UPDATE organizations SET plan = 'pro', plan_status = 'active', stripe_subscription_id = ?, stripe_customer_id = COALESCE(stripe_customer_id, ?) WHERE id = ?",
          o.subscription ?? null,
          o.customer ?? null,
          orgId,
        );
      break;
    }
    case "customer.subscription.updated":
    case "customer.subscription.created":
    case "customer.subscription.deleted": {
      const status = evt.type === "customer.subscription.deleted" ? "canceled" : o.status;
      const plan = ["active", "trialing", "past_due"].includes(status) ? "pro" : "trial";
      run(
        "UPDATE organizations SET plan = ?, plan_status = ?, stripe_subscription_id = ? WHERE stripe_customer_id = ?",
        plan,
        status,
        o.id,
        o.customer,
      );
      break;
    }
  }
}
