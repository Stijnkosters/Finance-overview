type ShopifyCfg = { store?: string; token?: string; version?: string };

const DEFAULT_VERSION = process.env.SHOPIFY_API_VERSION || "2026-01";

export async function shopifyGraphQL(query: string, variables: any = {}, cfg?: ShopifyCfg, signal?: AbortSignal) {
  const store = cfg?.store ?? process.env.SHOPIFY_STORE_DOMAIN;
  const token = cfg?.token ?? process.env.SHOPIFY_ADMIN_TOKEN;
  const version = cfg?.version ?? DEFAULT_VERSION;
  if (!store || !token) {
    throw new Error("Ontbrekende Shopify-credentials (store-domein en/of admin-token) voor deze shop.");
  }
  const res = await fetch(`https://${store}/admin/api/${version}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ query, variables }),
    cache: "no-store",
    signal,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify API ${res.status}: ${text.slice(0, 300)}`);
  }
  const json = await res.json();
  if (json.errors) throw new Error(`Shopify GraphQL: ${JSON.stringify(json.errors).slice(0, 300)}`);
  return json.data;
}

const ORDERS_QUERY = `
query Orders($cursor: String, $q: String) {
  orders(first: 100, after: $cursor, query: $q, sortKey: CREATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      name
      createdAt
      customer { id displayName email }
      shippingAddress { countryCodeV2 }
      subtotalPriceSet { shopMoney { amount } }
      totalPriceSet { shopMoney { amount } }
      totalTaxSet { shopMoney { amount } }
      totalRefundedSet { shopMoney { amount } }
      refunds { id createdAt note totalRefundedSet { shopMoney { amount } } }
      lineItems(first: 50) {
        nodes {
          quantity
          title
          variant { id }
        }
      }
    }
  }
}`;

export async function fetchOrders(from: string, to: string, cfg?: ShopifyCfg, queryOverride?: string) {
  const q = queryOverride ?? `created_at:>='${from}T00:00:00Z' created_at:<='${to}T23:59:59Z'`;
  let cursor: string | null = null;
  const out: any[] = [];
  for (let i = 0; i < 50; i++) {
    const data = await shopifyGraphQL(ORDERS_QUERY, { cursor, q }, cfg);
    const conn = data.orders;
    out.push(...conn.nodes);
    if (!conn.pageInfo.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return out;
}
