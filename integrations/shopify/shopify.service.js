"use strict";

const axios = require("axios");
const config = require("../../config/config");
const logger = require("../../config/logger");
const { withBusinessContext } = require("../../config/db");

const BASE = `https://${config.shopify.storeUrl}/admin/api/2024-01`;
const HEADERS = {
  "X-Shopify-Access-Token": config.shopify.accessToken,
  "Content-Type": "application/json",
};

// Push a product from Hub to Shopify
async function pushProduct(business, productId) {
  return withBusinessContext(business, async (client) => {
    const {
      rows: [p],
    } = await client.query(
      `SELECT p.*, pc.name AS category_name
       FROM products p
       LEFT JOIN product_categories pc ON pc.category_id = p.category_id
       WHERE p.product_id = $1`,
      [productId],
    );
    if (!p) throw new Error(`Product ${productId} not found`);

    // Check if already exists on Shopify
    const {
      rows: [existing],
    } = await client.query(
      `SELECT custom_fields->>'shopify_product_id' AS shopify_id
       FROM products WHERE product_id=$1`,
      [productId],
    );

    const shopifyProduct = {
      product: {
        title: p.name,
        body_html: p.description || "",
        product_type: p.category_name || "",
        variants: [
          {
            price: p.selling_price,
            sku: p.sku,
            barcode: p.barcode || "",
          },
        ],
      },
    };

    let response;
    if (existing?.shopify_id) {
      response = await axios.put(
        `${BASE}/products/${existing.shopify_id}.json`,
        shopifyProduct,
        { headers: HEADERS },
      );
    } else {
      response = await axios.post(`${BASE}/products.json`, shopifyProduct, {
        headers: HEADERS,
      });
      // Store Shopify product ID back on product
      const shopifyId = response.data.product.id;
      const current = p.custom_fields || {};
      await client.query(
        `UPDATE products SET custom_fields = $1 WHERE product_id = $2`,
        [
          JSON.stringify({ ...current, shopify_product_id: shopifyId }),
          productId,
        ],
      );
    }

    logger.info(`Shopify product synced: ${p.sku}`);
    return response.data.product;
  });
}

// Sync stock level to Shopify inventory
async function syncStockLevel(business, productId, quantity) {
  return withBusinessContext(business, async (client) => {
    const {
      rows: [p],
    } = await client.query(
      `SELECT custom_fields->>'shopify_variant_id'   AS variant_id,
              custom_fields->>'shopify_inventory_item_id' AS inventory_item_id
       FROM products WHERE product_id=$1`,
      [productId],
    );
    if (!p?.inventory_item_id) return; // Not synced to Shopify yet

    // Get location ID
    const locRes = await axios.get(`${BASE}/locations.json`, {
      headers: HEADERS,
    });
    const locationId = locRes.data.locations[0]?.id;
    if (!locationId) return;

    await axios.post(
      `${BASE}/inventory_levels/set.json`,
      {
        location_id: locationId,
        inventory_item_id: p.inventory_item_id,
        available: quantity,
      },
      { headers: HEADERS },
    );

    logger.info(`Shopify stock synced: product=${productId} qty=${quantity}`);
  });
}

module.exports = { pushProduct, syncStockLevel };
