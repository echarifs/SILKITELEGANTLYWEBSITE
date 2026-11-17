/** Public order reference: SE- plus the first eight characters of the order's UUID. */
export function orderReferenceFromId(orderId) {
  return `SE-${String(orderId || '').replace(/-/gu, '').slice(0, 8).toUpperCase()}`;
}
