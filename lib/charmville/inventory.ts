/** Views of the same account-owned balances; never separate wallets or ledgers. */
export type InventoryStack = { face: string; qty: string };
export type YardInventory = { seeds: InventoryStack[]; faces: InventoryStack[]; grain: string };

export function inventoryCompartments(inventory: YardInventory) {
  return {
    gameplay: { seeds: inventory.seeds },
    satchel: { charms: inventory.faces },
    currency: { grain: inventory.grain },
  };
}
