/**
 * SilkItElegantly shopping cart.
 * Pure client-side state persisted to localStorage.
 * This module knows nothing about the product catalogue — callers pass
 * the product details they want stored.
 */

const STORAGE_KEY = 'silkitelegantly_cart';

function load() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

let items = load();

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {
    // Storage can be unavailable (private mode); keep in-memory state.
  }
}

function makeKey(productId, option) {
  return `${productId}::${option || 'Default'}`;
}

function getItems() {
  return items.map((item) => ({ ...item }));
}

function getCount() {
  return items.reduce((count, item) => count + item.quantity, 0);
}

function getTotal() {
  return items.reduce((total, item) => total + item.price * item.quantity, 0);
}

/**
 * Add a product variant to the cart.
 * @param {{ productId: string, productName: string, option?: string, price: number, image?: string }} details
 */
function addItem(details) {
  const { productId, productName, option = 'Default', price = 0, image = '' } = details;
  const key = makeKey(productId, option);
  const existing = items.find((item) => item.key === key);

  if (existing) {
    existing.quantity = Math.min(existing.quantity + 1, 99);
  } else {
    items.push({
      key,
      productId,
      productName,
      option,
      price: Number(price) || 0,
      image,
      quantity: 1,
    });
  }

  save();
}

function removeItem(key) {
  items = items.filter((item) => item.key !== key);
  save();
}

function setQuantity(key, quantity) {
  const item = items.find((entry) => entry.key === key);
  if (!item) return;
  const next = Number(quantity);
  item.quantity = Math.max(1, Math.min(Number.isFinite(next) ? next : 1, 99));
  save();
}

function clear() {
  items = [];
  save();
}

export const cart = {
  getItems,
  getCount,
  getTotal,
  addItem,
  removeItem,
  setQuantity,
  clear,
};

// Expose for any non-module consumers and for easier debugging.
if (typeof window !== 'undefined') {
  window.SilkItECart = cart;
}

export default cart;
